/**
 * The W0 verdict: which layer broke first, in causal order.
 *
 * A cascade call has two captures — the reference rendering and the delivered
 * audio — so the verdict separates four layers, never more:
 *
 * 1. **vendor voice** — the reference itself is malformed (no level, an
 *    inserted silence, a peak at the ceiling, the wrong line). Nothing
 *    downstream can be judged.
 * 2. **model text** — the call's transcript is not the intended line, so the
 *    audio layers were never given the same words and are not comparable.
 * 3. **our pipeline** — the delivered audio differs in level, peak, spectrum,
 *    distortion, crest, voice or language: a server-side request/assembly
 *    defect.
 * 4. **client** — the delivered audio carries a playout signature: chunk-rate
 *    envelope modulation, an inserted silence, a device-rate alias or a
 *    boundary fade. That is below the server, in the browser.
 *
 * Layers are evaluated in that order, and the first failure is the only one
 * named. A later difference is marked `NOT-COMPARABLE`; it cannot steal the
 * blame. A layer with an unmeasured axis is `UNMEASURED` and blocks a pass —
 * an unmeasured input is never a zero and never a pass (ticket 123).
 *
 * The rule reads the comparison's measurements; it never re-measures. The
 * client-owned windows are already masked out of the pipeline audit and the
 * slow gain envelope is already divided out, so a hole in playback is not
 * re-read as a server residual (ticket 124).
 */
import {
  SCOREBOARD_BUDGETS,
  type BudgetKey,
  type BudgetUnit,
} from "../demo/scoreboard-budgets";
import type { TwoCaptureComparison, TwoCaptureRole } from "./comparison";
import { wordChangeCount } from "./verdict";

/** The four causal layers, in the order they are judged. */
export const W0_LAYERS = ["vendor voice", "model text", "our pipeline", "client"] as const;

export type W0Layer = (typeof W0_LAYERS)[number];

/**
 * Every audio metric the W0 instrument measures on the captured pair. A metric
 * with no red proof does not ship (ticket 125); the registry is the contract
 * the proofs iterate.
 */
export const W0_AUDIO_METRICS = [
  "level",
  "peak",
  "spectrum",
  "distortion",
  "crest",
  "modulation",
  "breakups",
  "alias",
  "fade",
] as const;

export type W0Metric = (typeof W0_AUDIO_METRICS)[number];

/** The non-audio facts a layer also rests on. */
export type W0Fact = "capture" | "onset" | "format" | "line" | "text" | "voice" | "language";

export type W0CheckName = W0Metric | W0Fact;

export type W0CheckStatus = "PASS" | "FAIL" | "UNMEASURED" | "SKIPPED";

export type W0Threshold = { key: BudgetKey; value: number; unit: BudgetUnit };

export type W0Check = {
  layer: W0Layer;
  metric: W0CheckName;
  subject: "reference" | "delivered" | "comparison" | "model";
  status: W0CheckStatus;
  /** The measured value, or null when the signal cannot carry it. */
  value: number | null;
  /** The frozen budget the check enforces, when it enforces one. */
  bar: W0Threshold | null;
  /** The module that produced the value; null for an injected fact. */
  producer: string | null;
  /** A readable sentence naming the measurement, the bar and the failure. */
  reason: string | null;
};

export type W0LayerFinding = {
  layer: W0Layer;
  status: "PASS" | "FAIL" | "UNMEASURED" | "NOT-COMPARABLE";
  /** Every check the layer evaluated; empty when the layer was never reached. */
  checks: W0Check[];
  /** The first failure's reason, or every unmeasured reason. */
  reason: string | null;
};

