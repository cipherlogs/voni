/**
 * The certification journal: one JSONL file per run, written as the run makes
 * its calls, so a run that dies at call 240 of 273 can continue at call 241
 * instead of paying for the first 239 again.
 *
 * The header proves which run this is: its id, start time, target, code
 * fingerprint, corpus hash, vendor builds and the scenario × repetition plan.
 * One entry follows per call — the attempt, its evidence references, its
 * eligibility, its own cost row — plus a `retry` entry when a call produced no
 * evidence and was re-made once.
 *
 * The reader refuses everything it cannot prove. A missing journal, an unknown
 * schema, a different code/corpus/build/plan/target, a line torn before the
 * tail, or a completed call whose evidence file is gone is a named exit 2. A
 * half-written final line is truncated, never guessed at, and a completed
 * call before it is kept.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Evidence artifacts" and
 * "Targets, runs and cadence"; ADR 0013.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { CodeFingerprint } from "@/lib/demo/scoreboard";
import {
  CERTIFICATE_TARGETS,
  VENDOR_LEGS,
  type CertificateTarget,
  type VendorBuild,
} from "@/lib/demo/verification/certificate";
import { LOCALES, type CorpusReference, type Locale } from "@/lib/demo/verification/scenarios";
import type { CallEligibilityFact, ScenarioAttempt } from "@/lib/demo/verification/verdict";

import { refuse } from "./errors";
import type { PlannedScenario, VerifyPlan } from "./plan";

/** The journal schema this reader understands. */
export const JOURNAL_SCHEMA_VERSION = 1 as const;

/** The file every run directory holds. */
export const JOURNAL_FILE = "journal.jsonl";

/** A run id becomes a directory and a file; a path is never one. */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const JOURNAL_MODES = ["full", "nightly"] as const;

export type JournalMode = (typeof JOURNAL_MODES)[number];

/** The plan grid the header pins; a resume may not change it. */
export type JournalPlan = {
  readonly mode: JournalMode;
  readonly repetitions: number;
  /** Calls the plan owes, including any the corpus cannot supply. */
  readonly calls: number;
  readonly scenarios: readonly PlannedScenario[];
};

export type JournalHeader = {
  readonly type: "header";
  readonly schemaVersion: number;
  readonly runId: string;
  readonly startedAt: string;
  readonly target: CertificateTarget;
  readonly mode: JournalMode;
  readonly codeFingerprint: CodeFingerprint;
  readonly corpus: CorpusReference;
  readonly vendorBuilds: readonly VendorBuild[];
  readonly plan: JournalPlan;
};

/** A call that produced no evidence and was re-made once. */
export type JournalRetryRecord = {
  readonly type: "retry";
  readonly scenario: string;
  readonly repetition: number;
  readonly code: string;
  readonly message: string;
  readonly at: string;
};

/**
 * One call's contribution. `completed` carries the attempt the verdict core
 * judges, the eligibility facts, the call's own cost row and the paths of the
 * artifacts that support it. `failed` carries the refusal that ended the call;
 * a failed call is never re-made on resume.
 */
export type JournalCallRecord = {
  readonly type: "call";
  readonly scenario: string;
  readonly repetition: number;
  readonly locale: Locale;
  readonly callId: string;
  readonly outcome: "completed" | "failed";
  readonly attempt: ScenarioAttempt | null;
  readonly eligibility: CallEligibilityFact | null;
  /** The `cost.priced` row, verbatim; null means unmeasured, never zero. */
  readonly cost: unknown;
  readonly pipelineImage: string | null;
  readonly evidenceRefs: readonly string[];
  readonly refusal: { readonly code: string; readonly message: string } | null;
  readonly at: string;
};

export type JournalEntry = JournalHeader | JournalCallRecord | JournalRetryRecord;

export type LoadedJournal = {
  readonly path: string;
  readonly header: JournalHeader;
  /** Completed and failed calls by `${scenario}#${repetition}`. */
  readonly calls: ReadonlyMap<string, JournalCallRecord>;
  readonly retries: ReadonlyMap<string, JournalRetryRecord>;
  /** A re-made call whose final record never landed: it stays failed. */
  readonly interrupted: ReadonlySet<string>;
  /** True when a half-written tail was truncated on read. */
  readonly tailDropped: boolean;
};

