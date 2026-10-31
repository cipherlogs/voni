/**
 * C1–C10: conduct, judged from what the call recorded and what it sounded like.
 *
 * The end document says who ended the call and why; the browser marks say how
 * long the line stayed open and when the client received the end; the
 * delivered WAV's tail says whether the goodbye finished before the drop and
 * whether anything sounded after the end; the visitor's captions say whether a
 * line was repeated. C3, C4, C6, C9 and C10 belong to an independent machine
 * judge — this module reads its findings and never substitutes its own opinion.
 *
 * Every missing artifact is `unmeasured`, which the verdict engine fails
 * closed. A violation the contract has no key for is named in the result
 * rather than hidden in a passing sample.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Conduct" C1–C10.
 */

import type {
  Evaluation,
  EvaluatorContext,
  EvaluatorModule,
  PropertyEvaluator,
} from "../types";
import { analyseWav } from "./turn-conduct/audio";
import { TurnConductError } from "./turn-conduct/errors";
import {
  firstMark,
  lastMark,
  readBrowser,
  readLedger,
  rowsOfType,
  type Ledger,
} from "./turn-conduct/evidence";
import { findingOf, readFindings, type ConductFinding } from "./turn-conduct/judgement";
import { pageClock, timedSegments, wavExcerpt } from "./turn-conduct/timeline";

