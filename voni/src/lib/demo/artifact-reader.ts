import { readFileSync } from "node:fs";
import {
  ARTIFACT_COST_LEGS,
  ARTIFACT_LATENCY_GAPS,
  ARTIFACT_PROVIDER_LEGS,
  ARTIFACT_SECTIONS,
  SCOREBOARD_SCHEMA_VERSION,
  isArtifactAbsence,
  parseGateRows,
  type ArtifactCapture,
  type ArtifactCaptureLeg,
  type ArtifactCaptures,
  type ArtifactCost,
  type ArtifactCostAmount,
  type ArtifactCostLeg,
  type ArtifactEligibility,
  type ArtifactLatency,
  type ArtifactLatencyGap,
  type ArtifactPipeline,
  type ArtifactProviders,
  type ArtifactRun,
  type ArtifactSection,
  type ScoreboardArtifact,
} from "./scoreboard";
import { CASCADE_ONLY_EVENT_TYPES, isCascadeOnlyEvent } from "./event-envelope";

export { ARTIFACT_SECTIONS, CASCADE_ONLY_EVENT_TYPES, isCascadeOnlyEvent };
export type { ArtifactSection };

/**
 * The shared artifact reader (meta-cascade M12): the managed artifact and the
 * cascade artifact differ by a `pipeline` discriminator and by which capture
 * legs exist, not by a second vocabulary. This is the one module the local
 * readers in `scripts/` migrate to; none of them parse a second schema.
 */
export const ARTIFACT_PIPELINES: readonly ArtifactPipeline[] = ["managed", "cascade"];

export function isArtifactPipeline(value: unknown): value is ArtifactPipeline {
  return typeof value === "string" && (ARTIFACT_PIPELINES as readonly string[]).includes(value);
}

/** Capture legs an artifact may name; an unknown leg is refused, never guessed. */
export const ARTIFACT_CAPTURE_LEGS: readonly ArtifactCaptureLeg[] = ["reference", "platform", "delivered"];

export function isArtifactCaptureLeg(value: unknown): value is ArtifactCaptureLeg {
  return typeof value === "string" && (ARTIFACT_CAPTURE_LEGS as readonly string[]).includes(value);
}

/**
 * Event types only a cascade run can emit live in `event-envelope.ts` — the
 * same vocabulary the event stream reader refuses. A managed artifact claiming
 * one is an invalid artifact: the managed path has no provider choice, breaker
 * or cascade budget to report.
 */

/** One refused artifact, named by the field and the value that failed. */
export class ArtifactReadError extends Error {
  /** The label or path the artifact was read from. */
  readonly source: string;
  /** The field that failed, e.g. `schemaVersion` or `captures.platform`. */
  readonly field: string;
  /** Why it failed, with the offending value spelled out. */
  readonly reason: string;

  constructor(source: string, field: string, reason: string) {
    super(`${source}: ${reason}`);
    this.name = "ArtifactReadError";
    this.source = source;
    this.field = field;
    this.reason = reason;
  }
}

function showValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

/** A named N/A is a non-empty reason; an empty one explains nothing. */
function assertNamedAbsence(
  absence: { absent: string },
  field: string,
  source: string,
): void {
  if (absence.absent.trim() === "") {
    throw new ArtifactReadError(
      source,
      field,
      `${field} is marked absent with an empty reason; a named N/A must say why`,
    );
  }
}

/**
 * Read one artifact, whoever wrote it. Pure: the caller owns the bytes.
 *
 * The returned artifact keeps what was recorded (an absent `pipeline` stays
 * absent — `pipelineOfArtifact` reads it as `managed`) and its gate rows come
 * from the one shared gate validator.
 */
