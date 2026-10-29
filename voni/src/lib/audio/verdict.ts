/**
 * The verdict: one sentence naming the first layer where the three captures
 * diverge — the reference itself, the model's text, the platform, or our
 * client — so triage starts at the layer that broke instead of at a theory.
 *
 * The rule reads the table `comparison.ts` already built; it never re-measures.
 * Layers are considered in causal order, so only the first divergence is
 * named and a later difference cannot steal the blame:
 *
 * 1. **reference** — the baseline is malformed (no level, an inserted silence,
 *    or a peak at the ceiling), so nothing downstream can be judged.
 * 2. **model text** — the platform transcript is not the intended line, so the
 *    audio layers were never comparing the same words.
 * 3. **platform** — the platform recording already differs from the reference.
 * 4. **client** — the platform matched the reference and the delivered audio
 *    differs from the platform.
 *
 * Every bar is a frozen budget record in `scoreboard-budgets.ts`, quoted here
 * rather than restated, so a threshold change cannot ride in with a verdict.
 * When two captures are not aligned, or an axis could not be measured, the
 * verdict is unresolved and says so instead of blaming the client.
 */
import type { AudioComparison, CaptureRole, ComparisonRow } from "./comparison";
import { SCOREBOARD_BUDGETS, type BudgetKey, type BudgetUnit } from "../demo/scoreboard-budgets";

/** The four layers a divergence can belong to, in causal order. */
export const VERDICT_SUBJECTS = ["reference", "model text", "platform", "client"] as const;

export type VerdictSubject = (typeof VERDICT_SUBJECTS)[number];

/** The measured axes the rule compares, in the order the first divergence is chosen. */
export type DivergenceAxis = "breakups" | "level" | "modulation" | "spectrum" | "distortion";

export type VerdictInput = {
  comparison: AudioComparison;
  /** The line the agent was meant to say; with `transcript`, enables model text. */
  intendedLine?: string;
  /** The platform's transcript of what the agent said. */
  transcript?: string;
};

/** A bar the sentence enforced, cited with the record that holds it. */
export type VerdictThreshold = {
  key: BudgetKey;
  value: number;
  unit: BudgetUnit;
};

export type Verdict = {
  status: "divergence" | "none" | "unresolved";
  /** The layer named, or `null` when no layer can be named. */
  subject: VerdictSubject | null;
  /** The axis that carried the first divergence, when one did. */
  axis: DivergenceAxis | null;
  /** One sentence, printed after the table. */
  sentence: string;
  /** Every frozen budget the sentence enforced. */
  thresholds: readonly VerdictThreshold[];
};

const B = SCOREBOARD_BUDGETS;

function threshold(key: BudgetKey): VerdictThreshold {
  return { key, value: B[key].value, unit: B[key].unit };
}

/** Every bar the verdict can enforce, for a verdict that cleared every axis. */
const ALL_COMPARISON_BUDGETS = Object.keys(SCOREBOARD_BUDGETS).filter((key) =>
  key.startsWith("comparison"),
) as BudgetKey[];

function allThresholds(): VerdictThreshold[] {
  return ALL_COMPARISON_BUDGETS.map(threshold);
}

function row(comparison: AudioComparison, id: ComparisonRow["id"]): ComparisonRow {
  const found = comparison.rows.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`comparison has no "${id}" row for the verdict`);
  return found;
}

function numeric(
  comparison: AudioComparison,
  id: ComparisonRow["id"],
  role: CaptureRole,
): number | null {
  const cell = row(comparison, id).cells[role];
  return cell.kind === "value" ? cell.value : null;
}

function cellReason(comparison: AudioComparison, id: ComparisonRow["id"], role: CaptureRole): string {
  const cell = row(comparison, id).cells[role];
  if (cell.kind === "unmeasured") return cell.reason;
  if (cell.kind === "text") return cell.text;
  return "no numeric reading";
}