export type W0Verdict = {
  status: "divergence" | "none" | "unresolved";
  /** The first causal layer that diverged; null when nothing or nothing measurable did. */
  layer: W0Layer | null;
  /** The axis that carried the first divergence, when one did. */
  axis: W0CheckName | null;
  /** One sentence naming the layer and the fact. */
  sentence: string;
  /** Every layer in causal order, with its own status. */
  layers: W0LayerFinding[];
  /** Every reason a pass is blocked; empty only for `none`. */
  blockers: string[];
  /** Every check the rule evaluated, in causal order. */
  checks: W0Check[];
  /** Every frozen bar the sentence enforced. */
  thresholds: W0Threshold[];
};

/** What the call intended to speak, from the body and the voice binding. */
export type W0Intent = {
  /** The voice the call was meant to use. */
  voice?: string;
  /** The locale the line is meant to be spoken in. */
  language?: string;
};

/**
 * Voice and language facts measured on the delivered capture. They are input,
 * never inferred from the requested voice: a claim about the audio must come
 * from the audio (ADR 0009).
 */
export type W0DeliveredFacts = {
  voice?: string;
  language?: string;
  /** The probe that produced the facts; defaults to `delivered-capture.probe`. */
  producer?: string;
};

export type W0VerdictInput = {
  comparison: TwoCaptureComparison;
  /** The platform transcript of the line the greeting marker names. */
  transcript?: string;
  /** What the call intended; a voice/language fact is checked only when both sides are named. */
  intent?: W0Intent;
  /** What the delivered capture was measured to carry. */
  delivered?: W0DeliveredFacts;
};

function bar(key: BudgetKey): W0Threshold {
  return { key, value: SCOREBOARD_BUDGETS[key].value, unit: SCOREBOARD_BUDGETS[key].unit };
}

function check(
  base: Omit<W0Check, "status" | "value" | "bar" | "reason">,
  outcome:
    | { status: "PASS"; value: number | null; bar: W0Threshold | null; reason: string }
    | { status: "FAIL"; value: number | null; bar: W0Threshold | null; reason: string }
    | { status: "UNMEASURED" | "SKIPPED"; value: null; bar: W0Threshold | null; reason: string },
): W0Check {
  return {
    ...base,
    status: outcome.status,
    value: outcome.value,
    bar: outcome.bar,
    reason: outcome.reason,
  };
}

function numberOf(
  comparison: TwoCaptureComparison,
  id: string,
  role: TwoCaptureRole,
): { value: number | null; reason: string | null } {
  const row = comparison.rows.find((candidate) => candidate.id === id);
  if (!row) return { value: null, reason: `the comparison has no "${id}" row` };
  const cell = row.cells[role];
  return cell.kind === "value"
    ? { value: cell.value, reason: null }
    : { value: null, reason: cell.kind === "text" ? cell.text : cell.reason };
}

function minutes(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : String(value);
}

// ── Layer 1: the vendor's voice ─────────────────────────────────────────────