export function parseScoreboardArtifact(raw: unknown, source: string): ScoreboardArtifact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(source, "artifact", `not a scoreboard artifact object (${showValue(raw)})`);
  }
  const record = raw as Record<string, unknown>;

  // Never guessed, never coerced: `"4"` is not 4 and 99 is not "close enough".
  if (record.schemaVersion !== SCOREBOARD_SCHEMA_VERSION) {
    throw new ArtifactReadError(
      source,
      "schemaVersion",
      `unknown schemaVersion ${showValue(record.schemaVersion)}; this reader reads ${SCOREBOARD_SCHEMA_VERSION}`,
    );
  }
  if (
    typeof record.voice !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.recordedAt !== "string" ||
    !Array.isArray(record.gates) ||
    !Array.isArray(record.subScores)
  ) {
    throw new ArtifactReadError(
      source,
      "artifact",
      "missing voice/runId/recordedAt/schemaVersion/gates/subScores",
    );
  }

  const pipeline = pipelineOfArtifact(record as Pick<ScoreboardArtifact, "pipeline">, source);
  const captures = parseCaptures(record.captures, source);
  if (pipeline === "cascade" && isPresentCapture(captures?.platform)) {
    throw new ArtifactReadError(
      source,
      "captures.platform",
      "cascade artifact claims a platform capture; the cascade carries {reference, delivered} only, so the platform leg must be N/A",
    );
  }
  assertCaptureLegs(captures, pipeline, source);

  // Present sections are validated whether or not the artifact claims the full
  // shape; completeness is checked once every substantive rule has had its say.
  parseRun(record.run, source, record.runId as string);
  parseProviders(record.providers, source);
  parseLatency(record.latency, pipeline, source);
  parseCost(record.cost, source);
  parseEligibility(record.eligibility, source);
  const ledger = parseLedger(record.ledger, source);
  if (pipeline === "cascade" && ledger !== undefined) {
    assertCascadeLatencyFromLedger(record.latency, ledger, source);
  }

  const eventTypes = parseArtifactEventTypes(record.events, source);
  if (pipeline === "managed") {
    const cascadeOnly = eventTypes.find(isCascadeOnlyEvent);
    if (cascadeOnly !== undefined) {
      throw new ArtifactReadError(
        source,
        "events",
        `managed artifact carries the cascade-only event "${cascadeOnly}"; a fallback-contaminated run is not a managed run`,
      );
    }
  }

  // A declared pipeline claims the one shared shape (ticket 112); an artifact
  // with no discriminator predates the cascade and is read expand-only so old
  // evidence still parses.
  if (record.pipeline !== undefined) {
    const gaps = artifactSectionGaps(record as Partial<Record<ArtifactSection, unknown>>);
    if (gaps.length > 0) {
      throw new ArtifactReadError(
        source,
        gaps[0],
        `${pipeline} artifact is missing ${gaps.join(", ")} of the one shared shape (${ARTIFACT_SECTIONS.join(", ")})`,
      );
    }
  }

  return {
    ...(record as unknown as ScoreboardArtifact),
    gates: parseGateRows(record.gates, source),
  };
}

/**
 * Which sections of the one shared shape this artifact is missing (ticket 112).
 * Order is `ARTIFACT_SECTIONS`, so the first gap is the one a refusal names.
 *
 * An artifact that carries no `pipeline` predates the cascade and is read
 * expand-only (the writer never emitted these sections); an artifact that
 * declares its pipeline is claiming the shared shape and must carry all ten.
 */
export function artifactSectionGaps(
  artifact: Partial<Record<ArtifactSection, unknown>>,
): ArtifactSection[] {
  return ARTIFACT_SECTIONS.filter(
    (section) => artifact[section] === undefined || artifact[section] === null,
  );
}

/**
 * The effective discriminator. An artifact written before the cascade has no
 * field and is a managed artifact (`subjectOrLegacy`'s precedent); a field that
 * is present but not a known pipeline is refused, not defaulted.
 */
export function pipelineOfArtifact(
  artifact: Pick<ScoreboardArtifact, "pipeline">,
  source = "artifact",
): ArtifactPipeline {
  if (artifact.pipeline === undefined) return "managed";
  if (!isArtifactPipeline(artifact.pipeline)) {
    throw new ArtifactReadError(
      source,
      "pipeline",
      `unknown pipeline ${showValue(artifact.pipeline)}; expected one of ${ARTIFACT_PIPELINES.join(", ")}`,
    );
  }
  return artifact.pipeline;
}

/**
 * Validate the readable capture record. A claimed leg names a file and its
 * hash, never audio bytes; a leg the pipeline cannot produce is a named
 * absence (`{absent}`) or, on a legacy artifact, a bare `null`.
 */
