/**
 * The lifecycle family's measurements, read from the visitor timeline.
 *
 * A connect mark is a fact about what the visitor saw; a trace row is what the
 * service did; the delivered WAV is what the visitor heard. The functions here
 * turn those three into the numbers L1–L11 and C1–C2 need, and never guess a
 * missing fact: a missing timeline raises, the evaluator reports `unmeasured`,
 * and the verdict fails closed.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Lifecycle and connect" and C1/C2.
 */

import type { CallMarksArtifact, CallMark } from "@/lib/voice/call-marks";

import type { ScenarioFacts } from "../../scenarios";
import type { EvidenceBundle } from "../types";
import {
  LifecycleEvidenceError,
  detailText,
  endError,
  endGoodbye,
  endGreeting,
  firstMark,
  isRow,
  lastMark,
  marksNamed,
  traceRowsOfType,
  type Row,
} from "./evidence";
import { analyseWav, lastSpeechRunMs, openingSpeechRuns, type WavAnalysis } from "./wav";

/** The marks that name a visitor-facing failure state. */
const NAMED_STATE_MARKS = ["refused", "start_failed", "error_received"] as const;
/** A natural word ending leaves silence; a cut does not. */
const MIN_COMPLETED_TAIL_MS = 50;
/** A caller's authored words that ask to end the call. */
const CALLER_END_REQUEST =
  /\b(goodbye|bye|that'?s all|that is all|thanks|thank you|hang up|end the call|stop)\b/i;

function optionalMark(marks: CallMarksArtifact, name: string): CallMark | null {
  return firstMark(marks, name);
}

function namedState(marks: CallMarksArtifact): CallMark | null {
  for (const name of NAMED_STATE_MARKS) {
    const mark = marksNamed(marks, name)[0];
    if (mark !== undefined) return mark;
  }
  return null;
}

export type RingbackFacts = {
  readonly afterAnswerCount: number;
  readonly holdReturnCount: number;
  readonly detail: string;
};

/** L1: a ringback loop that outlives the answer, or one revived on return. */
export function ringbackFacts(marks: CallMarksArtifact): RingbackFacts {
  const starts = marksNamed(marks, "ringback_start");
  const stops = marksNamed(marks, "ringback_stop");
  const answer = optionalMark(marks, "first_audible") ?? optionalMark(marks, "admitted");
  if (starts.length === 0) {
    return {
      afterAnswerCount: 0,
      holdReturnCount: 0,
      detail: "no ringback start was recorded; the visitor heard no connecting loop",
    };
  }

  const afterAnswerCount =
    answer === null
      ? stops.length === 0
        ? 1
        : 0
      : starts.filter((start) => {
          const stop = stops.find((entry) => entry.tMs >= start.tMs);
          return stop === undefined || stop.tMs > answer.tMs;
        }).length;
  const firstStart = starts[0]!;
  const holdReturnCount = starts.filter(
    (start) => start.tMs > firstStart.tMs && (answer === null || start.tMs > answer.tMs),
  ).length;

  const answerText =
    answer === null
      ? "no answer mark"
      : `the answer at ${Math.round(answer.tMs)}ms`;
  return {
    afterAnswerCount,
    holdReturnCount,
    detail:
      `${starts.length} ringback start(s), ${stops.length} stop(s); ` +
      `${afterAnswerCount} outlived ${answerText}; ` +
      `${holdReturnCount} started again after the call was live`,
  };
}

export type ConnectFacts = {
  readonly connectedBeforeAdmissionCount: number;
  readonly connectedAtMs: number | null;
  readonly admittedAtMs: number | null;
  readonly firstAudibleAtMs: number | null;
  readonly gapToAdmissionMs: number | null;
  readonly gapToAudibleMs: number | null;
  readonly detail: string;
};

/** L2: the connected paint is compared with admission and with first audio. */
export function connectFacts(marks: CallMarksArtifact): ConnectFacts {
  const connected = optionalMark(marks, "connected_painted");
  const admitted = optionalMark(marks, "admitted");
  const audible = optionalMark(marks, "first_audible");
  const refused = namedState(marks);

  if (connected === null) {
    if (admitted === null && refused === null) {
      throw new LifecycleEvidenceError(
        "malformed-marks",
        "no connected_painted and no admitted/refused mark; the connect order is unrecorded",
      );
    }
    return {
      connectedBeforeAdmissionCount: 0,
      connectedAtMs: null,
      admittedAtMs: admitted?.tMs ?? null,
      firstAudibleAtMs: audible?.tMs ?? null,
      gapToAdmissionMs: null,
      gapToAudibleMs: null,
      detail: "the client never painted connected; nothing was claimed before admission",
    };
  }

  const admissionGap = admitted === null ? null : admitted.tMs - connected.tMs;
  const audibleGap = audible === null ? null : audible.tMs - connected.tMs;
  const beforeAdmission = admitted === null || connected.tMs < admitted.tMs;
  const detail =
    `connected painted at ${Math.round(connected.tMs)}ms; ` +
    (admitted === null
      ? "the pipeline never admitted the call"
      : `admission ${admissionGap! >= 0 ? "after" : "before"} by ` +
        `${Math.abs(admissionGap!)}ms`) +
    (audible === null
      ? "; no first audible sample was recorded"
      : `; first audible ${audibleGap! >= 0 ? "after" : "before"} by ` +
        `${Math.abs(audibleGap!)}ms`);
  return {
    connectedBeforeAdmissionCount: beforeAdmission ? 1 : 0,
    connectedAtMs: connected.tMs,
    admittedAtMs: admitted?.tMs ?? null,
    firstAudibleAtMs: audible?.tMs ?? null,
    gapToAdmissionMs: admissionGap,
    gapToAudibleMs: audibleGap,
    detail,
  };
}

export type ChimeFacts = {
  readonly count: number;
  readonly windowMs: number | null;
  readonly exactlyOne: boolean;
  readonly detail: string;
};

/** L3: exactly one chime, at the first audible sample. */
export function chimeFacts(marks: CallMarksArtifact): ChimeFacts {
  const chimes = marksNamed(marks, "chime");
  const audible = optionalMark(marks, "first_audible");
  if (audible === null) {
    throw new LifecycleEvidenceError(
      "malformed-marks",
      "no first_audible mark; the chime cannot be placed against the first sample",
    );
  }
  const first = chimes[0];
  const windowMs = first === undefined ? null : Math.abs(first.tMs - audible.tMs);
  return {
    count: chimes.length,
    windowMs,
    exactlyOne: chimes.length === 1,
    detail:
      chimes.length === 0
        ? `no chime was recorded against the first audible sample at ${Math.round(audible.tMs)}ms`
        : `${chimes.length} chime(s); the first is ${Math.round(windowMs ?? 0)}ms from the ` +
          `first audible sample at ${Math.round(audible.tMs)}ms`,
  };
}

export type FirstAudioFacts = {
  readonly gapMs: number;
  readonly connectedAtMs: number;
  readonly firstAudibleAtMs: number;
};

/** L4: the greeting's first sample after the connected paint. */
export function firstAudioFacts(marks: CallMarksArtifact): FirstAudioFacts {
  const connected = optionalMark(marks, "connected_painted");
  const audible = optionalMark(marks, "first_audible");
  if (connected === null || audible === null) {
    throw new LifecycleEvidenceError(
      "malformed-marks",
      "L4 needs both the connected paint and the first audible sample; one is missing",
    );
  }
  return {
    gapMs: audible.tMs - connected.tMs,
    connectedAtMs: connected.tMs,
    firstAudibleAtMs: audible.tMs,
  };
}

export type ConfigFacts = {
  readonly afterMicCount: number;
  readonly configAtMs: number;
  readonly micAtMs: number;
};

/** L5: the config frame must be sent before the microphone is acquired. */
export function configFacts(marks: CallMarksArtifact): ConfigFacts {
  const config = optionalMark(marks, "config_sent");
  const mic = optionalMark(marks, "microphone_acquired");
  if (config === null || mic === null) {
    throw new LifecycleEvidenceError(
      "malformed-marks",
      "L5 needs both config_sent and microphone_acquired; one is missing",
    );
  }
  return {
    afterMicCount: config.tMs > mic.tMs ? 1 : 0,
    configAtMs: config.tMs,
    micAtMs: mic.tMs,
  };
}

export type VoiceOpenFacts = {
  readonly openMs: number;
  readonly namedState: boolean;
  readonly namedStateName: string | null;
  readonly detail: string;
};

/** L6: the voice open is bounded, or the visitor is told it is unavailable. */
export function voiceOpenFacts(marks: CallMarksArtifact): VoiceOpenFacts {
  const admitted = optionalMark(marks, "admitted");
  const audible = optionalMark(marks, "first_audible");
  const state = namedState(marks);
  const stateName = state === null ? null : state.name;

  if (admitted === null) {
    if (state !== null) {
      return {
        openMs: 0,
        namedState: true,
        namedStateName: stateName,
        detail: `the call was refused before admission; the visitor saw ${stateName} at ${Math.round(state.tMs)}ms`,
      };
    }
    throw new LifecycleEvidenceError(
      "malformed-marks",
      "no admission and no named unavailable state; the voice open cannot be judged",
    );
  }
  if (audible === null) {
    if (state !== null) {
      const openMs = Math.max(0, state.tMs - admitted.tMs);
      return {
        openMs,
        namedState: true,
        namedStateName: stateName,
        detail:
          `the voice never sounded; the visitor saw ${stateName} at ` +
          `${Math.round(state.tMs)}ms (${Math.round(openMs)}ms after admission)`,
      };
    }
    throw new LifecycleEvidenceError(
      "malformed-marks",
      "the pipeline admitted the call but no first audible sample or unavailable state was recorded",
    );
  }
  const openMs = audible.tMs - admitted.tMs;
  return {
    openMs,
    namedState: false,
    namedStateName: null,
    detail:
      `admission at ${Math.round(admitted.tMs)}ms, first audible at ` +
      `${Math.round(audible.tMs)}ms (${Math.round(openMs)}ms)`,
  };
}

export type GreetingBreathFacts = {
  readonly longestRunMs: number;
  readonly runs: readonly number[];
  readonly detail: string;
};

/** L7: one human breath, or a natural split, measured on the delivered WAV. */
export function greetingBreathFacts(evidence: EvidenceBundle): GreetingBreathFacts {
  const wav = evidence.wav;
  if (!isRow(wav) || typeof wav.file !== "string") {
    throw new LifecycleEvidenceError("missing-wav", "the delivered WAV is missing for L7");
  }
  const analysis = analyseWav(wav.file);
  const runs = openingSpeechRuns(analysis);
  if (runs.length === 0) {
    throw new LifecycleEvidenceError(
      "malformed-wav",
      `the delivered WAV at ${wav.file} carries no speech; the greeting cannot be measured`,
    );
  }
  const longestRunMs = Math.max(...runs);
  return {
    longestRunMs,
    runs,
    detail:
      `${runs.length} opening run(s) (${runs.map((run) => `${Math.round(run)}ms`).join(", ")}); ` +
      `the longest is ${Math.round(longestRunMs)}ms`,
  };
}

export type ClockFacts = {
  readonly beforeAudioCount: number;
  readonly clockAtMs: number;
  readonly audibleAtMs: number;
  readonly detail: string;
};

/** L8: the talk clock starts at or after the first agent audio. */
export function clockFacts(marks: CallMarksArtifact): ClockFacts {
  const clock = optionalMark(marks, "talk_clock_start");
  const audible = optionalMark(marks, "first_audible");
  if (clock === null || audible === null) {
    throw new LifecycleEvidenceError(
      "malformed-marks",
      "L8 needs talk_clock_start and first_audible; one is missing",
    );
  }
  if (clock.detail?.restored === true) {
    throw new LifecycleEvidenceError(
      "malformed-marks",
      "the talk clock was restored on a hold return; a restored start is not a fresh clock",
    );
  }
  return {
    beforeAudioCount: clock.tMs < audible.tMs ? 1 : 0,
    clockAtMs: clock.tMs,
    audibleAtMs: audible.tMs,
    detail:
      `talk clock at ${Math.round(clock.tMs)}ms, first audible at ` +
      `${Math.round(audible.tMs)}ms (${Math.round(audible.tMs - clock.tMs)}ms apart)`,
  };
}

export type GoodbyeFacts = {
  readonly started: boolean;
  readonly playedRatio: number;
  readonly dropMs: number;
  readonly intendedMs: number | null;
  readonly playedMs: number | null;
  readonly detail: string;
};

/**
 * L9: a started goodbye is fully audible before teardown.
 *
 * The end message's `goodbye` block gives the synthesized length when the
 * service spoke one; otherwise the delivered WAV's own tail says whether the
 * last line completed or was cut. The drop is measured from the last speech
 * sample to the teardown mark, so a client that waits 2 s after the goodbye
 * cannot pass the 300 ms bar.
 */
export function goodbyeFacts(
  marks: CallMarksArtifact,
  traceRows: readonly Row[],
  end: Row,
  analysis: WavAnalysis,
): GoodbyeFacts {
  const endCall = optionalMark(marks, "end_call_received");
  const goodbyeRow = traceRowsOfType(traceRows, "turn.goodbye")[0] ?? null;
  // A caller hangup also produces an end message; only an end_call, a goodbye
  // turn or the end message's own goodbye block proves a closing line started.
  const started = endCall !== null || goodbyeRow !== null || endGoodbye(end) !== null;
  if (!started) {
    return {
      started: false,
      playedRatio: 1,
      dropMs: 0,
      intendedMs: null,
      playedMs: null,
      detail: "no goodbye was started; the caller ended the call",
    };
  }

  const goodbye = endGoodbye(end);
  const audioBytes = typeof goodbye?.audioBytes === "number" ? goodbye.audioBytes : null;
  const sampleRate = typeof goodbye?.sampleRate === "number" ? goodbye.sampleRate : null;
  const intendedMs =
    audioBytes !== null && sampleRate !== null && sampleRate > 0
      ? (audioBytes / 2 / sampleRate) * 1000
      : null;
  const playedMs = lastSpeechRunMs(analysis);
  const trailing = analysis.trailingSilenceMs ?? 0;
  const playedRatio =
    intendedMs !== null && playedMs !== null
      ? Math.max(0, Math.min(1, playedMs / intendedMs))
      : trailing >= MIN_COMPLETED_TAIL_MS
        ? 1
        : 0;

  const teardown = optionalMark(marks, "teardown");
  const captureClose = optionalMark(marks, "delivered_capture");
  const closedAt = captureClose?.tMs ?? teardown?.tMs ?? 0;
  const dropMs = teardown === null ? trailing : Math.max(0, teardown.tMs - closedAt) + trailing;

  const percentage = `${Math.round(playedRatio * 100)}%`;
  const playedText =
    intendedMs !== null && playedMs !== null
      ? `played ${Math.round(playedMs)}ms of the ${Math.round(intendedMs)}ms line (${percentage})`
      : `the last line ${trailing >= MIN_COMPLETED_TAIL_MS ? "completed" : "was cut"} (${percentage})`;
  return {
    started: true,
    playedRatio,
    dropMs,
    intendedMs,
    playedMs,
    detail: `goodbye started; ${playedText}; drop ${Math.round(dropMs)}ms after the last sample`,
  };
}

export type UnavailableFacts = {
  readonly greetingFailed: boolean;
  readonly silentEnd: boolean;
  readonly namedStateName: string | null;
  readonly detail: string;
};

/** L10: a failed greeting names an unavailable state, never a silent end. */
export function unavailableFacts(
  marks: CallMarksArtifact,
  end: Row,
): UnavailableFacts {
  const error = endError(end);
  const greeting = endGreeting(end);
  const bounds = Array.isArray(end.bounds) ? end.bounds.filter(isRow) : [];
  const failedBound = bounds.find(
    (bound) => bound.stage === "greeting" && bound.ok === false,
  );
  const greetingFailed =
    error?.stage === "greeting" ||
    failedBound !== undefined ||
    (greeting?.spoken === false && detailText(greeting.reason) !== "");
  const state = namedState(marks);
  const ended = lastMark(marks, "teardown") !== null || lastMark(marks, "end_received") !== null;
  const silentEnd = greetingFailed && state === null && ended;
  const reason =
    detailText(error?.name) ||
    detailText(greeting?.reason) ||
    (failedBound === undefined ? "" : `greeting bound ${detailText(failedBound.bound)} failed`);
  return {
    greetingFailed,
    silentEnd,
    namedStateName: state?.name ?? null,
    detail: greetingFailed
      ? `the greeting failed${reason === "" ? "" : ` (${reason})`}; ` +
        (state === null
          ? "no named unavailable state was recorded"
          : `the visitor saw ${state.name} at ${Math.round(state.tMs)}ms`)
      : "the greeting succeeded; no failed-greeting state to judge",
  };
}

export type EndDivergenceFacts = {
  readonly divergenceCount: number;
  readonly detail: string;
};

/** L11: the client drains on the message production actually sent. */
export function endDivergenceFacts(
  marks: CallMarksArtifact,
  traceRows: readonly Row[],
  end: Row,
): EndDivergenceFacts {
  const hangupRows = traceRowsOfType(traceRows, "turn.hangup");
  const hangup = hangupRows[hangupRows.length - 1] ?? null;
  const endCall = optionalMark(marks, "end_call_received");
  const endMessage = optionalMark(marks, "end_received");

  if (hangup === null) {
    return {
      divergenceCount: 0,
      detail: "the trace wrote no service hangup; the caller ended the call",
    };
  }

  const reasons: string[] = [];
  if (endMessage === null) {
    reasons.push("the service wrote an end message but the client recorded no end_received");
  }
  const hangupReason = detailText(hangup.reason);
  if (hangupReason === "end_call" && endCall === null) {
    reasons.push("the turn ended with end_call but the client never received it");
  }
  if (hangupReason !== "end_call" && hangupReason !== "" && endCall !== null) {
    reasons.push(`the client received an end_call the trace never wrote (${hangupReason})`);
  }
  if (endCall !== null && endMessage !== null && endCall.tMs > endMessage.tMs) {
    reasons.push("the client received end before end_call");
  }
  if (end === null) reasons.push("the persisted end message is missing");
  return {
    divergenceCount: reasons.length,
    detail:
      reasons.length === 0
        ? `the client received end${endCall === null ? "" : " and end_call"} in the trace's ` +
          `order (${hangupReason === "" ? "caller hangup" : hangupReason})`
        : reasons.join("; "),
  };
}

export type GreetingOnlyFacts = {
  readonly greetingOnly: boolean;
  readonly openSeconds: number | null;
  readonly unilateral: boolean;
  readonly detail: string;
};

function callerAskedToEnd(facts: ScenarioFacts | undefined): boolean {
  const last = facts?.takes[facts.takes.length - 1];
  if (last === undefined || last.text === null) return false;
  return CALLER_END_REQUEST.test(last.text);
}

function openStartMs(marks: CallMarksArtifact): number | null {
  return (
    optionalMark(marks, "admitted")?.tMs ??
    optionalMark(marks, "first_audible")?.tMs ??
    optionalMark(marks, "connected_painted")?.tMs ??
    null
  );
}

function openEndMs(marks: CallMarksArtifact): number | null {
  const mark =
    optionalMark(marks, "end_received") ??
    optionalMark(marks, "end_call_received") ??
    optionalMark(marks, "teardown") ??
    optionalMark(marks, "refused") ??
    optionalMark(marks, "start_failed");
  if (mark !== null) return mark.tMs;
  if (marks.endedAt !== null) {
    const ended = Date.parse(marks.endedAt);
    const started = Date.parse(marks.startedAt);
    if (Number.isFinite(ended) && Number.isFinite(started)) return ended - started;
  }
  return null;
}

/**
 * C1/C2: whether this was a greeting-only call, how long it stayed open, and
 * whether the ending was allowed. A caller hangup, a clock/budget stop, a
 * refusal, a leg failure and a caller's authored end request are allowed; an
 * `end_call` without any of them is the agent ending unilaterally.
 */
export function greetingOnlyFacts(
  marks: CallMarksArtifact,
  traceRows: readonly Row[],
  end: Row,
  facts: ScenarioFacts | undefined,
  scenario: string,
): GreetingOnlyFacts {
  const greetingOnly =
    (facts !== undefined && facts.takes.length === 1) || /greeting-only/i.test(scenario);
  const start = openStartMs(marks);
  const stop = openEndMs(marks);
  const openSeconds = start === null || stop === null ? null : Math.max(0, (stop - start) / 1000);

  const hangupRows = traceRowsOfType(traceRows, "turn.hangup");
  const hangup = hangupRows[hangupRows.length - 1] ?? null;
  const endedBy = detailText(end.endedBy);
  const callerEnd = callerAskedToEnd(facts);
  const allowed =
    callerEnd ||
    hangupReasonAllowsEnd(hangup) ||
    endedBy === "budget" ||
    endedBy === "refused" ||
    endedBy === "error" ||
    endedBy === "dropped" ||
    (hangup === null && endedBy === "stop");
  const unilateral = !allowed;
  const openText =
    openSeconds === null ? "open duration unrecorded" : `open ${openSeconds.toFixed(2)}s`;
  return {
    greetingOnly,
    openSeconds,
    unilateral,
    detail: greetingOnly
      ? `the call was greeting-only; ${openText}; ` +
        (unilateral
          ? `the agent ended it with ${detailText(hangup?.reason) || endedBy || "no reason"}`
          : `the ending was allowed (${detailText(hangup?.reason) || endedBy || "caller hangup"})`)
      : `not a greeting-only call; ${openText}; ` +
        (unilateral ? "the ending was not allowed" : "the ending was allowed"),
  };
}

function hangupReasonAllowsEnd(hangup: Row | null): boolean {
  if (hangup === null) return false;
  const reason = detailText(hangup.reason);
  return reason === "caller_end";
}