function referenceChecks(comparison: TwoCaptureComparison): W0Check[] {
  const checks: W0Check[] = [];
  const capture = comparison.captures.find((entry) => entry.role === "reference");
  const problem = capture?.problem ?? null;

  if (problem !== null) {
    const wrongLine = problem.code === "wrong-line";
    checks.push(
      check(
        { layer: "vendor voice", metric: "capture", subject: "reference", producer: "comparison.captureProblem" },
        wrongLine
          ? {
              status: "FAIL",
              value: null,
              bar: null,
              reason: problem.reason,
            }
          : { status: "UNMEASURED", value: null, bar: null, reason: problem.reason },
      ),
    );
    if (!wrongLine) {
      // The file is not the reference, so its own metrics cannot be judged.
      checks.push(
        check(
          { layer: "vendor voice", metric: "level", subject: "reference", producer: "level-facts.analyseLevel" },
          { status: "UNMEASURED", value: null, bar: bar("comparisonLevelLu"), reason: problem.reason },
        ),
        check(
          { layer: "vendor voice", metric: "peak", subject: "reference", producer: "level-facts.analyseLevel" },
          { status: "UNMEASURED", value: null, bar: bar("comparisonReferenceClipDbtp"), reason: problem.reason },
        ),
        check(
          { layer: "vendor voice", metric: "breakups", subject: "reference", producer: "breakups.detectBreakups" },
          { status: "UNMEASURED", value: null, bar: bar("comparisonBreakupCount"), reason: problem.reason },
        ),
      );
      return checks;
    }
  }

  const level = numberOf(comparison, "integrated", "reference");
  if (level.value === null) {
    checks.push(
      check(
        { layer: "vendor voice", metric: "level", subject: "reference", producer: "level-facts.analyseLevel" },
        {
          status: "FAIL",
          value: null,
          bar: bar("comparisonLevelLu"),
          reason: `the reference itself has no measurable level (${level.reason ?? "unmeasured"})`,
        },
      ),
    );
  } else {
    checks.push(
      check(
        { layer: "vendor voice", metric: "level", subject: "reference", producer: "level-facts.analyseLevel" },
        {
          status: "PASS",
          value: level.value,
          bar: bar("comparisonLevelLu"),
          reason: `the reference reads ${level.value.toFixed(2)} LUFS, so it carries a baseline`,
        },
      ),
    );
  }

  const breakups = numberOf(comparison, "breakup-count", "reference");
  const breakupBar = bar("comparisonBreakupCount");
  if (breakups.value === null) {
    checks.push(
      check(
        { layer: "vendor voice", metric: "breakups", subject: "reference", producer: "breakups.detectBreakups" },
        { status: "UNMEASURED", value: null, bar: breakupBar, reason: breakups.reason ?? "unmeasured" },
      ),
    );
  } else if (breakups.value >= breakupBar.value) {
    checks.push(
      check(
        { layer: "vendor voice", metric: "breakups", subject: "reference", producer: "breakups.detectBreakups" },
        {
          status: "FAIL",
          value: breakups.value,
          bar: breakupBar,
          reason: `the reference already carries ${breakups.value} inserted ${
            breakups.value === 1 ? "silence" : "silences"
          }, so nothing downstream can be judged`,
        },
      ),
    );
  } else {
    checks.push(
      check(
        { layer: "vendor voice", metric: "breakups", subject: "reference", producer: "breakups.detectBreakups" },
        { status: "PASS", value: breakups.value, bar: breakupBar, reason: "the reference carries no inserted silence" },
      ),
    );
  }

  const peak = numberOf(comparison, "true-peak", "reference");
  const peakBar = bar("comparisonReferenceClipDbtp");
  if (peak.value === null) {
    checks.push(
      check(
        { layer: "vendor voice", metric: "peak", subject: "reference", producer: "level-facts.analyseLevel" },
        { status: "UNMEASURED", value: null, bar: peakBar, reason: peak.reason ?? "unmeasured" },
      ),
    );
  } else if (peak.value >= peakBar.value) {
    checks.push(
      check(
        { layer: "vendor voice", metric: "peak", subject: "reference", producer: "level-facts.analyseLevel" },
        {
          status: "FAIL",
          value: peak.value,
          bar: peakBar,
          reason: `the reference true peak sits at ${minutes(peak.value)} dBTP, at the full-scale ceiling`,
        },
      ),
    );
  } else {
    checks.push(
      check(
        { layer: "vendor voice", metric: "peak", subject: "reference", producer: "level-facts.analyseLevel" },
        {
          status: "PASS",
          value: peak.value,
          bar: peakBar,
          reason: `the reference true peak is ${minutes(peak.value)} dBTP, inside the ceiling bar`,
        },
      ),
    );
  }
  return checks;
}

// ── Layer 2: the model's text ───────────────────────────────────────────────