function parseCaptures(raw: unknown, source: string): ArtifactCaptures | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(source, "captures", `captures is not an object (${showValue(raw)})`);
  }
  const record = raw as Record<string, unknown>;
  for (const [leg, capture] of Object.entries(record)) {
    if (!isArtifactCaptureLeg(leg)) {
      throw new ArtifactReadError(
        source,
        `captures.${leg}`,
        `unknown capture leg "${leg}"; expected one of ${ARTIFACT_CAPTURE_LEGS.join(", ")}`,
      );
    }
    if (capture === null) continue;
    if (isArtifactAbsence(capture)) {
      assertNamedAbsence(capture, `captures.${leg}`, source);
      continue;
    }
    const entry = capture as Record<string, unknown>;
    if (
      typeof capture !== "object" ||
      Array.isArray(capture) ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new ArtifactReadError(
        source,
        `captures.${leg}`,
        `capture leg "${leg}" needs path/sha256 (never audio bytes) or a named absence`,
      );
    }
  }
  return record as ArtifactCaptures;
}

/** A capture that names a file, as opposed to a named N/A or a legacy null. */
function isPresentCapture(capture: ArtifactCapture | undefined): boolean {
  return capture !== null && capture !== undefined && !isArtifactAbsence(capture);
}

/**
 * The legs each pipeline must account for (ticket 112): the cascade carries
 * `{reference, delivered}` and names the platform leg absent; the managed path
 * carries all three. A leg that is simply missing is refused by name.
 */
function assertCaptureLegs(
  captures: ArtifactCaptures | undefined,
  pipeline: ArtifactPipeline,
  source: string,
): void {
  if (captures === undefined) return; // completeness names the whole section
  if (pipeline === "cascade") {
    for (const leg of ["reference", "delivered"] as const) {
      if (!isPresentCapture(captures[leg])) {
        throw new ArtifactReadError(
          source,
          `captures.${leg}`,
          `cascade artifact carries no ${leg} capture; the cascade records {reference, delivered}`,
        );
      }
    }
    const platform = captures.platform;
    if (platform === null || platform === undefined) {
      throw new ArtifactReadError(
        source,
        "captures.platform",
        "cascade artifact leaves the platform leg unexplained; it must be marked absent with a named reason (N/A — no platform capture on the cascade)",
      );
    }
    return;
  }
  for (const leg of ARTIFACT_CAPTURE_LEGS) {
    if (!isPresentCapture(captures[leg])) {
      throw new ArtifactReadError(
        source,
        `captures.${leg}`,
        `managed artifact carries no ${leg} capture; the managed path records all three legs`,
      );
    }
  }
}

/** Validate the readable event list and return its types for the pipeline check. */
function parseArtifactEventTypes(raw: unknown, source: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ArtifactReadError(source, "events", `events is not an array (${showValue(raw)})`);
  }
  return raw.map((event, index) => {
    if (
      event === null ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      typeof (event as Record<string, unknown>).type !== "string"
    ) {
      throw new ArtifactReadError(source, `events.${index}`, `event ${index} needs a string type`);
    }
    return (event as Record<string, unknown>).type as string;
  });
}

/**
 * The run block (M12). The artifact and its run block name the same run, so a
 * copied or stitched artifact is visible instead of plausible.
 */
function parseRun(raw: unknown, source: string, artifactRunId: string): ArtifactRun | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(source, "run", `run is not an object (${showValue(raw)})`);
  }
  const record = raw as Record<string, unknown>;
  for (const field of ["runId", "variant", "startedAt", "finishedAt"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).trim() === "") {
      throw new ArtifactReadError(source, `run.${field}`, `run.${field} is missing or empty`);
    }
  }
  if (record.runId !== artifactRunId) {
    throw new ArtifactReadError(
      source,
      "run.runId",
      `run.runId ${showValue(record.runId)} does not name this artifact's run ${showValue(artifactRunId)}`,
    );
  }
  for (const field of ["startedAt", "finishedAt"] as const) {
    if (Number.isNaN(Date.parse(record[field] as string))) {
      throw new ArtifactReadError(
        source,
        `run.${field}`,
        `run.${field} ${showValue(record[field])} is not a timestamp`,
      );
    }
  }
  return record as ArtifactRun;
}

/**
 * The provider table (M12): every leg names the provider it used, or the named
 * N/A a managed leg records. No leg is silently absent and no leg is invented.
 */