function breakups(
  comparison: AudioComparison,
  role: CaptureRole,
): { count: number; seconds: number } | null {
  const count = numeric(comparison, "breakup-count", role);
  const seconds = numeric(comparison, "breakup-total", role);
  return count === null || seconds === null ? null : { count, seconds };
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(3)} s`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

// ── Model text ───────────────────────────────────────────────────────────────

/** Words a line carries: case, punctuation and diacritic composition are not words. */
function words(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Insertions plus deletions between the intended words and the heard words. */
export function wordChangeCount(intended: string, heard: string): number {
  const a = words(intended);
  const b = words(heard);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      lcs[i][j] =
        a[i - 1] === b[j - 1]
          ? lcs[i - 1][j - 1] + 1
          : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }
  return Math.max(a.length, b.length) - lcs[a.length][b.length];
}

type TextEvidence =
  | { checked: true; changes: number; intended: string; heard: string }
  | { checked: false; missing: string };

function readText(input: VerdictInput): TextEvidence {
  const intended = input.intendedLine?.trim() ?? "";
  const heard = input.transcript?.trim() ?? "";
  const intendedPresent = intended.length > 0;
  const transcriptPresent = input.transcript !== undefined;

  if (!intendedPresent && !transcriptPresent) {
    return { checked: false, missing: "no intended line or transcript supplied" };
  }
  if (!intendedPresent) return { checked: false, missing: "no intended line supplied" };
  if (!transcriptPresent) return { checked: false, missing: "no transcript supplied" };
  return { checked: true, changes: wordChangeCount(intended, heard), intended, heard };
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim()}"`;
}

// ── Reference integrity ──────────────────────────────────────────────────────

/** Why the baseline cannot be trusted, or `null` when it can. */
function referenceDefect(
  comparison: AudioComparison,
): { detail: string; key: BudgetKey } | null {
  const levelCell = row(comparison, "integrated").cells.reference;
  if (levelCell.kind !== "value") {
    return {
      detail: `it has no measurable level (${cellReason(comparison, "integrated", "reference")})`,
      key: "comparisonLevelLu",
    };
  }

  const holes = breakups(comparison, "reference");
  if (holes && holes.count >= B.comparisonBreakupCount.value) {
    return {
      detail: `it already carries ${holes.count} inserted ${plural(holes.count, "silence", "silences")} (${formatSeconds(holes.seconds)})`,
      key: "comparisonBreakupCount",
    };
  }

  const truePeak = numeric(comparison, "true-peak", "reference");
  if (truePeak !== null && truePeak >= B.comparisonReferenceClipDbtp.value) {
    const peak = Math.abs(truePeak) < 0.005 ? "0.00" : truePeak.toFixed(2);
    return {
      detail: `its true peak sits at ${peak} dBTP, at the full-scale ceiling`,
      key: "comparisonReferenceClipDbtp",
    };
  }

  return null;
}

// ── Pairwise divergence ──────────────────────────────────────────────────────

function captureFacts(comparison: AudioComparison, role: CaptureRole) {
  const found = comparison.captures.find((capture) => capture.role === role);
  if (!found) throw new Error(`comparison has no ${role} capture`);
  return found.format;
}

/** A sample-wise or FFT comparison needs one rate and one channel count. */
function formatsAgree(comparison: AudioComparison, a: CaptureRole, b: CaptureRole): boolean {
  const left = captureFacts(comparison, a);
  const right = captureFacts(comparison, b);
  return left.sampleRate === right.sampleRate && left.channels === right.channels;
}

type DistortionReading =
  | { kind: "value"; db: number }
  | { kind: "none" }
  | { kind: "silent" }
  | { kind: "unmeasured"; reason: string };

function readDistortion(comparison: AudioComparison, role: CaptureRole): DistortionReading {
  const cell = row(comparison, "distortion").cells[role];
  if (cell.kind === "unmeasured") return { kind: "unmeasured", reason: cell.reason };
  if (cell.kind === "value") return { kind: "value", db: cell.value };
  if (cell.text === "no residual") return { kind: "none" };
  if (cell.text === "no delivered signal") return { kind: "silent" };
  return { kind: "unmeasured", reason: "distortion is the baseline in this column" };
}

type PairResult =
  | { kind: "divergence"; axis: DivergenceAxis }
  | { kind: "unmeasured"; reasons: string[] }
  | { kind: "match" };

