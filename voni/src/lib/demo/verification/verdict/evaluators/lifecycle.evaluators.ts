/**
 * Lifecycle and connect evaluators: L1–L11.
 *
 * The family measures the visitor's path, not the client's internal state:
 * the connect marks say when "connected" was painted and when the first
 * audible sample arrived, the trace says what the service opened, and the
 * delivered WAV says what the visitor heard. The reported bugs are the first
 * two seams: a connected paint before admission (L2) and a greeting-only call
 * that ends with a goodbye cut by teardown (L9). C1/C2 carry the ending and
 * greeting-only checks the same ticket requires; they live in the conduct
 * module because the contract files them there.
 *
 * Every missing fact is `unmeasured`, never a borrowed pass. No evaluator
 * holds a bar number: the engine resolves each threshold key.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Lifecycle and connect" L1–L11.
 */

import type { EvaluatorModule, Evaluation, PropertyEvaluator } from "../types";
import {
  audioAnswer,
  chimeFacts,
  clockFacts,
  configFacts,
  connectFacts,
  endDivergenceFacts,
  firstAudioFacts,
  goodbyeFacts,
  greetingBreathFacts,
  ringbackFacts,
  unavailableFacts,
  voiceOpenFacts,
} from "../lifecycle/analysis";
import {
  LifecycleEvidenceError,
  readEnd,
  readMarks,
  readTrace,
  readWav,
  reasonOf,
} from "../lifecycle/evidence";
import { analyseWav } from "../lifecycle/wav";
import { threshold } from "./threshold";

function unmeasured(error: unknown): Evaluation {
  return { kind: "unmeasured", reason: reasonOf(error), citations: [] };
}

function measured(
  samples: readonly number[],
  citations: readonly string[],
  detail: string,
): Evaluation {
  return { kind: "measured", samples, citations, detail };
}