function parseProviders(raw: unknown, source: string): ArtifactProviders | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(source, "providers", `providers is not an object (${showValue(raw)})`);
  }
  const record = raw as Record<string, unknown>;
  for (const [leg, provider] of Object.entries(record)) {
    if (!(ARTIFACT_PROVIDER_LEGS as readonly string[]).includes(leg)) {
      throw new ArtifactReadError(
        source,
        `providers.${leg}`,
        `unknown provider leg "${leg}"; expected one of ${ARTIFACT_PROVIDER_LEGS.join(", ")}`,
      );
    }
    if (typeof provider === "string" && provider.trim() !== "") continue;
    if (isArtifactAbsence(provider)) {
      assertNamedAbsence(provider, `providers.${leg}`, source);
      continue;
    }
    throw new ArtifactReadError(
      source,
      `providers.${leg}`,
      `provider leg "${leg}" needs a provider name or a named N/A`,
    );
  }
  for (const leg of ARTIFACT_PROVIDER_LEGS) {
    if (record[leg] === undefined) {
      throw new ArtifactReadError(
        source,
        `providers.${leg}`,
        `provider leg "${leg}" is missing; every turn names the stt/llm/tts it used, or the named N/A`,
      );
    }
  }
  return record as ArtifactProviders;
}

/** Gaps each engine cannot produce: recorded as a named N/A, never zero (M13). */
const UNAVAILABLE_GAPS: Record<ArtifactPipeline, readonly ArtifactLatencyGap[]> = {
  cascade: ["commitToFirstPlayoutMs"],
  managed: ["screenToFirstPartialMs", "speechCompleteToFirstTokenMs"],
};

/**
 * The three cascade gaps and the ledger marks each one is anchored on (M13).
 * `speech_complete` is the provider-owned turn boundary; `final` is the managed
 * anchor and never substitutes for it, and no row is ever borrowed from another.
 */
export const CASCADE_GAP_ROWS = [
  { row: "screenToFirstPartialMs", start: "audio_in", end: "first_partial" },
  { row: "speechCompleteToFirstTokenMs", start: "speech_complete", end: "first_token" },
  { row: "replyGapP50Ms", start: "speech_complete", end: "first_playout" },
] as const satisfies readonly { row: ArtifactLatencyGap; start: string; end: string }[];

/** A ledger mark value in seconds, or null when the mark was not recorded. */
function ledgerMark(marks: Readonly<Record<string, number>>, name: string): number | null {
  const value = marks[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The three cascade gaps, computed from the ledger marks alone (ticket 114).
 *
 * `marks` is `TimingLedger.summary()["marks"]` — the ledger's own clock in
 * seconds — so a reader holding only the end-of-call summary derives every row
 * without the ledger object. A missing anchor is a named N/A, never zero and
 * never another mark: the greeting's marks are not read, and a cut cannot move
 * a row because the marks are write-once.
 */
export function cascadeLatencyFromMarks(marks: Readonly<Record<string, number>>): ArtifactLatency {
  const latency: ArtifactLatency = {};
  for (const { row, start, end } of CASCADE_GAP_ROWS) {
    const from = ledgerMark(marks, start);
    const to = ledgerMark(marks, end);
    if (from !== null && to !== null) {
      latency[row] = Math.round((to - from) * 1000);
      continue;
    }
    const missing = [start, end].filter((mark) => ledgerMark(marks, mark) === null);
    const named = missing.map((mark) => `"${mark}"`).join(" or ");
    latency[row] =
      row === "replyGapP50Ms"
        ? { absent: `N/A — the cascade ledger has no ${named} mark; the reply gap is never "final"` }
        : { absent: `N/A — the cascade ledger has no ${named} mark` };
  }
  return latency;
}

/**
 * A cascade artifact's latency rows must be the rows its own ledger marks
 * derive. A number where the mark is absent (a copied reply gap, a fallback to
 * `final`) is refused by field, so the artifact cannot claim a gap it did not
 * measure.
 */
function assertCascadeLatencyFromLedger(
  rawLatency: unknown,
  ledger: { marks: Readonly<Record<string, number>> },
  source: string,
): void {
  if (rawLatency === undefined || rawLatency === null || typeof rawLatency !== "object" || Array.isArray(rawLatency)) {
    return; // completeness/parseLatency names a malformed or missing section
  }
  const latency = rawLatency as Record<string, unknown>;
  const derived = cascadeLatencyFromMarks(ledger.marks);
  for (const { row, start, end } of CASCADE_GAP_ROWS) {
    const expected = derived[row];
    const written = latency[row];
    if (typeof expected === "number") {
      if (typeof written !== "number" || Math.abs(written - expected) > 1e-6) {
        throw new ArtifactReadError(
          source,
          `latency.${row}`,
          `records ${showValue(written)} but the ledger marks derive ${expected}ms (${start} → ${end}); the row is computed from marks, never copied from another row`,
        );
      }
      continue;
    }
    if (typeof written === "number") {
      const missing = [start, end].filter((mark) => ledgerMark(ledger.marks, mark) === null);
      const named = missing.map((mark) => `"${mark}"`).join(" or ");
      throw new ArtifactReadError(
        source,
        `latency.${row}`,
        `records ${written}ms but the ledger has no ${named} mark; the row is a named N/A, never borrowed from another mark (a "final" mark is not the cascade anchor)`,
      );
    }
  }
}

/** The ledger summary a cascade artifact may carry, with finite mark values. */
function parseLedger(raw: unknown, source: string): { marks: Record<string, number>; counts?: Record<string, number> } | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(source, "ledger", `ledger is not an object (${showValue(raw)})`);
  }
  const record = raw as Record<string, unknown>;
  const table = (value: unknown, field: string): Record<string, number> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ArtifactReadError(source, field, `${field} is not an object of finite numbers`);
    }
    const numbers: Record<string, number> = {};
    for (const [name, entry] of Object.entries(value)) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) {
        throw new ArtifactReadError(
          source,
          `${field}.${name}`,
          `${field}.${name} is not a finite number (${showValue(entry)})`,
        );
      }
      numbers[name] = entry;
    }
    return numbers;
  };
  const marks = table(record.marks, "ledger.marks");
  const counts = record.counts === undefined ? undefined : table(record.counts, "ledger.counts");
  return { marks, ...(counts !== undefined ? { counts } : {}) };
}