function modelTextChecks(input: W0VerdictInput): W0Check[] {
  const line = input.comparison.line;
  if (line === null) {
    return [
      check(
        { layer: "model text", metric: "line", subject: "model", producer: "comparison.line" },
        { status: "UNMEASURED", value: null, bar: null, reason: "no line marker, so model text cannot be checked" },
      ),
    ];
  }
  const transcript = input.transcript?.trim() ?? "";
  if (transcript === "") {
    return [
      check(
        { layer: "model text", metric: "text", subject: "model", producer: "verdict.wordChangeCount" },
        { status: "UNMEASURED", value: null, bar: bar("comparisonModelTextWordChanges"), reason: "no transcript supplied" },
      ),
    ];
  }
  const changes = wordChangeCount(line.text, transcript);
  const textBar = bar("comparisonModelTextWordChanges");
  if (changes > textBar.value) {
    return [
      check(
        { layer: "model text", metric: "text", subject: "model", producer: "verdict.wordChangeCount" },
        {
          status: "FAIL",
          value: changes,
          bar: textBar,
          reason:
            `the transcript says ${JSON.stringify(transcript)} where the intended line says ` +
            `${JSON.stringify(line.text)}, so the audio layers were never given the same words`,
        },
      ),
    ];
  }
  return [
    check(
      { layer: "model text", metric: "text", subject: "model", producer: "verdict.wordChangeCount" },
      {
        status: "PASS",
        value: changes,
        bar: textBar,
        reason: `the transcript is the intended line (${changes} word changes allowed)`,
      },
    ),
  ];
}

// ── Layer 3: our pipeline ───────────────────────────────────────────────────