/**
 * The first axis on which `to` has moved away from `from`, in the fixed axis
 * order. A measured divergence outranks an unmeasured axis; if nothing
 * diverged, every axis that could not be read is reported.
 */
function comparePair(
  comparison: AudioComparison,
  from: CaptureRole,
  to: CaptureRole,
): PairResult {
  const unmeasured: string[] = [];

  const fromBreakups = breakups(comparison, from);
  const toBreakups = breakups(comparison, to);
  if (fromBreakups === null || toBreakups === null) {
    unmeasured.push(`breakups could not be measured on the ${fromBreakups === null ? from : to}`);
  } else if (toBreakups.count - fromBreakups.count >= B.comparisonBreakupCount.value) {
    return { kind: "divergence", axis: "breakups" };
  }

  const fromLevel = numeric(comparison, "integrated", from);
  const toLevel = numeric(comparison, "integrated", to);
  if (fromLevel === null || toLevel === null) {
    unmeasured.push(
      `level could not be measured on the ${fromLevel === null ? from : to} (${cellReason(
        comparison,
        "integrated",
        fromLevel === null ? from : to,
      )})`,
    );
  } else if (Math.abs(toLevel - fromLevel) > B.comparisonLevelLu.value) {
    return { kind: "divergence", axis: "level" };
  }

  const fromModulation = numeric(comparison, "modulation-depth", from);
  const toModulation = numeric(comparison, "modulation-depth", to);
  if (fromModulation === null || toModulation === null) {
    unmeasured.push(
      `modulation could not be measured on the ${fromModulation === null ? from : to}`,
    );
  } else if (Math.abs(toModulation - fromModulation) / 100 > B.comparisonModulationDepth.value) {
    return { kind: "divergence", axis: "modulation" };
  }

  const fromTilt = numeric(comparison, "band-delta", from);
  const toTilt = numeric(comparison, "band-delta", to);
  if (!formatsAgree(comparison, from, to)) {
    unmeasured.push(`spectral tilt could not be measured across formats (${from} vs ${to})`);
  } else if (fromTilt === null || toTilt === null) {
    unmeasured.push(`spectral tilt could not be measured on the ${fromTilt === null ? from : to}`);
  } else if (Math.abs(toTilt - fromTilt) > B.comparisonBandDeltaDb.value) {
    return { kind: "divergence", axis: "spectrum" };
  }

  const fromDistortion = readDistortion(comparison, from);
  const toDistortion = readDistortion(comparison, to);
  if (toDistortion.kind === "silent") {
    return { kind: "divergence", axis: "distortion" };
  }
  if (from === "reference") {
    // The platform column's residual is already quoted against the reference.
    if (toDistortion.kind === "value" && toDistortion.db > B.comparisonDistortionDb.value) {
      return { kind: "divergence", axis: "distortion" };
    }
    if (toDistortion.kind === "unmeasured") {
      unmeasured.push(`distortion could not be measured on the ${to} (${toDistortion.reason})`);
    }
  } else if (toDistortion.kind === "unmeasured" || fromDistortion.kind === "unmeasured") {
    unmeasured.push(
      `distortion could not be measured on the ${
        toDistortion.kind === "unmeasured" ? to : from
      } (${toDistortion.kind === "unmeasured" ? toDistortion.reason : (fromDistortion as { reason: string }).reason})`,
    );
  } else if (toDistortion.kind === "value" || toDistortion.kind === "none") {
    const before = fromDistortion.kind === "value" ? fromDistortion.db : -Infinity;
    const after = toDistortion.kind === "value" ? toDistortion.db : -Infinity;
    // A copy with no residual cannot carry a 3 dB rise; fall back to the
    // absolute reshaping bar so a clean copy is not a zero baseline.
    const bar =
      before === -Infinity
        ? B.comparisonDistortionDb.value
        : before + B.comparisonDistortionDeltaDb.value;
    if (after > bar) {
      return { kind: "divergence", axis: "distortion" };
    }
  }

  return unmeasured.length > 0 ? { kind: "unmeasured", reasons: unmeasured } : { kind: "match" };
}