export type JournalWriter = {
  append(entry: JournalCallRecord | JournalRetryRecord): void;
  close(): void;
};

export function callKey(scenario: string, repetition: number): string {
  return `${scenario}#${repetition}`;
}

/** Where a run's journal lives; the run id is refused unless it is a safe component. */
export function journalPath(runRoot: string | undefined, runId: string): string {
  if (!SAFE_RUN_ID.test(runId) || runId.includes("..")) {
    refuse(
      "journal-run-id-invalid",
      `run id "${runId}" is not a safe run id; use letters, digits, dot, dash or underscore`,
    );
  }
  return join(runRoot ?? ".demo-runs", runId, JOURNAL_FILE);
}

/** Create a new run's journal with its header line, durably. */
export function writeJournal(path: string, header: JournalHeader): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", "utf8");
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(header)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Open an existing journal for appends; each entry is written and synced whole. */
export function openJournal(path: string): JournalWriter {
  const fd = openSync(path, "a");
  let closed = false;
  return {
    append(entry) {
      if (closed) throw new Error("the journal is closed");
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(path: string, line: number | null, message: string): never {
  const where = line === null ? path : `${path} line ${line}`;
  refuse("journal-malformed", `${where}: ${message}`);
}

function text(
  value: unknown,
  field: string,
  path: string,
  line: number | null,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    malformed(path, line, `${field} is not a non-empty string`);
  }
  return value;
}

function integer(
  value: unknown,
  field: string,
  path: string,
  line: number | null,
  minimum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    malformed(path, line, `${field} is not an integer >= ${minimum}`);
  }
  return value;
}

function boolean(value: unknown, field: string, path: string, line: number | null): boolean {
  if (typeof value !== "boolean") malformed(path, line, `${field} is not a boolean`);
  return value;
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  path: string,
  line: number | null,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    malformed(path, line, `${field} is "${String(value)}", not one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function strings(
  value: unknown,
  field: string,
  path: string,
  line: number | null,
): string[] {
  if (!Array.isArray(value)) malformed(path, line, `${field} is not an array`);
  return value.map((entry, index) => text(entry, `${field}[${index}]`, path, line));
}

function parseHeader(raw: unknown, path: string, line: number): JournalHeader {
  const record = isRecord(raw) ? raw : malformed(path, line, "the entry is not an object");
  if (record.type !== "header") malformed(path, line, 'the first entry is not a "header"');
  if (typeof record.schemaVersion !== "number" || !Number.isInteger(record.schemaVersion)) {
    malformed(path, line, "schemaVersion is not an integer");
  }
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    refuse(
      "journal-schema-unknown",
      `journal ${path} carries schema version ${schemaVersion}; this reader understands ` +
        `${JOURNAL_SCHEMA_VERSION}. Refusing rather than guessing what its calls mean`,
    );
  }
  const startedAt = text(record.startedAt, "startedAt", path, line);
  if (Number.isNaN(Date.parse(startedAt))) {
    malformed(path, line, `startedAt "${startedAt}" is not a date`);
  }
  const fingerprint = isRecord(record.codeFingerprint)
    ? record.codeFingerprint
    : malformed(path, line, "codeFingerprint is not an object");
  const corpus = isRecord(record.corpus)
    ? record.corpus
    : malformed(path, line, "corpus is not an object");
  const sha256 = text(corpus.sha256, "corpus.sha256", path, line);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    malformed(path, line, "corpus.sha256 is not 64 lowercase hex characters");
  }
  if (!Array.isArray(record.vendorBuilds)) {
    malformed(path, line, "vendorBuilds is not an array");
  }
  const vendorBuilds: VendorBuild[] = record.vendorBuilds.map((entry, index) => {
    const build = isRecord(entry)
      ? entry
      : malformed(path, line, `vendorBuilds[${index}] is not an object`);
    return {
      leg: oneOf(build.leg, VENDOR_LEGS, `vendorBuilds[${index}].leg`, path, line),
      vendor: text(build.vendor, `vendorBuilds[${index}].vendor`, path, line),
      model: text(build.model, `vendorBuilds[${index}].model`, path, line),
      buildId: text(build.buildId, `vendorBuilds[${index}].buildId`, path, line),
    };
  });

  const planRaw = isRecord(record.plan)
    ? record.plan
    : malformed(path, line, "plan is not an object");
  const repetitions = integer(planRaw.repetitions, "plan.repetitions", path, line, 1);
  const calls = integer(planRaw.calls, "plan.calls", path, line, 1);
  if (!Array.isArray(planRaw.scenarios) || planRaw.scenarios.length === 0) {
    malformed(path, line, "plan.scenarios is not a non-empty array");
  }
  const seen = new Set<string>();
  const scenarios: PlannedScenario[] = planRaw.scenarios.map((entry, index) => {
    const scenario = isRecord(entry)
      ? entry
      : malformed(path, line, `plan.scenarios[${index}] is not an object`);
    const name = text(scenario.name, `plan.scenarios[${index}].name`, path, line);
    if (seen.has(name)) {
      malformed(path, line, `plan.scenarios records "${name}" twice`);
    }
    seen.add(name);
    return {
      name,
      locale: oneOf(scenario.locale, LOCALES, `plan.scenarios[${index}].locale`, path, line),
      heldOut: boolean(scenario.heldOut, `plan.scenarios[${index}].heldOut`, path, line),
    };
  });
  if (calls !== scenarios.length * repetitions) {
    malformed(
      path,
      line,
      `plan.calls is ${calls}, but ${scenarios.length} scenarios at ${repetitions} ` +
        `repetition(s) is ${scenarios.length * repetitions}`,
    );
  }

  return {
    type: "header",
    schemaVersion,
    runId: text(record.runId, "runId", path, line),
    startedAt,
    target: oneOf(record.target, CERTIFICATE_TARGETS, "target", path, line),
    mode: oneOf(record.mode, JOURNAL_MODES, "mode", path, line),
    codeFingerprint: {
      head: text(fingerprint.head, "codeFingerprint.head", path, line),
      dirty: boolean(fingerprint.dirty, "codeFingerprint.dirty", path, line),
      dirtyHash: text(fingerprint.dirtyHash, "codeFingerprint.dirtyHash", path, line),
    },
    corpus: {
      version: integer(corpus.version, "corpus.version", path, line, 1),
      sha256,
    },
    vendorBuilds,
    plan: { mode: oneOf(planRaw.mode, JOURNAL_MODES, "plan.mode", path, line), repetitions, calls, scenarios },
  };
}

function parseCall(raw: unknown, path: string, line: number): JournalCallRecord {
  const record = isRecord(raw) ? raw : malformed(path, line, "the entry is not an object");
  if (record.type !== "call") malformed(path, line, 'the entry is not a "call"');
  const outcome = oneOf(record.outcome, ["completed", "failed"] as const, "outcome", path, line);
  const attempt =
    record.attempt === null
      ? null
      : isRecord(record.attempt)
        ? (record.attempt as unknown as ScenarioAttempt)
        : malformed(path, line, "attempt is neither an object nor null");
  if (attempt !== null && !isRecord(attempt.evidence)) {
    malformed(path, line, "attempt carries no evidence bundle");
  }
  const eligibility =
    record.eligibility === null
      ? null
      : isRecord(record.eligibility)
        ? {
            ...(record.eligibility as unknown as CallEligibilityFact),
            callId: text(record.eligibility.callId, "eligibility.callId", path, line),
            scenario: text(record.eligibility.scenario, "eligibility.scenario", path, line),
          }
        : malformed(path, line, "eligibility is neither an object nor null");
  const refusal =
    record.refusal === null
      ? null
      : isRecord(record.refusal)
        ? {
            code: text(record.refusal.code, "refusal.code", path, line),
            message: text(record.refusal.message, "refusal.message", path, line),
          }
        : malformed(path, line, "refusal is neither an object nor null");
  const pipelineImage =
    record.pipelineImage === null
      ? null
      : text(record.pipelineImage, "pipelineImage", path, line);
  const at = text(record.at, "at", path, line);
  if (Number.isNaN(Date.parse(at))) malformed(path, line, `at "${at}" is not a date`);

  if (outcome === "completed") {
    if (attempt === null) malformed(path, line, "a completed call carries no attempt");
    if (eligibility === null) malformed(path, line, "a completed call carries no eligibility");
    if (refusal !== null) malformed(path, line, "a completed call carries a refusal");
    if (!Object.prototype.hasOwnProperty.call(record, "cost")) {
      malformed(path, line, "a completed call carries no cost row");
    }
  } else {
    if (attempt !== null) malformed(path, line, "a failed call carries an attempt");
    if (eligibility !== null) malformed(path, line, "a failed call carries eligibility");
    if (refusal === null) malformed(path, line, "a failed call carries no refusal");
  }

  return {
    type: "call",
    scenario: text(record.scenario, "scenario", path, line),
    repetition: integer(record.repetition, "repetition", path, line, 1),
    locale: oneOf(record.locale, LOCALES, "locale", path, line),
    callId: text(record.callId, "callId", path, line),
    outcome,
    attempt,
    eligibility,
    cost: record.cost,
    pipelineImage,
    evidenceRefs: strings(record.evidenceRefs, "evidenceRefs", path, line),
    refusal,
    at,
  };
}

function parseRetry(raw: unknown, path: string, line: number): JournalRetryRecord {
  const record = isRecord(raw) ? raw : malformed(path, line, "the entry is not an object");
  if (record.type !== "retry") malformed(path, line, 'the entry is not a "retry"');
  const at = text(record.at, "at", path, line);
  if (Number.isNaN(Date.parse(at))) malformed(path, line, `at "${at}" is not a date`);
  return {
    type: "retry",
    scenario: text(record.scenario, "scenario", path, line),
    repetition: integer(record.repetition, "repetition", path, line, 1),
    code: text(record.code, "code", path, line),
    message: text(record.message, "message", path, line),
    at,
  };
}

function parseEntry(raw: unknown, path: string, line: number): JournalEntry {
  if (!isRecord(raw)) malformed(path, line, "the entry is not a JSON object");
  switch (raw.type) {
    case "header":
      return parseHeader(raw, path, line);
    case "call":
      return parseCall(raw, path, line);
    case "retry":
      return parseRetry(raw, path, line);
    default:
      return malformed(path, line, `unknown entry type "${String(raw.type)}"`);
  }
}

type Segment = { readonly line: string; readonly start: number; readonly end: number };

/** Every newline-delimited segment, with the offsets needed to truncate a torn tail. */
function segmentsOf(raw: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf("\n", start);
    if (newline === -1) {
      segments.push({ line: raw.slice(start), start, end: raw.length });
      break;
    }
    segments.push({ line: raw.slice(start, newline), start, end: newline + 1 });
    start = newline + 1;
  }
  return segments;
}

/**
 * Read a run's journal, truncating only a half-written tail.
 *
 * A completed entry always parses and ends at a newline. The final segment may
 * be a partial append; it is dropped and the file is cut back to the last
 * complete entry. Any earlier unparseable line refuses: it may hide a call the
 * run already paid for.
 */
export function readJournal(path: string): LoadedJournal {
  if (!existsSync(path)) {
    refuse(
      "journal-missing",
      `no journal at ${path}; --resume needs the interrupted run's own journal, and nothing ` +
        "is resumed implicitly",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    refuse(
      "journal-malformed",
      `cannot read the journal at ${path}: ${(error as Error).message}`,
    );
  }

  const segments = segmentsOf(raw);
  const entries: { entry: JournalEntry; line: number }[] = [];
  let truncateAt: number | null = null;
  for (const [index, segment] of segments.entries()) {
    if (segment.line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment.line) as unknown;
    } catch (error) {
      if (index !== segments.length - 1) {
        refuse(
          "journal-torn",
          `journal ${path} line ${index + 1} is not JSON (${(error as Error).message}); a torn ` +
            "line before the tail could hide a call the run already made, so the journal is " +
            "refused rather than trimmed",
        );
      }
      // Only a half-written final append is dropped. A line that parses but
      // fails validation is corruption and is refused by `parseEntry` below.
      truncateAt = Buffer.byteLength(raw.slice(0, segment.start), "utf8");
      break;
    }
    entries.push({ entry: parseEntry(parsed, path, index + 1), line: index + 1 });
  }

  const headerEntry = entries.find((entry) => entry.entry.type === "header");
  if (headerEntry === undefined || headerEntry.entry.type !== "header") {
    refuse(
      "journal-torn",
      `journal ${path} has no complete header entry; there is nothing to prove this is the ` +
        "same run, so it cannot be resumed",
    );
  }
  const header = headerEntry.entry;
  if (entries[0] !== headerEntry) {
    refuse("journal-torn", `journal ${path} does not begin with its header`);
  }

  const calls = new Map<string, JournalCallRecord>();
  const retries = new Map<string, JournalRetryRecord>();
  for (const { entry, line } of entries.slice(1)) {
    if (entry.type === "header") {
      malformed(path, line, "a second header cannot appear in the middle of a run");
    }
    const key = callKey(entry.scenario, entry.repetition);
    if (entry.type === "retry") {
      if (retries.has(key)) {
        malformed(path, line, `call ${key} records a second re-make; it is re-made at most once`);
      }
      retries.set(key, entry);
      continue;
    }
    if (calls.has(key)) {
      malformed(path, line, `call ${key} is recorded twice`);
    }
    const scenario = header.plan.scenarios.find((planned) => planned.name === entry.scenario);
    if (scenario === undefined) {
      refuse(
        "journal-plan-mismatch",
        `journal ${path} records call ${key}, but its plan holds no scenario ` +
          `"${entry.scenario}"`,
      );
    }
    if (entry.repetition > header.plan.repetitions) {
      refuse(
        "journal-plan-mismatch",
        `journal ${path} records call ${key}, outside its 1..` +
          `${header.plan.repetitions} repetition plan`,
      );
    }
    if (entry.locale !== scenario.locale) {
      refuse(
        "journal-plan-mismatch",
        `journal ${path} records call ${key} in Locale "${entry.locale}", but the plan speaks ` +
          `"${scenario.locale}"`,
      );
    }
    calls.set(key, entry);
  }

  const interrupted = new Set<string>();
  for (const key of retries.keys()) {
    if (!calls.has(key)) interrupted.add(key);
  }

  if (truncateAt !== null) truncateSync(path, truncateAt);

  return {
    path,
    header,
    calls,
    retries,
    interrupted,
    tailDropped: truncateAt !== null,
  };
}