/**
 * The latency rows (M13): a finite non-negative number, or the named N/A for a
 * gap the engine has no mark for. An engine's unavailable gap must say so, so
 * it is never silently absent and never a copy of another row.
 */
function parseLatency(
  raw: unknown,
  pipeline: ArtifactPipeline,
  source: string,
): ArtifactLatency | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(source, "latency", `latency is not an object (${showValue(raw)})`);
  }
  const record = raw as Record<string, unknown>;
  for (const [gap, value] of Object.entries(record)) {
    if (!(ARTIFACT_LATENCY_GAPS as readonly string[]).includes(gap)) {
      throw new ArtifactReadError(
        source,
        `latency.${gap}`,
        `unknown latency gap "${gap}"; expected one of ${ARTIFACT_LATENCY_GAPS.join(", ")}`,
      );
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) {
        throw new ArtifactReadError(
          source,
          `latency.${gap}`,
          `latency gap "${gap}" must be finite and non-negative, got ${showValue(value)}`,
        );
      }
      continue;
    }
    if (isArtifactAbsence(value)) {
      assertNamedAbsence(value, `latency.${gap}`, source);
      continue;
    }
    throw new ArtifactReadError(
      source,
      `latency.${gap}`,
      `latency gap "${gap}" needs a number or a named N/A`,
    );
  }
  for (const gap of UNAVAILABLE_GAPS[pipeline]) {
    const value = record[gap];
    if (value === undefined) {
      throw new ArtifactReadError(
        source,
        `latency.${gap}`,
        `${pipeline} run leaves "${gap}" silently absent; it must record the named N/A (the gap does not exist on this engine)`,
      );
    }
    if (typeof value === "number") {
      throw new ArtifactReadError(
        source,
        `latency.${gap}`,
        `${pipeline} run records "${gap}" as ${showValue(value)}; the gap does not exist on this engine and must be N/A`,
      );
    }
  }
  return record as ArtifactLatency;
}

/**
 * The cost record (M3/M12). One unmeasured unit makes the total `unmeasured`;
 * a partial sum presented as complete is refused, naming the leg. An absent leg
 * is refused rather than read as zero.
 */