function describeDelta(delta: number, unit: BudgetUnit): string {
  const sign = delta < 0 ? "below" : "above";
  const magnitude = Math.abs(delta);
  return unit === "db" ? `${magnitude.toFixed(1)} dB ${sign}` : `${magnitude.toFixed(1)} ${sign}`;
}

/** What moved on the named axis, quoted as a fact the reader can check in the table. */
function axisDetail(
  comparison: AudioComparison,
  axis: DivergenceAxis,
  from: CaptureRole,
  to: CaptureRole,
  subject: "platform" | "client",
): string {
  const actor = subject === "platform" ? "the platform recording" : "the delivered audio";
  const against = from === "reference" ? "the reference" : "the platform";

  switch (axis) {
    case "breakups": {
      const before = breakups(comparison, from);
      const after = breakups(comparison, to);
      const extra = (after?.count ?? 0) - (before?.count ?? 0);
      const seconds = Math.max(0, (after?.seconds ?? 0) - (before?.seconds ?? 0));
      return `${actor} adds ${extra} extra ${plural(extra, "inserted silence", "inserted silences")} (${formatSeconds(seconds)})`;
    }
    case "level": {
      const before = numeric(comparison, "integrated", from) ?? 0;
      const after = numeric(comparison, "integrated", to) ?? 0;
      return `${actor} is ${describeDelta(after - before, "db")} ${against}`;
    }
    case "modulation": {
      const before = numeric(comparison, "modulation-depth", from) ?? 0;
      const after = numeric(comparison, "modulation-depth", to) ?? 0;
      return `${actor} carries ${(after - before).toFixed(1)} points more envelope modulation than ${against}`;
    }
    case "spectrum": {
      const before = numeric(comparison, "band-delta", from) ?? 0;
      const after = numeric(comparison, "band-delta", to) ?? 0;
      return `${actor} is ${describeDelta(after - before, "db")} ${against} in octave tilt`;
    }
    case "distortion": {
      const after = numeric(comparison, "distortion", to);
      if (after === null) return `${actor} carries no measurable signal against ${against}`;
      const before = numeric(comparison, "distortion", from);
      if (subject === "client" && before !== null) {
        return `${actor} carries ${(after - before).toFixed(1)} dB more residual reshaping than ${against}`;
      }
      return `${actor} carries ${Math.abs(after).toFixed(1)} dB of residual reshaping against ${against}`;
    }
  }
}

// ── Alignment ────────────────────────────────────────────────────────────────

/** Pairs whose starts must agree before their samples are compared. */
const ALIGNMENT_PAIRS = [
  ["reference", "platform"],
  ["reference", "delivered"],
  ["platform", "delivered"],
] as const;

type AlignmentIssue = { from: CaptureRole; to: CaptureRole; deltaSeconds: number };

/**
 * The first pair whose onsets differ beyond the bar. A capture that starts
 * late (or early) shifts every sample comparison, so the divergence would be
 * an artifact of the capture, not of a layer.
 */
function alignmentIssue(comparison: AudioComparison): AlignmentIssue | null {
  for (const [from, to] of ALIGNMENT_PAIRS) {
    const fromOnset = numeric(comparison, "onset", from);
    const toOnset = numeric(comparison, "onset", to);
    if (fromOnset === null || toOnset === null) continue;
    const deltaSeconds = Math.abs(toOnset - fromOnset);
    if (deltaSeconds > B.comparisonOnsetToleranceS.value) {
      return { from, to, deltaSeconds };
    }
  }
  return null;
}

function alignmentSentence(issue: AlignmentIssue): string {
  return (
    `The verdict is unresolved: the ${issue.from} and ${issue.to} captures are not aligned ` +
    `(onsets differ by ${issue.deltaSeconds.toFixed(3)} s, beyond the ` +
    `${B.comparisonOnsetToleranceS.value.toFixed(3)} s bar), so no layer can be blamed until an ` +
    "aligned capture is compared."
  );
}

// ── Sentences ────────────────────────────────────────────────────────────────

function textClause(text: TextEvidence): string {
  return text.checked ? "" : ` (model text was not checked: ${text.missing})`;
}