function pipelineChecks(input: W0VerdictInput): W0Check[] {
  const { comparison } = input;
  const checks: W0Check[] = [];
  const audit = comparison.pipeline;

  const reading = (value: number | null, reason: string): { value: number | null; reason: string | null } => ({
    value,
    reason: value === null ? reason : null,
  });

  const peakBar = bar("timbreMeasuredTruePeakDbtp");
  const peak = audit.peak.measured
    ? reading(audit.peak.value.deliveredDbtp, "")
    : reading(null, audit.peak.reason);
  if (peak.value === null) {
    checks.push(
      check(
        { layer: "our pipeline", metric: "peak", subject: "delivered", producer: "level-facts.analyseLevel" },
        { status: "UNMEASURED", value: null, bar: peakBar, reason: peak.reason ?? "unmeasured" },
      ),
    );
  } else if (peak.value >= peakBar.value) {
    checks.push(
      check(
        { layer: "our pipeline", metric: "peak", subject: "delivered", producer: "level-facts.analyseLevel" },
        {
          status: "FAIL",
          value: peak.value,
          bar: peakBar,
          reason: `the delivered true peak is ${minutes(peak.value)} dBTP, over the ${peakBar.value} dBTP headroom bar`,
        },
      ),
    );
  } else {
    checks.push(
      check(
        { layer: "our pipeline", metric: "peak", subject: "delivered", producer: "level-facts.analyseLevel" },
        {
          status: "PASS",
          value: peak.value,
          bar: peakBar,
          reason: `the delivered true peak is ${minutes(peak.value)} dBTP, inside the ${peakBar.value} dBTP bar`,
        },
      ),
    );
  }

  const levelBar = bar("comparisonLevelLu");
  if (!audit.level.measured) {
    checks.push(
      check(
        { layer: "our pipeline", metric: "level", subject: "delivered", producer: "level-facts.analyseLevel" },
        { status: "UNMEASURED", value: null, bar: levelBar, reason: audit.level.reason },
      ),
    );
  } else {
    const delta = audit.level.value.deltaLu;
    const failed = Math.abs(delta) > levelBar.value;
    checks.push(
      check(
        { layer: "our pipeline", metric: "level", subject: "delivered", producer: "level-facts.analyseLevel" },
        {
          status: failed ? "FAIL" : "PASS",
          value: delta,
          bar: levelBar,
          reason: failed
            ? `the delivered level is ${minutes(Math.abs(delta))} LU ${delta < 0 ? "below" : "above"} the reference, over the ${levelBar.value} LU bar`
            : `the delivered level is within ${levelBar.value} LU of the reference (${minutes(delta)} LU)`,
        },
      ),
    );
  }

  const spectrumBar = bar("comparisonBandDeltaDb");
  if (audit.clientOwned.includes("spectrum")) {
    checks.push(
      check(
        { layer: "our pipeline", metric: "spectrum", subject: "delivered", producer: "spectral-balance.measureSpectralBalance" },
        {
          status: "SKIPPED",
          value: null,
          bar: spectrumBar,
          reason: audit.spectrum.measured ? "a client signature owns this axis" : audit.spectrum.reason,
        },
      ),
    );
  } else if (!audit.spectrum.measured) {
    checks.push(
      check(
        { layer: "our pipeline", metric: "spectrum", subject: "delivered", producer: "spectral-balance.measureSpectralBalance" },
        { status: "UNMEASURED", value: null, bar: spectrumBar, reason: audit.spectrum.reason },
      ),
    );
  } else {
    const delta = audit.spectrum.value.deltaDb;
    const failed = Math.abs(delta) > spectrumBar.value;
    checks.push(
      check(
        { layer: "our pipeline", metric: "spectrum", subject: "delivered", producer: "spectral-balance.measureSpectralBalance" },
        {
          status: failed ? "FAIL" : "PASS",
          value: delta,
          bar: spectrumBar,
          reason: failed
            ? `the delivered octave tilt is ${minutes(Math.abs(delta))} dB away from the reference, over the ${spectrumBar.value} dB bar`
            : `the delivered octave tilt is within ${spectrumBar.value} dB of the reference (${minutes(delta)} dB)`,
        },
      ),
    );
  }

  const distortionBar = bar("comparisonDistortionDb");
  if (audit.clientOwned.includes("distortion")) {
    checks.push(
      check(
        { layer: "our pipeline", metric: "distortion", subject: "delivered", producer: "distortion-crest.distortionResidual" },
        {
          status: "SKIPPED",
          value: null,
          bar: distortionBar,
          reason: audit.distortion.measured ? "a client signature owns this axis" : audit.distortion.reason,
        },
      ),
    );
  } else if (!audit.distortion.measured) {
    checks.push(
      check(
        { layer: "our pipeline", metric: "distortion", subject: "delivered", producer: "distortion-crest.distortionResidual" },
        { status: "UNMEASURED", value: null, bar: distortionBar, reason: audit.distortion.reason },
      ),
    );
  } else {
    const residual = audit.distortion.value.residualDb;
    const failed = residual > distortionBar.value;
    checks.push(
      check(
        { layer: "our pipeline", metric: "distortion", subject: "delivered", producer: "distortion-crest.distortionResidual" },
        {
          status: failed ? "FAIL" : "PASS",
          value: Number.isFinite(residual) ? residual : null,
          bar: distortionBar,
          reason: failed
            ? `the delivered residual is ${Number.isFinite(residual) ? `${residual.toFixed(1)} dB` : "unmeasurable"} against the reference, over the ${distortionBar.value} dB bar`
            : `the delivered residual is ${Number.isFinite(residual) ? `${residual.toFixed(1)} dB` : "no residual"} against the reference, inside the ${distortionBar.value} dB bar`,
        },
      ),
    );
  }

  const crestBar = bar("timbreMeasuredCrestMin");
  if (!audit.crest.measured) {
    checks.push(
      check(
        { layer: "our pipeline", metric: "crest", subject: "delivered", producer: "distortion-crest.crestFactor" },
        { status: "UNMEASURED", value: null, bar: crestBar, reason: audit.crest.reason },
      ),
    );
  } else {
    const crest = audit.crest.value.delivered;
    const failed = crest < crestBar.value;
    checks.push(
      check(
        { layer: "our pipeline", metric: "crest", subject: "delivered", producer: "distortion-crest.crestFactor" },
        {
          status: failed ? "FAIL" : "PASS",
          value: crest,
          bar: crestBar,
          reason: failed
            ? `the delivered crest is ${crest.toFixed(3)}, below the ${crestBar.value} bar`
            : `the delivered crest is ${crest.toFixed(3)}, at or above the ${crestBar.value} bar`,
        },
      ),
    );
  }

  checks.push(...voiceAndLanguageChecks(input));
  return checks;
}