function parseCost(raw: unknown, source: string): ArtifactCost | undefined {
  if (raw === undefined) return undefined;
  if (isArtifactAbsence(raw)) {
    assertNamedAbsence(raw, "cost", source);
    return raw;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(source, "cost", `cost is not an object (${showValue(raw)})`);
  }
  const record = raw as Record<string, unknown>;
  for (const field of ["currency", "rateTableVersion"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).trim() === "") {
      throw new ArtifactReadError(source, `cost.${field}`, `cost.${field} is missing or empty`);
    }
  }
  if (record.legs === null || typeof record.legs !== "object" || Array.isArray(record.legs)) {
    throw new ArtifactReadError(source, "cost.legs", `cost.legs is not an object (${showValue(record.legs)})`);
  }
  const legs = record.legs as Record<string, unknown>;
  for (const [leg, amount] of Object.entries(legs)) {
    if (!(ARTIFACT_COST_LEGS as readonly string[]).includes(leg)) {
      throw new ArtifactReadError(
        source,
        `cost.legs.${leg}`,
        `unknown cost leg "${leg}"; expected one of ${ARTIFACT_COST_LEGS.join(", ")}`,
      );
    }
    if (amount === "unmeasured") continue;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new ArtifactReadError(
        source,
        `cost.legs.${leg}`,
        `cost leg "${leg}" must be a finite, non-negative amount or "unmeasured", got ${showValue(amount)}`,
      );
    }
  }
  for (const leg of ARTIFACT_COST_LEGS) {
    if (legs[leg] === undefined) {
      throw new ArtifactReadError(
        source,
        "cost.legs",
        `cost leg "${leg}" is missing; an unreported unit is "unmeasured", never zero`,
      );
    }
  }
  const derived = artifactCostTotal(legs as Partial<Record<ArtifactCostLeg, ArtifactCostAmount>>);
  const total = record.total;
  if (derived === "unmeasured") {
    if (total !== "unmeasured") {
      const unmeasured = ARTIFACT_COST_LEGS.filter((leg) => legs[leg] === "unmeasured");
      throw new ArtifactReadError(
        source,
        "cost.total",
        `cost total is ${showValue(total)} but leg(s) ${unmeasured.join(", ")} are unmeasured; an unmeasured unit makes the total unmeasured`,
      );
    }
    return record as ArtifactCost;
  }
  if (typeof total !== "number" || Math.abs(total - derived) > 1e-9) {
    throw new ArtifactReadError(
      source,
      "cost.total",
      `cost total is ${showValue(total)} but its legs sum to ${derived}; the total is derived, never re-invented`,
    );
  }
  return record as ArtifactCost;
}

/**
 * The sum of a run's measured legs, or `unmeasured` when any leg is. The one
 * derivation, so no caller presents a partial sum as a total.
 */
export function artifactCostTotal(
  legs: Partial<Record<ArtifactCostLeg, ArtifactCostAmount>>,
): ArtifactCostAmount {
  const amounts = Object.values(legs);
  if (amounts.length === 0 || amounts.some((amount) => amount === "unmeasured")) return "unmeasured";
  return amounts.reduce((sum: number, amount) => sum + (amount as number), 0);
}

/**
 * The run's eligibility verdict (M13): an ineligible run names at least one
 * reason and an eligible one carries none, so neither state is a silent flag.
 */
function parseEligibility(raw: unknown, source: string): ArtifactEligibility | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(
      source,
      "eligibility",
      `eligibility is not an object (${showValue(raw)})`,
    );
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.eligible !== "boolean") {
    throw new ArtifactReadError(
      source,
      "eligibility.eligible",
      `eligibility.eligible must be a boolean, got ${showValue(record.eligible)}`,
    );
  }
  const reasons = record.reasons;
  if (reasons !== undefined) {
    if (!Array.isArray(reasons) || reasons.some((reason) => typeof reason !== "string" || reason.trim() === "")) {
      throw new ArtifactReadError(
        source,
        "eligibility.reasons",
        "every eligibility reason must be a non-empty string",
      );
    }
    if (record.eligible === true && reasons.length > 0) {
      throw new ArtifactReadError(
        source,
        "eligibility.reasons",
        "an eligible run carries no refusal reason",
      );
    }
  }
  if (record.eligible === false && (!Array.isArray(reasons) || reasons.length === 0)) {
    throw new ArtifactReadError(
      source,
      "eligibility.reasons",
      "an ineligible run is BLOCKED with a named reason, not a silent false",
    );
  }
  return record as ArtifactEligibility;
}

/** Read and parse an artifact file; a bad file is named by its path. */export function readScoreboardArtifactFile(path: string): ScoreboardArtifact {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ArtifactReadError(path, "file", `cannot read artifact (${(error as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ArtifactReadError(path, "file", `is not JSON (${(error as Error).message})`);
  }
  return parseScoreboardArtifact(raw, path);
}