function divergenceSentence(
  comparison: AudioComparison,
  subject: "platform" | "client",
  axis: DivergenceAxis,
  text: TextEvidence,
): string {
  const from: CaptureRole = subject === "platform" ? "reference" : "platform";
  const to: CaptureRole = subject === "platform" ? "platform" : "delivered";
  const detail = axisDetail(comparison, axis, from, to, subject);
  if (subject === "platform") {
    return (
      `The first divergence is the platform: ${detail}, while the delivered audio matches it, ` +
      `so the defect is in the platform, not the client${textClause(text)}.`
    );
  }
  return `The first divergence is the client: ${detail}, so the defect is in our playback, below the platform.`;
}

function referenceSentence(defect: string): string {
  return `The first divergence is the reference itself: ${defect}, so no later layer can be judged until you fix the reference capture.`;
}

function modelTextSentence(text: Extract<TextEvidence, { checked: true }>): string {
  return (
    `The first divergence is model text: the platform transcript says ${quote(text.heard)} where the ` +
    `intended line says ${quote(text.intended)}, so the audio layers below were never given the same words.`
  );
}

function thresholdsFor(axis: DivergenceAxis | null): VerdictThreshold[] {
  const keys: BudgetKey[] = ["comparisonOnsetToleranceS"];
  if (axis === "breakups") keys.push("comparisonBreakupCount");
  if (axis === "level") keys.push("comparisonLevelLu");
  if (axis === "modulation") keys.push("comparisonModulationDepth");
  if (axis === "spectrum") keys.push("comparisonBandDeltaDb");
  if (axis === "distortion") keys.push("comparisonDistortionDb", "comparisonDistortionDeltaDb");
  return keys.map(threshold);
}

/**
 * Decide the verdict from the table. Pure over its input: the same three
 * readings and texts always produce the same sentence.
 */
export function decideVerdict(input: VerdictInput): Verdict {
  const { comparison } = input;
  const text = readText(input);

  const defect = referenceDefect(comparison);
  if (defect !== null) {
    return {
      status: "divergence",
      subject: "reference",
      axis: null,
      sentence: referenceSentence(defect.detail),
      thresholds: [threshold(defect.key)],
    };
  }

  if (text.checked && text.changes > B.comparisonModelTextWordChanges.value) {
    return {
      status: "divergence",
      subject: "model text",
      axis: null,
      sentence: modelTextSentence(text),
      thresholds: [threshold("comparisonModelTextWordChanges")],
    };
  }

  const misaligned = alignmentIssue(comparison);
  if (misaligned !== null) {
    return {
      status: "unresolved",
      subject: null,
      axis: null,
      sentence: alignmentSentence(misaligned),
      thresholds: [threshold("comparisonOnsetToleranceS")],
    };
  }

  const platform = comparePair(comparison, "reference", "platform");
  if (platform.kind === "divergence") {    return {
      status: "divergence",
      subject: "platform",
      axis: platform.axis,
      sentence: divergenceSentence(comparison, "platform", platform.axis, text),
      thresholds: thresholdsFor(platform.axis),
    };
  }

  const client = comparePair(comparison, "platform", "delivered");
  if (client.kind === "divergence") {
    return {
      status: "divergence",
      subject: "client",
      axis: client.axis,
      sentence: divergenceSentence(comparison, "client", client.axis, text),
      thresholds: thresholdsFor(client.axis),
    };
  }

  const unmeasured = [
    ...(platform.kind === "unmeasured" ? platform.reasons : []),
    ...(client.kind === "unmeasured" ? client.reasons : []),
  ];
  if (unmeasured.length > 0) {
    return {
      status: "unresolved",
      subject: null,
      axis: null,
      sentence:
        `The verdict is unresolved: no divergence was measured, but ${unmeasured.join("; ")}, ` +
        "so the comparison cannot clear the client.",
      thresholds: allThresholds(),
    };
  }

  return {
    status: "none",
    subject: null,
    axis: null,
    sentence:
      `No divergence: the delivered audio matches the platform, which matches the reference on ` +
      `every measured axis${textClause(text)}.`,
    thresholds: allThresholds(),
  };
}