function voiceAndLanguageChecks(input: W0VerdictInput): W0Check[] {
  const producer = input.delivered?.producer ?? "delivered-capture.probe";
  const pairs: { metric: "voice" | "language"; expected?: string; heard?: string }[] = [
    { metric: "voice", expected: input.intent?.voice, heard: input.delivered?.voice },
    { metric: "language", expected: input.intent?.language, heard: input.delivered?.language },
  ];
  return pairs.map(({ metric, expected, heard }) => {
    if (expected === undefined && heard === undefined) {
      return check(
        { layer: "our pipeline", metric, subject: "delivered", producer },
        { status: "SKIPPED", value: null, bar: null, reason: `no ${metric} fact was measured on the delivered capture` },
      );
    }
    if (expected === undefined || heard === undefined) {
      return check(
        { layer: "our pipeline", metric, subject: "delivered", producer },
        {
          status: "UNMEASURED",
          value: null,
          bar: null,
          reason: `the ${metric} cannot be checked: ${
            expected === undefined ? "no intended value" : `no delivered ${metric} fact`
          }`,
        },
      );
    }
    const failed = expected !== heard;
    return check(
      { layer: "our pipeline", metric, subject: "delivered", producer },
      {
        status: failed ? "FAIL" : "PASS",
        value: null,
        bar: null,
        reason: failed
          ? `the delivered capture is ${JSON.stringify(heard)} where the call intended ${JSON.stringify(expected)}`
          : `the delivered capture matches the intended ${metric} (${JSON.stringify(heard)})`,
      },
    );
  });
}

// ── Layer 4: the client ─────────────────────────────────────────────────────

function clientChecks(comparison: TwoCaptureComparison): W0Check[] {
  const signature = (kind: "inserted-silence" | "chunk-rate-modulation" | "device-rate-alias" | "boundary-fade") => {
    const found = comparison.clientSignatures.find((entry) => entry.kind === kind);
    const metric: W0Metric =
      kind === "inserted-silence"
        ? "breakups"
        : kind === "chunk-rate-modulation"
          ? "modulation"
          : kind === "device-rate-alias"
            ? "alias"
            : "fade";
    const producer =
      kind === "inserted-silence"
        ? "breakups.detectBreakups"
        : kind === "chunk-rate-modulation"
          ? "envelope-modulation.measureEnvelopeModulation"
          : kind === "device-rate-alias"
            ? "comparison.deviceRateAlias"
            : "comparison.boundaryFade";
    if (found === undefined) {
      return check(
        { layer: "client", metric, subject: "delivered", producer },
        { status: "UNMEASURED", value: null, bar: null, reason: `the ${kind} signature is missing from the comparison` },
      );
    }
    const threshold =
      found.bar === null
        ? null
        : { key: found.bar.key, value: found.bar.value, unit: found.bar.unit };
    if (found.reason !== null) {
      return check(
        { layer: "client", metric, subject: "delivered", producer },
        { status: "UNMEASURED", value: null, bar: threshold, reason: found.reason },
      );
    }
    return check(
      { layer: "client", metric, subject: "delivered", producer },
      {
        status: found.detected ? "FAIL" : "PASS",
        value: found.value,
        bar: threshold,
        reason: found.detail,
      },
    );
  };
  return [
    signature("chunk-rate-modulation"),
    signature("inserted-silence"),
    signature("device-rate-alias"),
    signature("boundary-fade"),
  ];
}

// ── The rule ────────────────────────────────────────────────────────────────

/**
 * Every check the rule evaluates, in causal order, without short-circuiting.
 * The red proofs read this directly: a metric whose check can disappear or
 * never fail is a metric that does not ship (ticket 125).
 */