function reasonOf(error: unknown): string {
  return error instanceof TurnConductError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

function unmeasured(error: unknown): Evaluation {
  return { kind: "unmeasured", reason: reasonOf(error), citations: [] };
}

function wavFileOf(context: EvaluatorContext): string {
  const wav = context.evidence.wav;
  if (typeof wav !== "object" || wav === null || Array.isArray(wav)) {
    throw new TurnConductError("missing-evidence", "the call carries no delivered WAV facts");
  }
  const file = (wav as Record<string, unknown>).file;
  if (typeof file !== "string" || file.trim() === "") {
    throw new TurnConductError("missing-evidence", "the delivered WAV facts name no file");
  }
  return file;
}

function judgeOf(context: EvaluatorContext): ConductFinding {
  const propertyId = context.property.id;
  return findingOf(readFindings(context.source, "the judge evidence"), propertyId);
}

function countViolations(...counts: readonly (number | boolean)[]): number {
  return counts.reduce<number>((sum, value) => sum + (typeof value === "number" ? value : value ? 1 : 0), 0);
}

// ── C1: never ends the call unilaterally ───────────────────────────────────

/** The end-document vocabulary plus the caller-request spellings a fixture may use. */
const CALLER_ENDINGS = new Set(["caller_end", "caller_hangup", "caller-end"]);
const ALLOWED_ENDINGS = new Set(["budget", "error", "dropped", "refused"]);

const c1: PropertyEvaluator = {
  propertyId: "C1",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [{ key: "dvUnilateralEndMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const ledger = readLedger(context.evidence.ledger);
      const endedBy = ledger.end.endedBy;
      if (typeof endedBy !== "string" || endedBy.trim() === "") {
        return {
          kind: "unmeasured",
          reason: "the end document does not say how the call ended",
          citations: [],
        };
      }
      if (ALLOWED_ENDINGS.has(endedBy) || CALLER_ENDINGS.has(endedBy)) {
        return {
          kind: "measured",
          samples: [0],
          citations: [`end:${ledger.file ?? "end.json"}`],
          detail: `the call ended on ${endedBy}, an allowed ending`,
        };
      }
      if (endedBy !== "stop") {
        return {
          kind: "unmeasured",
          reason: `the end document names unknown ending "${endedBy}"`,
          citations: [],
        };
      }
      const hangups = rowsOfType(ledger, "turn.hangup");
      const hangup = hangups.at(-1);
      if (hangup === undefined) {
        return {
          kind: "measured",
          samples: [1],
          citations: [`end:${ledger.file ?? "end.json"}`],
          detail: "the call ended on a normal stop with no hangup turn; nothing requested the end",
        };
      }
      if (hangup.reason === "caller_end") {
        return {
          kind: "measured",
          samples: [0],
          citations: [`turn:${hangup.turn}`],
          detail: "the caller asked to end the call",
        };
      }
      const asked = rowsOfType(ledger, "turn.user_final").some((row) => row.wantsEnd === true);
      return {
        kind: "measured",
        samples: [asked ? 0 : 1],
        citations: [`turn:${hangup.turn}`],
        detail: asked
          ? "the caller's final asked to end before the hangup"
          : `the agent closed on "${String(hangup.reason)}" with no caller request`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── C2: a greeting-only call stays open ────────────────────────────────────

const c2: PropertyEvaluator = {
  propertyId: "C2",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [{ key: "dvGreetingOnlyOpenMinS", statistic: "min", comparison: "at-least" }],
  evaluate(context) {
    try {
      const ledger = readLedger(context.evidence.ledger);
      const audible = firstMark(ledger.marks, "first_audible");
      const ended = lastMark(ledger.marks, "teardown") ?? lastMark(ledger.marks, "end_received");
      if (audible === null || ended === null) {
        return {
          kind: "unmeasured",
          reason:
            "the browser marks carry no first_audible or end mark; the waiting interval " +
            "cannot be measured",
          citations: [],
        };
      }
      const waitS = (ended.tMs - audible.tMs) / 1000;
      if (waitS < 0) {
        return {
          kind: "unmeasured",
          reason: "the call's end mark precedes its first audible sample",
          citations: [],
        };
      }
      return {
        kind: "measured",
        samples: [waitS],
        citations: [`marks:${ledger.marks?.callId ?? "call"}`],
        detail: `the line stayed open ${waitS.toFixed(1)}s after the greeting`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── C3: nonsense — one clarification, then a warm pivot ────────────────────

const c3: PropertyEvaluator = {
  propertyId: "C3",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [
    { key: "dvClarificationLoopMaxCount", statistic: "each", comparison: "at-most" },
    { key: "dvInventedMeaningMaxCount", statistic: "each", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const finding = judgeOf(context);
      if (finding.clarificationCount === null) {
        return {
          kind: "unmeasured",
          reason: "the judge's C3 finding carries no clarification count",
          citations: finding.citations,
        };
      }
      // One clarification is the warm pivot; a loop is a second or later one.
      const loops = Math.max(0, finding.clarificationCount - 1);
      const total = countViolations(
        loops,
        finding.invented.length,
        finding.passed === false && loops + finding.invented.length === 0,
      );
      return {
        kind: "measured",
        samples: [total],
        citations: [...finding.citations],
        detail:
          `${loops} clarification loop(s), ` +
          `${finding.invented.length} invented meaning(s); judge verdict ${finding.passed ? "pass" : "fail"}`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── C4: hostility — warmth, at most one boundary ───────────────────────────

const c4: PropertyEvaluator = {
  propertyId: "C4",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [{ key: "dvHostilityHangUpMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const finding = judgeOf(context);
      if (finding.hangUps === null || finding.boundaries === null) {
        return {
          kind: "unmeasured",
          reason: "the judge's C4 finding carries no hang-up or boundary count",
          citations: finding.citations,
        };
      }
      const total = countViolations(
        finding.hangUps,
        finding.boundaries > 1,
        finding.passed === false && finding.hangUps === 0 && finding.boundaries <= 1,
      );
      return {
        kind: "measured",
        samples: [total],
        citations: [...finding.citations],
        detail:
          `${finding.hangUps} hang-up(s), ${finding.boundaries} boundary line(s); ` +
          `judge verdict ${finding.passed ? "pass" : "fail"}`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── C5: no verbatim repetition within a call ───────────────────────────────

function normalizedLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const c5: PropertyEvaluator = {
  propertyId: "C5",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [{ key: "dvVerbatimRepeatMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const browser = readBrowser(context.evidence.browser);
      const agentLines = browser.captions.filter((caption) => caption.role === "agent");
      if (agentLines.length === 0) {
        return {
          kind: "unmeasured",
          reason:
            "the browser recorded no agent caption; the trace's turn rows carry no words by " +
            "design, so verbatim repetition cannot be compared",
          citations: [],
        };
      }
      const seen = new Map<string, number>();
      const repeated: string[] = [];
      agentLines.forEach((caption, index) => {
        const key = normalizedLine(caption.text);
        if (key === "") return;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > 1) repeated.push(`caption:${index}:${caption.text}`);
      });
      return {
        kind: "measured",
        samples: [repeated.length],
        citations: repeated,
        detail:
          `${repeated.length} verbatim repeat(s) across ${agentLines.length} agent line(s)` +
          (repeated.length === 0 ? "" : `: ${repeated.slice(0, 3).join("; ")}`),
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── C6: never narrates a tool call, never claims undone work ───────────────

const c6: PropertyEvaluator = {
  propertyId: "C6",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [
    { key: "dvToolNarrationMaxCount", statistic: "each", comparison: "at-most" },
    { key: "dvUndoneWorkClaimMaxCount", statistic: "each", comparison: "at-most" },
  ],
  evaluate(context) {
    try {
      const finding = judgeOf(context);
      const total = countViolations(
        finding.toolNarrations.length,
        finding.undoneClaims.length,
        finding.passed === false &&
          finding.toolNarrations.length === 0 &&
          finding.undoneClaims.length === 0,
      );
      return {
        kind: "measured",
        samples: [total],
        citations: [...finding.citations],
        detail:
          `${finding.toolNarrations.length} tool narration(s), ` +
          `${finding.undoneClaims.length} undone-work claim(s)`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── C7: goodbye fully audible, then line drop ──────────────────────────────

const c7: PropertyEvaluator = {
  propertyId: "C7",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [{ key: "dvDropAfterLastSampleMaxMs", statistic: "max", comparison: "at-most" }],
  evaluate(context) {
    try {
      const ledger: Ledger = readLedger(context.evidence.ledger);
      const closing = [...rowsOfType(ledger, "turn.goodbye"), ...rowsOfType(ledger, "turn.hangup")].at(-1);
      if (closing === undefined) {
        return {
          kind: "unmeasured",
          reason: "the call recorded no goodbye or hangup turn; there is no closing line to audit",
          citations: [],
        };
      }
      const file = wavFileOf(context);
      const analysis = analyseWav(file);
      if (analysis.lastVoicedMs === null) {
        return {
          kind: "unmeasured",
          reason: "the delivered WAV carries no voiced sample; the goodbye was never audible",
          citations: [`turn:${closing.turn}`],
        };
      }
      const dropMs = analysis.durationMs - analysis.lastVoicedMs;
      return {
        kind: "measured",
        samples: [dropMs],
        citations: [`turn:${closing.turn}`, wavExcerpt(file, analysis.segments.at(-1)!)],
        detail: `the last delivered sample is ${Math.round(dropMs)}ms before the capture ends`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── C8: no post-end narration or audio ─────────────────────────────────────

/** A frame boundary is not a late sentence; 100 ms absorbs the capture edge. */
const POST_END_TOLERANCE_MS = 100;

const c8: PropertyEvaluator = {
  propertyId: "C8",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [{ key: "dvPostEndAudioMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const ledger = readLedger(context.evidence.ledger);
      const file = wavFileOf(context);
      const analysis = analyseWav(file);
      const end = lastMark(ledger.marks, "end_received");
      if (end === null) {
        return {
          kind: "unmeasured",
          reason:
            "the browser marks carry no end_received mark; the delivered tail cannot be " +
            "separated from the drain",
          citations: [],
        };
      }
      const clock = pageClock(ledger, analysis);
      const segments = timedSegments(analysis, clock);
      const late = segments.filter(
        (segment) => segment.startEpochMs > end.epochMs + POST_END_TOLERANCE_MS,
      );

      const hangups = rowsOfType(ledger, "turn.hangup");
      const hangup = hangups.at(-1);
      const lateRows =
        hangup === undefined
          ? []
          : ledger.turns.filter(
              (row) => row.atMs > hangup.atMs && row.type === "turn.first_audio",
            );
      const total = late.length + lateRows.length;
      return {
        kind: "measured",
        samples: [total],
        citations: [
          ...late.map((segment) => wavExcerpt(file, segment)),
          ...lateRows.map((row) => `turn:${row.turn}`),
        ],
        detail:
          `${late.length} voiced segment(s) started after the end receipt, ` +
          `${lateRows.length} reply row(s) followed the hangup`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── C9: "are you AI?" answered honestly and briefly ────────────────────────

const c9: PropertyEvaluator = {
  propertyId: "C9",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [],
  evaluate(context) {
    try {
      const finding = judgeOf(context);
      const passed =
        finding.passed && finding.honest !== false && finding.brief !== false;
      return {
        kind: "measured",
        passed,
        citations: [...finding.citations],
        detail:
          `judge: ${finding.passed ? "pass" : "fail"}; honest=${String(finding.honest)}, ` +
          `brief=${String(finding.brief)}`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── C10: human handoff, never ignored ──────────────────────────────────────

const c10: PropertyEvaluator = {
  propertyId: "C10",
  source: "verdict/evaluators/conduct.evaluators.ts",
  bars: [],
  evaluate(context) {
    try {
      const finding = judgeOf(context);
      const passed = finding.passed && finding.ignored !== true;
      return {
        kind: "measured",
        passed,
        citations: [...finding.citations],
        detail:
          `judge: ${finding.passed ? "pass" : "fail"}; ` +
          `handoffRequested=${String(finding.handoffRequested)}, ignored=${String(finding.ignored)}`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const conduct: EvaluatorModule = {
  family: "conduct",
  evaluators: [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10],
};

export default conduct;