const l1: PropertyEvaluator = {
  propertyId: "L1",
  source: "lifecycle.evaluators.ts",
  bars: [
    { key: "dvRingbackAfterAnswerMaxCount", statistic: "each", comparison: "at-most" },
    { key: "dvRingbackOnHoldReturnMaxCount", statistic: "each", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const marks = readMarks(context.evidence);
      const answer = audioAnswer(marks, analyseWav(readWav(context.evidence).file));
      const facts = ringbackFacts(marks, answer.answerMs);
      return measured(
        [facts.afterAnswerCount, facts.holdReturnCount],
        facts.afterAnswerCount > 0 || facts.holdReturnCount > 0
          ? ["browser:ringback", "browser:first_audible", "wav:delivered"]
          : ["browser:ringback", "wav:delivered"],
        `${facts.detail}; ${answer.detail}`,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l2: PropertyEvaluator = {
  propertyId: "L2",
  source: "lifecycle.evaluators.ts",
  bars: [{ key: "dvConnectedBeforeAdmissionMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const facts = connectFacts(readMarks(context.evidence));
      return measured(
        [facts.connectedBeforeAdmissionCount],
        facts.connectedBeforeAdmissionCount > 0 ? ["browser:connected_painted", "browser:admitted"] : [],
        facts.detail,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l3: PropertyEvaluator = {
  propertyId: "L3",
  source: "lifecycle.evaluators.ts",
  bars: [
    { key: "dvChimeCountExact", statistic: "each", comparison: "exact" },
    { key: "dvChimeWindowMs", statistic: "each", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const facts = chimeFacts(readMarks(context.evidence));
      const countSample = facts.exactlyOne ? 1 : Math.max(0, facts.count);
      // The engine judges every sample against every bar, so a clean window is
      // encoded as the number both bars accept: the exact count is 1 and a
      // within-window sample is 1 ms. A late chime keeps its measured window,
      // which fails the bar and names the real delay in the detail.
      const windowMax = threshold(context, "dvChimeWindowMs");
      const windowSample =
        facts.windowMs !== null && facts.windowMs <= windowMax ? 1 : (facts.windowMs ?? 0);
      return measured(
        [countSample, windowSample],
        facts.exactlyOne && (facts.windowMs ?? 0) <= windowMax
          ? ["browser:chime"]
          : ["browser:chime", "browser:first_audible"],
        facts.detail,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l4: PropertyEvaluator = {
  propertyId: "L4",
  source: "lifecycle.evaluators.ts",
  bars: [
    { key: "dvGreetingFirstAudioP95Ms", statistic: "p95", comparison: "at-most" },
    { key: "dvGreetingFirstAudioMaxMs", statistic: "max", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const facts = firstAudioFacts(readMarks(context.evidence));
      return measured(
        [facts.gapMs],
        ["browser:connected_painted", "browser:first_audible"],
        `${facts.gapMs}ms from the connected paint at ${Math.round(facts.connectedAtMs)}ms to ` +
          `the first audible sample at ${Math.round(facts.firstAudibleAtMs)}ms`,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l5: PropertyEvaluator = {
  propertyId: "L5",
  source: "lifecycle.evaluators.ts",
  bars: [{ key: "dvConfigAfterMicMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      readTrace(context.evidence);
      const facts = configFacts(readMarks(context.evidence));
      return measured(
        [facts.afterMicCount],
        facts.afterMicCount > 0
          ? ["browser:config_sent", "browser:microphone_acquired", "trace"]
          : ["browser:config_sent", "browser:microphone_acquired"],
        `config sent at ${Math.round(facts.configAtMs)}ms, microphone acquired at ` +
          `${Math.round(facts.micAtMs)}ms`,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l6: PropertyEvaluator = {
  propertyId: "L6",
  source: "lifecycle.evaluators.ts",
  bars: [{ key: "dvTtsOpenMaxMs", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      readTrace(context.evidence);
      const facts = voiceOpenFacts(readMarks(context.evidence));
      const max = threshold(context, "dvTtsOpenMaxMs");
      const over = facts.openMs > max;
      if (over && facts.namedState) {
        return measured(
          [0],
          ["browser:admitted", "browser:refused", "browser:start_failed"],
          `${facts.detail}; the open exceeded ${max}ms but the visitor saw the named ` +
            `${facts.namedStateName ?? "unavailable"} state`,
        );
      }
      return measured(
        [facts.openMs],
        facts.namedState ? ["browser:admitted", "browser:refused"] : ["browser:admitted", "browser:first_audible"],
        facts.detail,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l7: PropertyEvaluator = {
  propertyId: "L7",
  source: "lifecycle.evaluators.ts",
  bars: [{ key: "dvGreetingContinuousMaxMs", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      readWav(context.evidence);
      const facts = greetingBreathFacts(context.evidence);
      return measured([facts.longestRunMs], ["wav:delivered"], facts.detail);
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l8: PropertyEvaluator = {
  propertyId: "L8",
  source: "lifecycle.evaluators.ts",
  bars: [{ key: "dvClockStartBeforeAudioMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      readEnd(context.evidence);
      const marks = readMarks(context.evidence);
      const answer = audioAnswer(marks, analyseWav(readWav(context.evidence).file));
      const facts = clockFacts(marks, answer.answerMs);
      return measured(
        [facts.beforeAudioCount],
        facts.beforeAudioCount > 0
          ? ["browser:talk_clock_start", "browser:first_audible", "wav:delivered"]
          : ["browser:talk_clock_start", "browser:first_audible", "wav:delivered"],
        `${facts.detail}; ${answer.detail}`,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l9: PropertyEvaluator = {
  propertyId: "L9",
  source: "lifecycle.evaluators.ts",
  bars: [
    { key: "dvGoodbyePlayedRatioMin", statistic: "each", comparison: "at-least" },
    { key: "dvDropAfterLastSampleMaxMs", statistic: "each", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const wav = readWav(context.evidence);
      const facts = goodbyeFacts(
        readMarks(context.evidence),
        readTrace(context.evidence),
        readEnd(context.evidence),
        analyseWav(wav.file),
      );
      if (!facts.started) {
        return {
          kind: "unmeasured",
          reason: `${facts.detail}; L9 is not exercised by a call with no goodbye`,
          citations: [],
        };
      }
      return measured(
        [facts.playedRatio, facts.dropMs],
        ["browser:end_call_received", "browser:teardown", "wav:delivered"],
        facts.detail,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l10: PropertyEvaluator = {
  propertyId: "L10",
  source: "lifecycle.evaluators.ts",
  bars: [{ key: "dvSilentEndMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const facts = unavailableFacts(
        readMarks(context.evidence),
        readEnd(context.evidence),
      );
      return measured(
        [facts.silentEnd ? 1 : 0],
        facts.silentEnd ? ["browser:teardown", "ledger:end"] : ["ledger:end"],
        facts.detail,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const l11: PropertyEvaluator = {
  propertyId: "L11",
  source: "lifecycle.evaluators.ts",
  bars: [{ key: "dvEndEndCallDivergenceMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const facts = endDivergenceFacts(
        readMarks(context.evidence),
        readTrace(context.evidence),
        readEnd(context.evidence),
      );
      return measured(
        [facts.divergenceCount],
        facts.divergenceCount > 0 ? ["browser:end_received", "browser:end_call_received", "trace"] : ["trace"],
        facts.detail,
      );
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const lifecycle: EvaluatorModule = {
  family: "lifecycle",
  evaluators: [l1, l2, l3, l4, l5, l6, l7, l8, l9, l10, l11],
};

export default lifecycle;
export { LifecycleEvidenceError };