export function evaluateW0Checks(input: W0VerdictInput): W0Check[] {
  return [
    ...referenceChecks(input.comparison),
    ...modelTextChecks(input),
    ...pipelineChecks(input),
    ...clientChecks(input.comparison),
  ];
}

function summarize(layer: W0Layer, checks: readonly W0Check[]): W0LayerFinding {
  const failures = checks.filter((entry) => entry.status === "FAIL");
  if (failures.length > 0) {
    return { layer, status: "FAIL", checks: [...checks], reason: failures[0].reason };
  }
  const unmeasured = checks.filter((entry) => entry.status === "UNMEASURED");
  if (unmeasured.length > 0) {
    return {
      layer,
      status: "UNMEASURED",
      checks: [...checks],
      reason: unmeasured.map((entry) => entry.reason).filter(Boolean).join("; "),
    };
  }
  return { layer, status: "PASS", checks: [...checks], reason: null };
}

function notComparable(layer: W0Layer, reason: string): W0LayerFinding {
  return { layer, status: "NOT-COMPARABLE", checks: [], reason };
}

function divergenceSentence(
  layer: "vendor voice" | "our pipeline" | "client",
  detail: string,
  axis: W0CheckName,
): string {
  if (layer === "vendor voice") {
    return `The first divergence is the vendor voice: ${detail}, so no later layer can be judged until the reference is fixed.`;
  }
  if (layer === "our pipeline") {
    return `The first divergence is our pipeline: ${detail}, so the defect is in the server-side request or assembly, not in playback.`;
  }
  const subject = "playback";
  return `The first divergence is the client: ${detail}, so the defect is in our ${subject}, below the server.`;
}

/**
 * Decide the W0 verdict. Pure over its input: the same comparison, transcript
 * and facts always produce the same sentence.
 */