/** What this run expects the journal to say; every difference is a named refusal. */
export type ResumeExpectation = {
  readonly runId: string;
  readonly target: CertificateTarget;
  readonly codeFingerprint: CodeFingerprint;
  readonly corpus: CorpusReference;
  readonly vendorBuilds: readonly VendorBuild[];
  readonly plan: VerifyPlan;
};

function fingerprintText(fingerprint: CodeFingerprint): string {
  return `${fingerprint.head}${fingerprint.dirty ? "+dirty" : ""}`;
}

function buildsByLeg(builds: readonly VendorBuild[]): Map<string, VendorBuild> {
  return new Map(builds.map((build) => [build.leg, build]));
}

/** Refuse a resume whose world moved; the journal is only true for its own run. */
export function assertResumable(loaded: LoadedJournal, expected: ResumeExpectation): void {
  const { header, path } = loaded;
  if (header.runId !== expected.runId) {
    refuse(
      "journal-run-id-mismatch",
      `journal ${path} names run "${header.runId}", but --resume named "${expected.runId}"; ` +
        "a certificate may not change its run id",
    );
  }
  if (header.target !== expected.target) {
    refuse(
      "journal-target-mismatch",
      `journal ${path} is for target "${header.target}", but this run is target ` +
        `"${expected.target}"; a green never inherits across targets`,
    );
  }
  if (
    header.codeFingerprint.head !== expected.codeFingerprint.head ||
    header.codeFingerprint.dirty !== expected.codeFingerprint.dirty ||
    header.codeFingerprint.dirtyHash !== expected.codeFingerprint.dirtyHash
  ) {
    refuse(
      "journal-code-mismatch",
      `journal ${path} started on code fingerprint ` +
        `${fingerprintText(header.codeFingerprint)}, but the repository is now ` +
        `${fingerprintText(expected.codeFingerprint)}; a resumed certificate stays true for ` +
        "the code the run measured",
    );
  }
  if (
    header.corpus.version !== expected.corpus.version ||
    header.corpus.sha256 !== expected.corpus.sha256
  ) {
    refuse(
      "journal-corpus-mismatch",
      `journal ${path} pins corpus v${header.corpus.version} ${header.corpus.sha256}, but this ` +
        `run reads corpus v${expected.corpus.version} ${expected.corpus.sha256}; a resumed ` +
        "certificate may not mix corpora",
    );
  }

  const recordedBuilds = buildsByLeg(header.vendorBuilds);
  const currentBuilds = buildsByLeg(expected.vendorBuilds);
  for (const leg of VENDOR_LEGS) {
    const recorded = recordedBuilds.get(leg);
    const current = currentBuilds.get(leg);
    if (recorded === undefined && current === undefined) continue;
    if (recorded === undefined || current === undefined) {
      refuse(
        "journal-vendor-builds-mismatch",
        `journal ${path} vendor build leg "${leg}" is ${recorded === undefined ? "missing" : "present"} ` +
          `but this run's record is ${current === undefined ? "missing" : "present"}; RR-03 ` +
          "refuses a resume whose vendors moved",
      );
    }
    if (
      recorded.buildId !== current.buildId ||
      recorded.vendor !== current.vendor ||
      recorded.model !== current.model
    ) {
      refuse(
        "journal-vendor-builds-mismatch",
        `journal ${path} ran vendor build ${leg} ${recorded.vendor}/${recorded.model}` +
          `@${recorded.buildId}, but this run would use ` +
          `${current.vendor}/${current.model}@${current.buildId}; RR-03 refuses a resume ` +
          "whose vendors moved",
      );
    }
  }

  const recordedPlan = header.plan;
  if (recordedPlan.mode !== expected.plan.mode) {
    refuse(
      "journal-plan-mismatch",
      `journal ${path} plan mode "${recordedPlan.mode}", but this run plans ` +
        `"${expected.plan.mode}"`,
    );
  }
  if (recordedPlan.repetitions !== expected.plan.repetitions) {
    refuse(
      "journal-plan-mismatch",
      `journal ${path} plan repetitions ${recordedPlan.repetitions}, but this run plans ` +
        `${expected.plan.repetitions}; a resumed certificate may not change its plan`,
    );
  }
  if (recordedPlan.calls !== expected.plan.calls) {
    refuse(
      "journal-plan-mismatch",
      `journal ${path} plan calls ${recordedPlan.calls}, but this run plans ` +
        `${String(expected.plan.calls)}`,
    );
  }
  if (recordedPlan.scenarios.length !== expected.plan.scenarios.length) {
    refuse(
      "journal-plan-mismatch",
      `journal ${path} plan holds ${recordedPlan.scenarios.length} scenarios, but this run ` +
        `plans ${expected.plan.scenarios.length}`,
    );
  }
  for (let index = 0; index < expected.plan.scenarios.length; index += 1) {
    const recorded = recordedPlan.scenarios[index] as PlannedScenario;
    const current = expected.plan.scenarios[index] as PlannedScenario;
    if (
      recorded.name !== current.name ||
      recorded.locale !== current.locale ||
      recorded.heldOut !== current.heldOut
    ) {
      refuse(
        "journal-plan-mismatch",
        `journal ${path} plan scenario ${index + 1} is "${recorded.name}" (${recorded.locale}), ` +
          `but this run plans "${current.name}" (${current.locale})`,
      );
    }
  }
}

/**
 * Every completed call must still have the evidence it cites. An empty
 * reference list means the attempt carries its evidence inline; a listed path
 * that is gone makes the journal's claim unsupported.
 */
export function assertEvidencePresent(loaded: LoadedJournal): void {
  for (const [key, call] of loaded.calls) {
    if (call.outcome !== "completed") continue;
    for (const ref of call.evidenceRefs) {
      const file = isAbsolute(ref) ? ref : resolve(ref);
      if (!existsSync(file)) {
        refuse(
          "journal-evidence-missing",
          `journal ${loaded.path} records ${key} as completed, but its evidence ${ref} is ` +
            "missing; the journal cannot claim a call the disk cannot support",
        );
      }
    }
  }
}