export function decideW0Verdict(input: W0VerdictInput): W0Verdict {
  const checks = evaluateW0Checks(input);
  const of = (layer: W0Layer) => checks.filter((entry) => entry.layer === layer);
  const reference = summarize("vendor voice", of("vendor voice"));
  const text = summarize("model text", of("model text"));
  const pipeline = summarize("our pipeline", of("our pipeline"));
  const client = summarize("client", of("client"));

  const finish = (
    status: W0Verdict["status"],
    layer: W0Layer | null,
    axis: W0CheckName | null,
    sentence: string,
    layers: W0LayerFinding[],
    blockers: string[],
    enforced: W0Threshold[],
  ): W0Verdict => ({
    status,
    layer,
    axis,
    sentence,
    layers,
    blockers,
    checks,
    thresholds: enforced,
  });

  if (reference.status === "FAIL") {
    const failed = of("vendor voice").find((entry) => entry.status === "FAIL")!;
    const reason = failed.reason ?? "the reference is malformed";
    return finish(
      "divergence",
      "vendor voice",
      failed.metric,
      divergenceSentence("vendor voice", reason, failed.metric),
      [reference, notComparable("model text", "the vendor voice broke first"), notComparable("our pipeline", "the vendor voice broke first"), notComparable("client", "the vendor voice broke first")],
      [],
      [failed.bar, bar("comparisonLevelLu")].filter((entry): entry is W0Threshold => entry !== null),
    );
  }

  if (reference.status === "UNMEASURED") {
    const blockers = of("vendor voice").filter((entry) => entry.status === "UNMEASURED").map((entry) => entry.reason ?? "reference unmeasured");
    return finish(
      "unresolved",
      null,
      null,
      `The verdict is unresolved: ${blockers.join("; ")}; an unmeasured input is never a pass.`,
      [reference, notComparable("model text", "the reference is not usable"), notComparable("our pipeline", "the reference is not usable"), notComparable("client", "the reference is not usable")],
      blockers,
      [],
    );
  }

  if (text.status === "FAIL") {
    const failed = of("model text").find((entry) => entry.status === "FAIL")!;
    return finish(
      "divergence",
      "model text",
      null,
      `The first divergence is model text: ${failed.reason}, so the audio layers were never given the same words and cannot be compared.`,
      [reference, text, notComparable("our pipeline", "model text broke first: the audio layers were never given the same words"), notComparable("client", "model text broke first: the audio layers were never given the same words")],
      [],
      [failed.bar].filter((entry): entry is W0Threshold => entry !== null),
    );
  }

  if (text.status === "UNMEASURED") {
    const blockers = of("model text").filter((entry) => entry.status === "UNMEASURED").map((entry) => entry.reason ?? "model text unmeasured");
    return finish(
      "unresolved",
      null,
      null,
      `The verdict is unresolved: ${blockers.join("; ")}; the audio layers cannot be compared until the words are known.`,
      [reference, text, notComparable("our pipeline", "model text was not checked"), notComparable("client", "model text was not checked")],
      blockers,
      [],
    );
  }

  // The comparison itself can still be unresolved for a reason no layer owns
  // (an onset, a format or a delivered-capture problem). No layer is blamed.
  if (input.comparison.status !== "measured") {
    const blockers = input.comparison.unresolvedReasons;
    return finish(
      "unresolved",
      null,
      null,
      `The verdict is unresolved: ${blockers.join("; ")}; no layer can be blamed from an incomplete comparison.`,
      [reference, text, notComparable("our pipeline", "the comparison is incomplete"), notComparable("client", "the comparison is incomplete")],
      blockers,
      [],
    );
  }

  if (pipeline.status === "FAIL") {
    const failed = of("our pipeline").find((entry) => entry.status === "FAIL")!;
    return finish(
      "divergence",
      "our pipeline",
      failed.metric,
      divergenceSentence("our pipeline", failed.reason ?? "the delivered audio differs from its reference", failed.metric),
      [reference, text, pipeline, notComparable("client", "our pipeline broke first")],
      [],
      [failed.bar].filter((entry): entry is W0Threshold => entry !== null),
    );
  }

  if (pipeline.status === "UNMEASURED") {
    const blockers = of("our pipeline").filter((entry) => entry.status === "UNMEASURED").map((entry) => entry.reason ?? "pipeline axis unmeasured");
    return finish(
      "unresolved",
      null,
      null,
      `The verdict is unresolved: ${blockers.join("; ")}; an unmeasured input is never a pass.`,
      [reference, text, pipeline, notComparable("client", "our pipeline was not fully measured")],
      blockers,
      [],
    );
  }

  if (client.status === "FAIL") {
    const failed = of("client").find((entry) => entry.status === "FAIL")!;
    return finish(
      "divergence",
      "client",
      failed.metric,
      divergenceSentence("client", failed.reason ?? "the delivered audio carries a playout signature", failed.metric),
      [reference, text, pipeline, client],
      [],
      [failed.bar].filter((entry): entry is W0Threshold => entry !== null),
    );
  }

  if (client.status === "UNMEASURED") {
    const blockers = of("client").filter((entry) => entry.status === "UNMEASURED").map((entry) => entry.reason ?? "client signature unmeasured");
    return finish(
      "unresolved",
      null,
      null,
      `The verdict is unresolved: ${blockers.join("; ")}; the client cannot be cleared from an unmeasured signature.`,
      [reference, text, pipeline, client],
      blockers,
      [],
    );
  }

  return finish(
    "none",
    null,
    null,
    "No divergence: the delivered capture matches the reference on every measured axis, the transcript is the intended line, and no client signature is present.",
    [reference, text, pipeline, client],
    [],
    [
      bar("comparisonLevelLu"),
      bar("comparisonBandDeltaDb"),
      bar("comparisonDistortionDb"),
      bar("comparisonBreakupCount"),
      bar("comparisonModulationDepth"),
      bar("comparisonOnsetToleranceS"),
      bar("comparisonReferenceClipDbtp"),
      bar("timbreMeasuredTruePeakDbtp"),
      bar("timbreMeasuredCrestMin"),
    ],
  );
}
