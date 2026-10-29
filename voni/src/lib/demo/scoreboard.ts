/**
 * Demo scoreboard: locked golden script (ticket 02) on the ticket-01
 * plumbing, plus the dead-air gate (ticket 07), the email gate (ticket 08),
 * and the double-talk + end-call-drain gates (ticket 09). The seven beats below are
 * fixed order, fixed visitor wording, and fixed timing windows, so gap/cut
 * milliseconds stay comparable across runs. Wording reuses the existing eval
 * fragments (LONG_ASK, reachInvite, goodbyeCut, TAG=Lime 42) and the e2e
 * specs they mirror; nothing here retunes pipeline thresholds or gains —
 * the windows quote them.
 *
 * The harness measures the greeting-cut reply gap (ticket 03), the
 * filler-ignored beat (ticket 04), the real-cut-answered beat (ticket 05),
 * the overheard-aside beat (ticket 06), the silence-check-in dead-air
 * beat (ticket 07), the email-invite beat (ticket 08), and the double-talk
 * overlap plus goodbye-drain beats (ticket 09): per-beat gap
 * samples plus a reply-gap gate, resume-tail timing plus a filler-resume
 * gate, cut-to-answer timing plus a barge-in-cut gate, overheard recall
 * plus an overheard-recall gate, uncovered-silence plus a dead-air gate,
 * invite/tag counts plus an email-invite gate, audible overlap plus a
 * double-talk gate, and goodbye coverage plus an end-call-drain gate — all
 * can FAIL. Every
 * unmeasured beat reports INFO with a placeholder note, probe counts start at
 * zero, and the remaining gates report PASS/INFO (no FAIL until gating lands in later
 * tickets). Dead air gates on measured evidence supplied by the operator
 * (--dead-air-gaps / --longest-silence-ms / --check-in-at-ms): without
 * evidence the gate stays INFO, never PASS, so an unmeasured run cannot
 * claim a quiet call. Double-talk and end-call-drain likewise gate on
 * measured evidence (the runner's DOUBLE TALK / GOODBYE DRAIN and hung-up
 * lines, or the --overlap-ms / --goodbye-coverage / --goodbye-inbox-* /
 * --hang-up-delay-ms overrides): without evidence the gates stay INFO, never
 * a false FAIL or a false PASS. What this module guarantees is trustworthy plumbing —
 * one JSON artifact per run with redacted transcripts plus their hash, and
 * empty human-rating slots. Every failure that has a merged Call trace cites
 * its exact turn, and diffScoreboardArtifact compares a run with the prior
 * artifact (gate transitions, beat deltas, reply gap, drain) without ever
 * committing the artifacts.
 *
 * Gate ownership (one gate, one section below, in file order; keep gate
 * logic inside its own section — no unrelated edits in one function):
 *   reply-gap .......................... ticket 03
 *   end-of-turn ........................ ADR-0003 contract
 *   dead-air (incl. check-in once/yield) ticket 07 / 18 / 19
 *   email-invite ....................... ticket 08
 *   artifact shape (ScoreboardArtifact) shared plumbing, ticket 01
 *   overheard-recall ................... ticket 06
 *   voice registry (gate voice lock) ... ticket 02
 *   timbre-probes / accent-human ....... ticket 10
 *   double-talk + end-call-drain ....... ticket 09 (shared section: both
 *                                        read the same cut/drain timings)
 *   filler-resume ...................... ticket 04
 *   barge-in-cut ....................... ticket 05
 *   greeting-cut ....................... ticket 08
 *   fixed-clip cut measurement ......... ticket 05 (feeds barge-in-cut)
 *   skeleton: plumbing/measurements/assembly ticket 01 / 06
 *   artifact diff ...................... ticket 07
 *   streak / behavior evidence ......... ticket 29
 *   phone-checklist / talk-hold-pinned . review stubs (manual/external)
 * TODO: this module is ~5.8k lines. Split double-talk and end-call-drain
 * into separate scoreboard/gates/*.ts files, and then each gate section,
 * once a second consumer needs one; until then keep the exports stable so
 * the orchestrator and matrix never change imports. The shared section is
 * a known sequencing compromise, not an ownership rule.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getVoice, VOICE_OUTPUT_VOLUME, voicePlaybackGain } from "../agents/voices";
import { BARGE_IN_JUDGE_MS, judgeOverlap, type OverlapVerdict } from "../voice/barge-in";
import {
  END_CALL_AUDIO_GRACE_MS,
  END_CALL_DRAIN_TIMEOUT_MS,
  END_CALL_POLL_MS,
  END_CALL_SETTLE_POLLS,
  NO_WORDS_RESUME_MS,
  RESUME_WAIT_MS,
  nothingLeftUnheard,
  unheardRest,
} from "../voice/session";
import { SCOREBOARD_BUDGETS } from "./scoreboard-budgets";
import {
  BEHAVIOR_RUN_EVIDENCE_KIND,
  BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION,
  codeFingerprintFromGit,
} from "./behavior-evidence.mjs";
import { DEMO_VOICE_IDS, SILENCE_CHECK_IN_INSTRUCTIONS } from "./voni-agent";
import { DEMO_INBOX_ADDRESS } from "./email-test";
import { TAG_WORDS, containsTag, countTags } from "./test-tag";

/** The locked golden script: seven beats in fixed order (spec story 11). */
export const GOLDEN_BEATS = [
  "greeting-cut",
  "filler-ignored",
  "real-cut-answered",
  "overheard-aside",
  "silence-check-in",
  "email-invite",
  "goodbye-drain",
] as const;

export type GoldenBeat = (typeof GOLDEN_BEATS)[number];

/** The golden call is one 90-second property-inquiry Demo call. */
export const GOLDEN_VERTICAL = "property-inquiry";
export const GOLDEN_SCRIPT_BUDGET_S = SCOREBOARD_BUDGETS.goldenScriptBudgetS.value;

/**
 * One beat's timing window: the fixed bound the beat's metric must land in
 * for runs to stay comparable. `ms` windows quote the pipeline's own bars
 * (stop-over 1.5s, resume tail 2.5s, 15s check-in, 1.5s hang-up); `count`
 * windows pin exact-once behaviour (overheard recall 1/1, tag said once).
 */
export type BeatWindow = {
  metric: string;
  unit: "ms" | "count";
  min: number;
  max: number;
};

export type GoldenBeatSpec = {
  beat: GoldenBeat;
  /** Fixed visitor wording (or fixed silence) that opens the beat. */
  visitor: string;
  /** Pass predicate: what the composed call must audibly do. */
  expect: string;
  window: BeatWindow;
  /** Prior art this beat's wording is taken from. */
  source: string;
};

/**
 * The locked script. Fixed order, fixed wording, fixed windows — a new
 * voice deploys as a registry entry plus a matrix run, never a script edit.
 */
export const GOLDEN_SCRIPT: GoldenBeatSpec[] = [
  {
    beat: "greeting-cut",
    visitor: '"Wait, stop." spoken 1s into Voni\'s greeting',
    expect: "the greeting audio cuts; the cut lands inside the window",
    window: { metric: "cut-latency", unit: "ms", min: 0, max: 1500 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS greeting-cut",
  },
  {
    beat: "filler-ignored",
    visitor: '"Okaay so" (likewise "mm-hmm" / "yeah") over Voni\'s long dental-clinic answer',
    expect: "the floor never yields; if the filler briefly cuts, Voni resumes with the exact unheard tail",
    window: { metric: "resume-tail-latency", unit: "ms", min: 0, max: 2500 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS filler-over (LONG_ASK dental clinic)",
  },
  {
    beat: "real-cut-answered",
    visitor: '"Wait, stop." over the long dental-clinic answer, then the real point ("price?")',
    expect: "the cut lands and the real point is answered, never resumed past",
    window: { metric: "cut-to-answer-latency", unit: "ms", min: 0, max: 1500 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS stop-over (story 4: answered within 1500ms)",
  },
  {
    beat: "overheard-aside",
    visitor: '"We\'re a bakery, actually." while Voni holds the floor',
    expect: "the aside is marked Overheard speech and counted in the call ledger, never lost",
    window: { metric: "asides-recalled", unit: "count", min: 1, max: 1 },
    source: "scripts/eval-demo-agent.mts CLIENT_SCENARIOS over-talk (story 7)",
  },
  {
    beat: "silence-check-in",
    visitor: "(silence) 15s with no visitor speech on a free floor",
    expect: 'exactly one check-in ("Still with me? Take your time."), never over a caller who starts talking',
    window: { metric: "check-in-at-silence", unit: "ms", min: 15000, max: 18000 },
    source: "src/lib/demo/voni-agent.ts SILENCE_CHECK_IN_MS + tests/e2e/demo-races.spec.ts 15s test",
  },
  {
    beat: "email-invite",
    visitor:
      '"We run a small property agency in Lisbon." / "Most of our inquiries come by phone and email, and we miss a lot after hours." / "Sure, let\'s try something."',
    expect: 'the invite is said once with the exact Test tag "Lime 42" as one whole number — never digit by digit, never invented',
    window: { metric: "tag-mentions", unit: "count", min: 1, max: 1 },
    source:
      "scripts/eval-demo-agent.mts reachInvite + EMAIL_SCENARIOS invite-tag (TAG=Lime 42) + tests/e2e/demo-email-test.spec.ts",
  },
  {
    beat: "goodbye-drain",
    visitor: '"I want you to hang up."',
    expect: "the goodbye names hi@voni.cc, plays in full (>=80% of its speaking time), then End call closes the session",
    window: { metric: "hang-up-after-goodbye-audio", unit: "ms", min: 0, max: 1500 },
    source: "scripts/eval-demo-agent.mts hang-up-fast + goodbyeCut + tests/e2e/demo-call-quality.spec.ts goodbye drain",
  },
];

export const SCOREBOARD_SCHEMA_VERSION = 4;

export type BeatTiming = {
  /** Reply gap: visitor end-of-speech → first agent audio (p50 across runs; null until measured). */
  gapMs: number | null;
  /** Every measured reply gap for this beat, one per run (empty until measured). */
  gapSamples: number[];
  /** Barge-in cut latency (real-cut gate sets it; null until measured). */
  cutMs: number | null;
  /** Filler-resume tail: cut → resume first audio (ticket 04; null when never cut). */
  resumeMs: number | null;
  /** Goodbye drain: goodbye end → session end. Filled by the drain gate (ticket 09). */
  drainMs: number | null;
  status: "PASS" | "INFO" | "FAIL";
  note: string;
};

export type GateStatus = "PASS" | "INFO" | "FAIL";

export const GATE_STATUSES: readonly GateStatus[] = ["PASS", "INFO", "FAIL"];

export function isGateStatus(value: unknown): value is GateStatus {
  return typeof value === "string" && (GATE_STATUSES as readonly string[]).includes(value);
}

/**
 * Typed reasons a row may be non-PASS without lying about the call. The streak
 * judges these fields, never the human-readable `detail` prose: rewriting a
 * detail line can never mint a green streak.
 */
export type GateReason =
  /** Provenance row: evidence was supplied, so nothing is left to gate. */
  | "measured-evidence"
  /** Dry run: no measurements were required. */
  | "dry-run"
  /** Ticket 27: prospect-capture memory has no before/after pair yet. */
  | "unmeasured-memory";

export const GATE_REASONS: readonly GateReason[] = ["measured-evidence", "dry-run", "unmeasured-memory"];

export function isGateReason(value: unknown): value is GateReason {
  return typeof value === "string" && (GATE_REASONS as readonly string[]).includes(value);
}

export type ScoreboardGate = {
  name: string;
  status: GateStatus;
  detail: string;
  /** Typed semantics a consumer may act on; absent when the status speaks for itself. */
  reason?: GateReason;
};

/**
 * The one gate-row validator for every artifact reader (the streak and the
 * matrix used to re-implement this). Throws with the source label so a broken
 * artifact is named instead of silently skipped.
 */
export function parseGateRow(raw: unknown, source: string, index: number): ScoreboardGate {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`${source}: gate ${index} needs name/status/detail`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.detail !== "string" || !isGateStatus(record.status)) {
    throw new Error(`${source}: gate ${index} needs name/status/detail`);
  }
  if (record.reason !== undefined && !isGateReason(record.reason)) {
    throw new Error(`${source}: gate ${index} has an unknown reason "${String(record.reason)}"`);
  }
  return {
    name: record.name,
    status: record.status,
    detail: record.detail,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
  };
}

export function parseGateRows(raw: unknown, source: string): ScoreboardGate[] {
  if (!Array.isArray(raw)) throw new Error(`${source}: gates is not an array`);
  return raw.map((gate, index) => parseGateRow(gate, source, index));
}

/** The one sub-score-row validator shared by the matrix and the streak. */
export function parseSubScoreRows(raw: unknown, source: string): SubScore[] {
  if (!Array.isArray(raw)) throw new Error(`${source}: subScores is not an array`);
  return raw.map((sub, index) => {
    const record = (sub ?? {}) as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      typeof record.label !== "string" ||
      typeof record.detail !== "string" ||
      !isGateStatus(record.status) ||
      !Array.isArray(record.gates) ||
      !record.gates.every((name) => typeof name === "string")
    ) {
      throw new Error(`${source}: sub-score ${index} needs name/label/status/detail/gates`);
    }
    return {
      name: record.name as SubScore["name"],
      label: record.label,
      status: record.status,
      detail: record.detail,
      gates: record.gates as string[],
    };
  });
}

/**
 * One voice's loudness path as applied by the session: the server output level
 * and client playback gain, both registry constants, plus the native level they
 * were derived from. `status` is INFO when the native level is unmeasured — the
 * voice is reported, never failed (ticket 25).
 */
export type VoiceGainRow = {
  voice: string;
  isGate: boolean;
  /** Server `output.volume` the agent ships (one registry constant). */
  outputVolume: number;
  /** Client-side per-voice gain from the shared registry. */
  gain: number;
  /** Native integrated loudness, or null when unmeasured. */
  nativeLufs: number | null;
  /** Post-gain integrated loudness, or null when unmeasured. */
  matchedLufs: number | null;
  status: GateStatus;
  detail: string;
};

export type ScoreboardLoudness = {
  /** Shared gain reference every voice is matched to (anna). */
  referenceLufs: number;
  /** Post-gain integrated loudness, or null when the voice is unmeasured. */
  matchedLufs: number | null;
  /** Client-side per-voice gain from the registry. */
  gain: number;
  /** Server-side output level from the registry. */
  outputVolume: number;
  ok: boolean;
  detail: string;
  /** The same values for the gate voice plus every regression voice (ticket 25). */
  voices: VoiceGainRow[];
};

/** One blind ballot: timbre and accent judged 1-5 on the shared golden recording. */
export type HumanRating = {
  rater: string;
  timbre: number;
  accent: number;
};

/**
 * Blind human slots for timbre and accent (spec story 16): every ballot
 * judges the same golden recording, independently, by at least two raters.
 * `timbre`/`accent` are the running means once ballots exist, null before.
 * Human likeness stays reviewable: the gate never FAILs on taste, it only
 * records whether enough independent ears have judged.
 */
export type HumanRatings = {
  timbre: number | null;
  accent: number | null;
  recordingSha256: string | null;
  ratings: HumanRating[];
};

/** At least two independent listeners per golden recording (spec testing decisions). */
export const HUMAN_RATERS_REQUIRED = SCOREBOARD_BUDGETS.humanRatersRequired.value;

export function emptyHumanRatings(recordingSha256: string | null): HumanRatings {
  return { timbre: null, accent: null, recordingSha256, ratings: [] };
}

function mean1(values: number[]): number {
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

/**
 * File one blind ballot. Every ballot must score the same golden recording
 * (raters never judge different cuts), rate both axes as ints 1-5, and vote
 * once: a second ballot from the same rater is a protocol violation, not a
 * second opinion.
 */
export function addHumanRating(
  current: HumanRatings,
  rating: HumanRating,
  recordingSha256: string,
): HumanRatings {
  if (!rating.rater || rating.rater.trim().length === 0) {
    throw new Error("human rating needs a rater name (one ballot per independent listener)");
  }
  for (const axis of ["timbre", "accent"] as const) {
    const value = rating[axis];
    if (
      !Number.isInteger(value) ||
      value < SCOREBOARD_BUDGETS.humanRatingScaleMin.value ||
      value > SCOREBOARD_BUDGETS.humanRatingScaleMax.value
    ) {
      throw new Error(
        `${axis} rating must be an int ${SCOREBOARD_BUDGETS.humanRatingScaleMin.value}-${SCOREBOARD_BUDGETS.humanRatingScaleMax.value}, got ${value}`,
      );
    }
  }
  if (!recordingSha256) throw new Error("human rating needs the golden recording it judges");
  if (current.recordingSha256 !== null && current.recordingSha256 !== recordingSha256) {
    throw new Error("human ratings must all judge the same recording (blind, one shared cut)");
  }
  if (current.ratings.some((existing) => existing.rater === rating.rater)) {
    throw new Error(`"${rating.rater}" already rated this recording (one ballot per rater)`);
  }
  const ratings = [...current.ratings, rating];
  return {
    recordingSha256: current.recordingSha256 ?? recordingSha256,
    ratings,
    timbre: mean1(ratings.map((ballot) => ballot.timbre)),
    accent: mean1(ratings.map((ballot) => ballot.accent)),
  };
}

/**
 * Blind-ballot protocol (spec implementation decision: human likeness stays
 * reviewable). Committed alongside the harness in voni/docs/blind-human-ballots.md;
 * the artifact restates it so a stored run explains its own human slot.
 */
export const HUMAN_BALLOT_PROTOCOL =
  "blind: one shared golden recording, at least 2 independent raters, one ballot per rater (1-5 timbre and accent); auto timbre checks must pass first; taste is informational and never fails a run";

/**
 * The human slot as reviewable evidence: which recording every ballot judged,
 * how many independent raters filed one, and whether the auto timbre gate let
 * those ballots count. A ballot record without a recording is impossible by
 * construction (`addHumanRating` rejects it).
 */
export type HumanReview = {
  /** sha256 of the one golden recording every ballot judged; null until supplied. */
  recordingSha256: string | null;
  /** Independent raters who filed a ballot (one ballot per rater). */
  raterCount: number;
  requiredRaters: number;
  /** Rater names in ballot order, so the two ears are attributable. */
  raters: string[];
  /** Auto timbre gate status was PASS before ballots count. */
  autoTimbrePassed: boolean;
  /** Auto timbre passed and enough independent raters filed: ballots count. */
  counted: boolean;
  protocol: string;
};

export function humanReview(human: HumanRatings, autoTimbrePassed: boolean): HumanReview {
  const raterCount = human.ratings.length;
  return {
    recordingSha256: human.recordingSha256,
    raterCount,
    requiredRaters: HUMAN_RATERS_REQUIRED,
    raters: human.ratings.map((ballot) => ballot.rater),
    autoTimbrePassed,
    counted: autoTimbrePassed && raterCount >= HUMAN_RATERS_REQUIRED,
    protocol: HUMAN_BALLOT_PROTOCOL,
  };
}

/** Console block: the shared recording, the raters, and whether taste counted. */
export function formatHumanReview(review: HumanReview): string {
  const recording = review.recordingSha256
    ? `sha256 ${review.recordingSha256}`
    : "unbound: pass --recording <sha256> or --recording-file <path> to bind ballots to the golden recording";
  const raters = review.raters.length > 0 ? `${review.raters.join(", ")}` : "none yet";
  const gate = review.autoTimbrePassed
    ? "PASS — ballots count"
    : "not PASS — ballots reported, not counted";
  return [
    "blind human ballots (one shared recording, auto timbre first)",
    `  recording: ${recording}`,
    `  raters: ${review.raterCount}/${review.requiredRaters} (${raters})`,
    `  auto timbre: ${gate}`,
    `  protocol: ${review.protocol}`,
  ].join("\n");
}

/**
 * The accent human gate: INFO until at least two independent ballots on the
 * shared recording exist, PASS after. Auto timbre checks must pass before
 * human ratings count — ears judge likeness, never cover for defects.
 * Reviewable by design: taste never FAILs a run, it only completes the record.
 */
export function evaluateHumanGate(autoPassed: boolean, human: HumanRatings): ScoreboardGate {
  const recording = human.recordingSha256 ? ` on recording ${human.recordingSha256.slice(0, 12)}` : "";
  if (!autoPassed) {
    const ballots =
      human.ratings.length > 0
        ? ` — ${human.ratings.length} ballot${human.ratings.length === 1 ? "" : "s"} (${human.ratings
            .map((ballot) => ballot.rater)
            .join(", ")})${recording} ${human.ratings.length === 1 ? "is" : "are"} reported, not counted`
        : "";
    return {
      name: "accent-human",
      status: "INFO",
      detail: `auto timbre checks must pass before human rating counts (defects first, likeness second)${ballots}`,
    };
  }
  if (human.ratings.length < HUMAN_RATERS_REQUIRED) {
    return {
      name: "accent-human",
      status: "INFO",
      detail: `awaiting human 1-5 ratings (${human.ratings.length}/${HUMAN_RATERS_REQUIRED} independent raters on the same golden recording${recording})`,
    };
  }
  return {
    name: "accent-human",
    status: "PASS",
    detail: `timbre ${human.timbre} / accent ${human.accent} across ${human.ratings.length} independent raters on the same golden recording${recording}`,
  };
}


// ── Gate: reply-gap (ticket 03, owner: reply-gap section) ────────────────────

/**
 * Reply-gap budgets (spec stories 2–4): the Demo call feels laggy past
 * these, so the scoreboard fails. The greeting-cut beat shares the same
 * budget — cutting the greeting must answer just as fast as any turn.
 */
export const REPLY_GAP_P50_BUDGET_MS = SCOREBOARD_BUDGETS.replyGapP50Ms.value;
export const REPLY_GAP_P95_BUDGET_MS = SCOREBOARD_BUDGETS.replyGapP95Ms.value;

/** One measured reply gap, attributed to the beat that produced it (null = call-level, unattributed). */
export type ReplyGapSample = {
  beat: GoldenBeat | null;
  /** Visitor end-of-speech → first agent audio, in milliseconds. */
  gapMs: number;
  /** 1-based VONI reply turn in the merged Call trace (null when unattributed). */
  turnIndex: number | null;
  sessionId?: string;
};

export type ReplyGapSummary = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  worst: ReplyGapSample;
};

/**
 * Visitor end-of-speech → first agent audio. Null when either mark is
 * missing. Same subtraction the call-trace merger prints as `gap Nms`
 * (scripts/call-trace.mts), so the gate judges the merger's own numbers.
 */
export function replyGapMs(
  userSpeechEndedAtMs: number | null | undefined,
  agentReplyStartedAtMs: number | null | undefined,
): number | null {
  if (typeof userSpeechEndedAtMs !== "number" || typeof agentReplyStartedAtMs !== "number") return null;
  return agentReplyStartedAtMs - userSpeechEndedAtMs;
}

/** Nearest-rank percentile; same math as the session-evidence exporter. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

export type TraceGap = {
  gapMs: number;
  /** 1-based VONI reply turn in the merged Call trace excerpt. */
  turnIndex: number;
  /**
   * The call this gap came from. The suite merges one trace per scenario;
   * turn numbers restart at 1 in each, so the session keeps them distinct and
   * a FAIL can cite the exact call. Omitted means the artifact's primary trace.
   */
  sessionId?: string;
  /**
   * The beat this scenario's own trace identifies (suite routing). When set,
   * the gap is attributed to that beat directly instead of the opening-turn
   * guess; unset gaps stay call-level and are judged per turn.
   */
  beat?: GoldenBeat;
};

/**
 * Reuse the call-trace merger's per-turn `gap Nms` numbers: every VONI
 * reply line carries one. Cut turns (`CUT at …`) are skipped — an
 * interrupted reply measures cut latency (the cut ticket's metric), not
 * the reply gap. Turn numbers count every VONI reply line, so a failing
 * gate can point at the exact Call trace turn.
 */
export function parseTraceGaps(excerpt: string[]): TraceGap[] {
  const gaps: TraceGap[] = [];
  let turn = 0;
  for (const line of excerpt) {
    if (!line.includes("  VONI    ")) continue;
    turn += 1;
    if (line.includes("CUT at")) continue;
    const match = /gap (\d+)ms/.exec(line);
    if (match) gaps.push({ gapMs: Number(match[1]), turnIndex: turn });
  }
  return gaps;
}

/**
 * A Call trace turn pointer in the same numbering every gate uses: the Nth
 * VONI reply in the merged excerpt. The session id is appended when known so
 * the owner can replay the exact timeline.
 */
export function formatTraceTurn(turn: number, sessionId?: string | null): string {
  return `call trace turn ${turn}${sessionId ? ` (${sessionId})` : ""}`;
}

/**
 * Turn pointers derived from a merged Call trace excerpt: the first
 * interrupted reply (`CUT at`) and the closing reply that followed the
 * `end_call` tool row. Both are read from the excerpt's own rows — a missing
 * row yields null rather than a guessed turn.
 */
export type TraceTurnPointers = {
  /** 1-based VONI turn of the first interrupted reply, or null. */
  cutTurn: number | null;
  /** 1-based VONI turn immediately after the cut: the answer, or the resume, or null. */
  answerTurn: number | null;
  /** 1-based VONI turn of the reply after the end_call tool row, or null. */
  goodbyeTurn: number | null;
  /**
   * 1-based VONI turn after the goodbye: the ending being narrated, or null.
   * Only a merged Call trace can prove it; never a guessed turn.
   */
  narrationTurn: number | null;
};

export function traceTurnPointers(excerpt: string[]): TraceTurnPointers {
  let turn = 0;
  let cutTurn: number | null = null;
  let answerTurn: number | null = null;
  let goodbyeTurn: number | null = null;
  let narrationTurn: number | null = null;
  let endCallSeen = false;
  for (const line of excerpt) {
    if (line.includes("  TOOL    ") && /\bend_call\b/.test(line)) {
      endCallSeen = true;
      continue;
    }
    if (!line.includes("  VONI    ")) continue;
    turn += 1;
    if (cutTurn === null && line.includes("CUT at")) cutTurn = turn;
    else if (cutTurn !== null && answerTurn === null) answerTurn = turn;
    if (endCallSeen && goodbyeTurn === null) goodbyeTurn = turn;
    else if (goodbyeTurn !== null && narrationTurn === null) narrationTurn = turn;
  }
  return { cutTurn, answerTurn, goodbyeTurn, narrationTurn };
}

/**
 * The VONI turn a visitor utterance overlapped, derived by matching the
 * HEARD row's quoted words and counting the VONI replies before it. null when
 * the words do not appear or no reply was under way yet — never a guessed
 * turn.
 */
export function traceTurnForVisitorSpeech(excerpt: string[], visitorText: string): number | null {
  const needle = visitorText.trim().toLowerCase();
  if (!needle) return null;
  let turn = 0;
  let lastVoniTurn = 0;
  for (const line of excerpt) {
    if (line.includes("  VONI    ")) {
      turn += 1;
      lastVoniTurn = turn;
      continue;
    }
    if (!line.includes("  HEARD   ")) continue;
    const heard = /HEARD\s+"([^"]*)"/.exec(line)?.[1]?.trim().toLowerCase();
    if (!heard) continue;
    if (heard.includes(needle) || needle.includes(heard)) return lastVoniTurn || null;
  }
  return null;
}

/** Fold a spoken line to words so quote/punctuation drift still matches. */
function traceLineWords(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Map observed agent lines onto their 1-based VONI turn in the merged Call
 * trace. Matching is word-normalized and consumes each VONI row once, so a
 * repeated line points at the second turn it was actually spoken on. A line
 * the trace does not carry stays null: never a guessed turn.
 */
export function traceTurnsForAgentLines(excerpt: string[], lines: string[]): (number | null)[] {
  const rows: { turn: number; words: string }[] = [];
  let turn = 0;
  for (const line of excerpt) {
    if (!line.includes("  VONI    ")) continue;
    turn += 1;
    const quoted = /VONI\s+"([^"]*)"/.exec(line)?.[1] ?? "";
    const words = traceLineWords(quoted);
    if (words) rows.push({ turn, words });
  }
  const used = new Set<number>();
  return lines.map((line) => {
    const words = traceLineWords(line);
    if (!words) return null;
    const match = rows.find(
      (row) => !used.has(row.turn) && (row.words.includes(words) || words.includes(row.words)),
    );
    if (!match) return null;
    used.add(match.turn);
    return match.turn;
  });
}

/**
 * Console per-turn Reply gap report: one row per merged Call-trace VONI reply
 * that carried a `gap Nms`, plus the session id the owner replays with
 * `npm run call:trace -- <id>`. Turn numbers match parseTraceGaps (every VONI
 * reply counts, interrupted ones included), so each row maps straight onto
 * the Call trace. Derived from the merged excerpt only — no invented gaps.
 */
export function formatReplyGapReport(excerpt: string[], sessionId?: string | null): string {
  const session = sessionId ?? null;
  const lines = [
    session
      ? `reply gap per turn (${session}; turn = Nth VONI reply in the merged trace)`
      : "reply gap per turn (no trace session)",
  ];
  const gaps = parseTraceGaps(excerpt);
  if (gaps.length === 0) lines.push("  no per-turn gaps merged");
  else for (const gap of gaps) lines.push(`  turn ${gap.turnIndex}  ${gap.gapMs}ms`);
  if (session) lines.push(`  replay: npm run call:trace -- ${session}`);
  return lines.join("\n");
}

/**
 * The live eval runner prints one marker per call:
 *   `  · trace session sess_…`
 * score-demo parses the last marker so a real run can chain the Call trace
 * without the operator copying the id (an explicit --trace-session still
 * wins). Null when the runner printed none (dry run, crashed, or a scenario
 * that never opened a live session): absent evidence, never an invented id.
 */
export function extractTraceSessionId(runnerStdout: string): string | null {
  let last: string | null = null;
  for (const match of runnerStdout.matchAll(/\btrace session (sess_[A-Za-z0-9_-]+)\b/g)) {
    last = match[1];
  }
  return last;
}

/**
 * The live eval runner prints one marker per heard session ledger:
 *   `    heard ledger ["We're a bakery, actually."]`
 * These are the session's own `transcript.user` finals — the call ledger the
 * visitor's words landed in. Null when the runner printed none (dry run,
 * another scenario, or a crash): absent evidence, never an invented ledger.
 */
export function parseHeardLedgerOutput(runnerStdout: string): string[] | null {
  let last: RegExpExecArray | null = null;
  for (const match of runnerStdout.matchAll(/^\s*heard ledger (\[.*?\])\s*$/gm)) {
    last = match as RegExpExecArray;
  }
  if (!last) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows = parsed.filter((row): row is string => typeof row === "string" && row.trim().length > 0);
  return rows.length > 0 ? rows : null;
}

export type TraceAttribution = {
  /** Beat the first merged turn is attributed to, or null when unverified (call-level only). */
  beat: GoldenBeat | null;
  verified: boolean;
  note: string;
};

/**
 * Trace-gap attribution guard (review: the first merged turn was silently
 * attributed to the greeting-cut beat, misattributing any session that does
 * not open with the greeting cut). A trace that opens with the greeting cut
 * always attributes the first turn to the greeting-cut beat — an explicit
 * --trace-beat map may never override genuine greeting-opening evidence.
 * Otherwise an explicit --trace-beat map applies, and without one the first
 * turn stays call-level and the greeting-cut beat reports INFO with a
 * "trace attribution unverified" warning — never PASS.
 */
export function attributeFirstTraceGap(
  excerpt: string[],
  opts?: { beatMap?: GoldenBeat | null },
): TraceAttribution {
  const opening = excerpt.slice(0, 5).join("\n");
  const opensWithGreetingCut = /greeting-cut|greeting cut|\bgreeting\b/i.test(opening);
  if (opensWithGreetingCut) {
    const overridden =
      opts?.beatMap && opts.beatMap !== "greeting-cut"
        ? ` (explicit --trace-beat ${opts.beatMap} ignored: it never overrides a genuine greeting opening)`
        : "";
    return {
      beat: "greeting-cut",
      verified: true,
      note: `trace excerpt opens with the greeting cut: first merged turn attributed to greeting-cut${overridden}`,
    };
  }
  if (opts?.beatMap && (GOLDEN_BEATS as readonly string[]).includes(opts.beatMap)) {
    return {
      beat: opts.beatMap,
      verified: true,
      note: `explicit --trace-beat ${opts.beatMap}: first merged turn attributed to ${opts.beatMap}`,
    };
  }
  return {
    beat: null,
    verified: false,
    note: "trace attribution unverified — pass --trace-beat <beat> or ensure the trace excerpt opens with a greeting-cut marker (first turn scored call-level only)",
  };
}

export function summarizeReplyGaps(samples: ReplyGapSample[]): ReplyGapSummary | null {
  if (samples.length === 0) return null;
  const p50Ms = percentile(samples.map((s) => s.gapMs), 50) ?? 0;
  const p95Ms = percentile(samples.map((s) => s.gapMs), 95) ?? 0;
  let worst = samples[0];
  for (const sample of samples) {
    if (sample.gapMs > worst.gapMs) worst = sample;
  }
  return { count: samples.length, p50Ms, p95Ms, maxMs: worst.gapMs, worst };
}

function traceRef(sample: ReplyGapSample): string {
  const where =
    sample.turnIndex !== null && sample.turnIndex !== undefined
      ? `call trace turn ${sample.turnIndex}${sample.sessionId ? ` (${sample.sessionId})` : ""}`
      : sample.sessionId
        ? `call trace ${sample.sessionId}`
        : "call trace";
  return `${sample.beat ?? "overall"} gap ${sample.gapMs}ms at ${where}`;
}

/**
 * Enforced Reply-gap gate (spec stories 2–4): FAIL when any beat's — or
 * the whole call's — p50 exceeds 1500ms or p95 exceeds 2500ms, AND when any
 * single merged Call-trace turn's gap does. Every turn is judged on its own
 * (ticket 09): a one-sample turn scope's p50 and p95 are the gap itself, so
 * the same budgets apply unchanged and one slow turn can never hide behind a
 * fast call-level distribution. The FAIL always points at the breaching Call
 * trace turn (index + session). No samples means INFO, never FAIL: an
 * unevidenced run records plumbing, it does not cry laggy.
 */
export function replyGapGate(samples: ReplyGapSample[], traceSessionId?: string): ScoreboardGate {
  if (samples.length === 0) {
    return {
      name: "reply-gap",
      status: "INFO",
      detail: "no measured gaps yet: score a golden call with --trace-session or --gap beat=ms",
    };
  }
  const withSession = traceSessionId
    ? samples.map((s) => (s.sessionId ? s : { ...s, sessionId: traceSessionId }))
    : samples;
  const overall = summarizeReplyGaps(withSession);
  if (!overall) {
    return { name: "reply-gap", status: "INFO", detail: "no measured gaps yet" };
  }
  const scopes: { scope: string; summary: ReplyGapSummary; sample?: ReplyGapSample }[] = [
    { scope: "overall", summary: overall },
  ];
  for (const beat of GOLDEN_BEATS) {
    const beatSummary = summarizeReplyGaps(withSession.filter((s) => s.beat === beat));
    if (beatSummary) scopes.push({ scope: beat, summary: beatSummary });
  }
  // Ticket 09: each merged turn is its own scope, so the per-beat attribution
  // no longer limits the budget check to an attributed first beat. Later
  // turns are judged call-level (beat: null) with their own turn index.
  const turns = new Map<string, ReplyGapSample>();
  for (const sample of withSession) {
    if (sample.turnIndex === null || sample.turnIndex === undefined) continue;
    const key = `${sample.sessionId ?? ""}#${sample.turnIndex}`;
    if (!turns.has(key)) turns.set(key, sample);
  }
  for (const [, sample] of [...turns].sort((a, b) => {
    const bySession = (a[1].sessionId ?? "").localeCompare(b[1].sessionId ?? "");
    if (bySession !== 0) return bySession;
    return (a[1].turnIndex ?? 0) - (b[1].turnIndex ?? 0);
  })) {
    const label = sample.sessionId ? `turn ${sample.turnIndex} (${sample.sessionId})` : `turn ${sample.turnIndex}`;
    scopes.push({ scope: label, summary: summarizeReplyGaps([sample])!, sample });
  }
  type Breach = {
    scope: string;
    metric: "p50" | "p95";
    value: number;
    budget: number;
    sample?: ReplyGapSample;
  };
  const breaches: Breach[] = [];
  for (const { scope, summary, sample } of scopes) {
    // A scope with fewer than three samples has no meaningful median: one
    // slow turn would be its own p50. Judge those against the p95 budget
    // instead (the frozen 2500ms tail bar), so the p50 budget still governs
    // the overall distribution while every turn is checked for a real tail
    // breach.
    if (summary.count < 3) {
      if (summary.maxMs > REPLY_GAP_P95_BUDGET_MS) {
        breaches.push({ scope, metric: "p95", value: summary.maxMs, budget: REPLY_GAP_P95_BUDGET_MS, sample });
      }
      continue;
    }
    if (summary.p50Ms > REPLY_GAP_P50_BUDGET_MS) {
      breaches.push({ scope, metric: "p50", value: summary.p50Ms, budget: REPLY_GAP_P50_BUDGET_MS, sample });
    }
    if (summary.p95Ms > REPLY_GAP_P95_BUDGET_MS) {
      breaches.push({ scope, metric: "p95", value: summary.p95Ms, budget: REPLY_GAP_P95_BUDGET_MS, sample });
    }
  }
  if (breaches.length > 0) {
    breaches.sort((a, b) => b.value - b.budget - (a.value - a.budget));
    const first = breaches[0];
    const where = first.sample
      ? `${first.sample.beat ? `beat ${first.sample.beat}, ` : "call-level, "}${
          first.sample.turnIndex !== null && first.sample.turnIndex !== undefined
            ? formatTraceTurn(first.sample.turnIndex, first.sample.sessionId ?? null)
            : "call trace"
        }`
      : first.scope === "overall"
        ? "overall"
        : `beat ${first.scope}`;
    return {
      name: "reply-gap",
      status: "FAIL",
      detail:
        `${first.metric} ${first.value}ms > ${first.budget}ms budget (${where}; ` +
        `overall p50 ${overall.p50Ms}ms / p95 ${overall.p95Ms}ms, n=${overall.count}; ` +
        `worst ${traceRef(overall.worst)})`,
    };
  }
  return {
    name: "reply-gap",
    status: "PASS",
    detail:
      `p50 ${overall.p50Ms}ms / p95 ${overall.p95Ms}ms within ` +
      `${REPLY_GAP_P50_BUDGET_MS}/${REPLY_GAP_P95_BUDGET_MS}ms budgets (n=${overall.count})`,
  };
}

// ── Gate: end-of-turn (ADR-0003 contract, owner: end-of-turn section) ─────────

/**
 * Meaning-based end-of-turn must stay on: ANY turn_detection object —
 * even one holding only an interruption delay — switches off adaptive
 * end-of-turn (ADR-0003), measured 3.6–4.7s gaps with an object versus
 * 1.3–2.5s with none or null. Stored demo agents ship turn_detection:
 * null; the single sensitive-field exception keeps its narrow scoped
 * override only. FAIL points at the object or at the merged trace's
 * CONFIG line.
 */
export function meaningBasedEndOfTurnGate(
  agentInput: { turn_detection?: unknown } | null | undefined,
  traceExcerpt: string[] = [],
): ScoreboardGate {
  const sent =
    agentInput !== null &&
    agentInput !== undefined &&
    "turn_detection" in agentInput &&
    agentInput.turn_detection !== null &&
    agentInput.turn_detection !== undefined;
  if (sent) {
    return {
      name: "end-of-turn",
      status: "FAIL",
      detail: `turn_detection object sent (${JSON.stringify(agentInput.turn_detection)?.slice(0, 120)}): disables adaptive end-of-turn (ADR-0003); stored demo agents must send turn_detection: null`,
    };
  }
  const configLine = traceExcerpt.find((line) => line.includes("turn_detection"));
  if (configLine) {
    return {
      name: "end-of-turn",
      status: "FAIL",
      detail: `call trace shows a turn_detection CONFIG line (${configLine.trim().slice(0, 160)}): no turn-detection object may be sent on the managed session path (ADR-0003)`,
    };
  }
  return {
    name: "end-of-turn",
    status: "PASS",
    detail: "meaning-based end-of-turn preserved: no turn_detection object sent (turn_detection null)",
  };
}

// ── Gate: dead-air (ticket 07, owner: dead-air section) ───────────────────────

/** Uncovered silence longer than this reads as a dropped call. */
export const DEAD_AIR_MAX_MS = SCOREBOARD_BUDGETS.deadAirMaxMs.value;

/** Silence that must draw exactly one check-in, never over caller speech. */
export const SILENCE_CHECK_IN_TARGET_MS = SCOREBOARD_BUDGETS.silenceCheckInTargetMs.value;

/** The latest the one check-in may land inside the locked 15–18s window. */
export const SILENCE_CHECK_IN_MAX_MS = SCOREBOARD_BUDGETS.silenceCheckInMaxMs.value;

/**
 * Ticket 19: how long the check-in may hold the floor after the visitor
 * starts speaking over it. This quotes the existing barge-in cut budget
 * (`realCutMs`) instead of introducing a new threshold: yielding is the same
 * promise as cutting, measured from caller speech start to silence.
 */
export const CHECK_IN_YIELD_BUDGET_MS = SCOREBOARD_BUDGETS.realCutMs.value;

/**
 * The floor makes the check-in from this exact instruction string, so the
 * runner counts a reply.create as a check-in only when it matches — never a
 * greeting, invite, or resume that happens to mention silence.
 */
export function isSilenceCheckInInstructions(instructions: string): boolean {
  return instructions.trim() === SILENCE_CHECK_IN_INSTRUCTIONS;
}

export type DeadAirCheckIn = {
  /** Call-relative time the check-in went out (exact, for the trace citation). */
  atMs?: number;
  /** Silence elapsed when the check-in went out (audible timing). */
  atSilenceMs: number;
  /** The check-in overlapped caller speech (a cut the floor should have yielded). */
  overCaller: boolean;
  /**
   * Measured ms from the visitor's speech start to the check-in going silent
   * (ticket 19). Absent when the yield was never measured; never guessed.
   */
  yieldMs?: number;
  /** Call-trace pointer (turn/excerpt line) for failure triage. */
  trace?: string;
};

export type DeadAirEvidence = {
  /** Uncovered silences: no filler, no check-in (audible dead air). */
  gapsMs: number[];
  /** Longest silence stretch observed, covered or not; null when unmeasured. */
  longestSilenceMs: number | null;
  /** Check-ins the run produced (empty when none went out). */
  checkIns: DeadAirCheckIn[];
  /** Run-level trace pointer (e.g. the call-trace session id). */
  trace?: string;
  /**
   * The windows each gap in `gapsMs` came from (same order). A silent gap has
   * no trace row of its own, so a FAIL cites the surrounding turn plus this
   * window instead of inventing one.
   */
  gapWindows?: DeadAirSilence[];
  /** Every free-floor silence observed, covered or not (the timeline). */
  silences?: DeadAirSilence[];
};

/** One measured silence: a window with no agent audio, caller speech, or check-in. */
export type DeadAirSilence = {
  startMs: number;
  endMs: number;
  durationMs: number;
  /** What covered the window; null when nothing did (an uncovered gap). */
  coveredBy?: "agent" | "check-in" | null;
  /** Call trace pointer for the surrounding turn/window. */
  trace?: string | null;
};

/** One audible interval on a call, ms since the session opened. */
export type SilenceWindow = { startMs: number; endMs: number };

/**
 * The eval's own call timeline: what was audible, when an agent reply was
 * started or requested (coverage), and any check-ins. Derived from session
 * events, never guessed. Trailing idle after the last event is not part of
 * the window: the scenario harness stops the call, the call did not go dead.
 */
export type SilenceTimeline = {
  startedMs: number;
  endedMs: number;
  agentAudio: SilenceWindow[];
  callerSpeech: SilenceWindow[];
  /** Agent reply starts / reply.create requests: the agent is covering. */
  coverage?: { atMs: number }[];
  /** Check-ins that went out, with the silence elapsed at the sending. */
  checkIns?: { atMs: number; overCaller?: boolean; yieldMs?: number; trace?: string }[];
};

export type FreeFloorSilenceEvidence = {
  /** Uncovered silences over the dead-air window, ms. */
  gapsMs: number[];
  /** The windows behind gapsMs, same order. */
  gapWindows: DeadAirSilence[];
  /** Every silence the timeline held, covered or not. */
  silences: DeadAirSilence[];
  /** Longest silence stretch, covered or not; 0 when the call never paused. */
  longestSilenceMs: number;
  /** Check-ins with the silence elapsed when each went out. */
  checkIns: DeadAirCheckIn[];
};

function mergedBusyWindows(windows: SilenceWindow[]): SilenceWindow[] {
  const sorted = windows
    .filter((window) => Number.isFinite(window.startMs) && Number.isFinite(window.endMs) && window.endMs > window.startMs)
    .map((window) => ({ startMs: window.startMs, endMs: window.endMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: SilenceWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.startMs <= last.endMs) last.endMs = Math.max(last.endMs, window.endMs);
    else merged.push({ ...window });
  }
  return merged;
}

/**
 * Derive free-floor silences from the session timeline: contiguous stretches
 * with no agent audio and no caller speech between the first and last audible
 * event. A stretch is covered by an agent reply start / reply.create inside it
 * or by a check-in; an uncovered stretch longer than DEAD_AIR_MAX_MS is a gap.
 * The Call trace citation is added later, where the merged excerpt is known.
 */
export function deriveFreeFloorSilence(timeline: SilenceTimeline): FreeFloorSilenceEvidence {
  const busy = mergedBusyWindows([...timeline.agentAudio, ...timeline.callerSpeech]);
  const coverageAt = (timeline.coverage ?? [])
    .map((entry) => entry.atMs)
    .filter((atMs) => Number.isFinite(atMs));
  const checkInEvents = (timeline.checkIns ?? []).filter((entry) => Number.isFinite(entry.atMs));
  const silences: DeadAirSilence[] = [];
  const checkIns: DeadAirCheckIn[] = [];
  let cursor = timeline.startedMs;
  for (const window of busy) {
    if (window.startMs > cursor) silences.push(silenceWindow(cursor, window.startMs));
    cursor = Math.max(cursor, window.endMs);
  }
  if (timeline.endedMs > cursor) silences.push(silenceWindow(cursor, timeline.endedMs));

  // Coverage is matched against each stretch, not the merged busy window.
  const measured: DeadAirSilence[] = [];
  const assigned = new Set<number>();
  for (const silence of silences) {
    const insideCoverage = coverageAt.some((atMs) => atMs >= silence.startMs && atMs <= silence.endMs);
    const insideCheckIns = checkInEvents.filter((entry) => entry.atMs >= silence.startMs && entry.atMs <= silence.endMs);
    const coveredBy = insideCheckIns.length > 0 ? "check-in" : insideCoverage ? "agent" : null;
    measured.push({ ...silence, coveredBy });
    for (const checkIn of insideCheckIns) {
      assigned.add(checkInEvents.indexOf(checkIn));
      const atMs = Math.max(0, Math.round(checkIn.atMs));
      const atSilenceMs = Math.max(0, atMs - silence.startMs);
      checkIns.push({
        atMs,
        atSilenceMs,
        overCaller: checkIn.overCaller === true,
        ...(checkIn.yieldMs !== undefined ? { yieldMs: checkIn.yieldMs } : {}),
        ...(checkIn.trace ? { trace: checkIn.trace } : {}),
      });
    }
  }
  // A check-in over caller speech lands in the caller's busy window, so no
  // silence contains it. It is still the exact evidence ticket 19 gates on:
  // attach it to the free-floor stretch it interrupted, never drop it.
  checkInEvents.forEach((entry, index) => {
    if (assigned.has(index) || entry.overCaller !== true) return;
    const atMs = Math.max(0, Math.round(entry.atMs));
    const prior = [...measured].reverse().find((silence) => silence.startMs <= atMs) ?? measured[0];
    if (!prior) return;
    checkIns.push({
      atMs,
      atSilenceMs: Math.max(0, atMs - prior.startMs),
      overCaller: true,
      ...(entry.yieldMs !== undefined ? { yieldMs: entry.yieldMs } : {}),
      ...(entry.trace ? { trace: entry.trace } : {}),
    });
  });
  const gapWindows = measured.filter(
    (silence) => silence.coveredBy === null && silence.durationMs > DEAD_AIR_MAX_MS,
  );
  return {
    gapsMs: gapWindows.map((silence) => silence.durationMs),
    gapWindows,
    silences: measured,
    longestSilenceMs: measured.reduce((max, silence) => Math.max(max, silence.durationMs), 0),
    checkIns,
  };
}

function silenceWindow(startMs: number, endMs: number): DeadAirSilence {
  return {
    startMs,
    endMs,
    durationMs: Math.max(0, endMs - startMs),
    coveredBy: null,
    trace: null,
  };
}

function nonNegativeNumber(value: unknown, field: string, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${source}: ${field} must be a non-negative number`);
  }
  return value;
}

function parseSilenceWindows(value: unknown, field: string, source: string): SilenceWindow[] {
  if (!Array.isArray(value)) throw new Error(`${source}: ${field} must be an array of {startMs,endMs} windows`);
  return value.map((entry, index) => {
    const window = entry as Partial<SilenceWindow> | null;
    if (window === null || typeof window !== "object") {
      throw new Error(`${source}: ${field}[${index}] must be a {startMs,endMs} window`);
    }
    const startMs = nonNegativeNumber(window.startMs, `${field}[${index}].startMs`, source);
    const endMs = nonNegativeNumber(window.endMs, `${field}[${index}].endMs`, source);
    if (endMs < startMs) {
      throw new Error(`${source}: ${field}[${index}].startMs must not exceed endMs`);
    }
    return { startMs, endMs };
  });
}

/**
 * Validate a documented silence timeline (an evidence file or the runner's
 * machine-readable line). Bad payloads throw: the gate is either measured or
 * absent, never a guess from a broken timeline.
 */
export function parseSilenceTimeline(raw: unknown, source: string): SilenceTimeline {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: silence timeline must be a JSON object`);
  }
  const candidate = raw as Record<string, unknown>;
  const startedMs = nonNegativeNumber(candidate.startedMs, "startedMs", source);
  const endedMs = nonNegativeNumber(candidate.endedMs, "endedMs", source);
  if (endedMs < startedMs) throw new Error(`${source}: startedMs must not exceed endedMs`);
  const agentAudio = parseSilenceWindows(candidate.agentAudio, "agentAudio", source);
  const callerSpeech = parseSilenceWindows(candidate.callerSpeech, "callerSpeech", source);
  if (agentAudio.length === 0 && callerSpeech.length === 0) {
    throw new Error(`${source}: a silence timeline needs at least one audible window`);
  }
  const coverageRaw = candidate.coverage ?? [];
  if (!Array.isArray(coverageRaw)) throw new Error(`${source}: coverage must be an array of {atMs} entries`);
  const coverage = coverageRaw.map((entry, index) => {
    const atMs = nonNegativeNumber((entry as { atMs?: unknown } | null)?.atMs, `coverage[${index}].atMs`, source);
    return { atMs };
  });
  const checkInsRaw = candidate.checkIns ?? [];
  if (!Array.isArray(checkInsRaw)) throw new Error(`${source}: checkIns must be an array of {atMs} entries`);
  const checkIns = checkInsRaw.map((entry, index) => {
    const checkIn = entry as { atMs?: unknown; overCaller?: unknown; yieldMs?: unknown; trace?: unknown } | null;
    const atMs = nonNegativeNumber(checkIn?.atMs, `checkIns[${index}].atMs`, source);
    if (checkIn?.trace !== undefined && (typeof checkIn.trace !== "string" || !checkIn.trace.trim())) {
      throw new Error(`${source}: checkIns[${index}].trace must be a non-empty string`);
    }
    const yieldMs =
      checkIn?.yieldMs === undefined ? undefined : nonNegativeNumber(checkIn.yieldMs, `checkIns[${index}].yieldMs`, source);
    return {
      atMs,
      ...(checkIn?.overCaller === true ? { overCaller: true } : {}),
      ...(yieldMs !== undefined ? { yieldMs } : {}),
      ...(typeof checkIn?.trace === "string" ? { trace: checkIn.trace } : {}),
    };
  });
  return { startedMs, endedMs, agentAudio, callerSpeech, coverage, checkIns };
}

/** The live runner's machine-readable silence timeline, one line per live call. */
export const SILENCE_TIMELINE_PREFIX = "SILENCE TIMELINE ";

export type RunnerSilenceTimeline = {
  scenario: string;
  sessionId: string | null;
  timeline: SilenceTimeline;
};

/**
 * Parse the runner's `SILENCE TIMELINE {...}` line. Null when the run printed
 * none (a dry run or a raw-socket scenario). A present but malformed line
 * throws, so broken evidence never becomes a PASS.
 */
export function parseSilenceTimelineOutput(stdout: string): RunnerSilenceTimeline | null {
  let found: RunnerSilenceTimeline | null = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimStart();
    if (!line.startsWith(SILENCE_TIMELINE_PREFIX)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(SILENCE_TIMELINE_PREFIX.length));
    } catch (error) {
      throw new Error(
        `eval runner SILENCE TIMELINE line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("eval runner SILENCE TIMELINE line must be a JSON object");
    }
    const candidate = raw as { scenario?: unknown; session?: unknown };
    if (typeof candidate.scenario !== "string" || !candidate.scenario.trim()) {
      throw new Error("eval runner SILENCE TIMELINE line needs a scenario name");
    }
    const session = candidate.session ?? null;
    if (session !== null && (typeof session !== "string" || !session.trim())) {
      throw new Error("eval runner SILENCE TIMELINE line has an invalid session id");
    }
    found = {
      scenario: candidate.scenario,
      sessionId: session,
      timeline: parseSilenceTimeline(raw, "eval runner SILENCE TIMELINE line"),
    };
  }
  return found;
}

function formatWindowMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Cite the Call trace turn surrounding a silent window. A silent gap has no
 * row of its own, so this names the last turn before it and the next turn
 * after it (or only the one that exists) plus the window itself. Null when
 * the merged excerpt has no VONI row at all: the FAIL then says no turn was
 * merged rather than inventing one.
 */
export function traceSilenceRef(
  excerpt: string[],
  window: { startMs: number; endMs: number },
  sessionId?: string | null,
): string | null {
  const rows: { ms: number; turn: number }[] = [];
  let turn = 0;
  for (const line of excerpt) {
    if (!line.includes("  VONI    ")) continue;
    turn += 1;
    const match = /^\s*(\d+(?:\.\d+)?)s\s+VONI\s/.exec(line);
    if (!match) continue;
    rows.push({ ms: Math.round(Number(match[1]) * 1000), turn });
  }
  if (rows.length === 0) return null;
  const suffix = sessionId ? ` (${sessionId})` : "";
  const span = `window ${formatWindowMs(window.startMs)}–${formatWindowMs(window.endMs)}`;
  const within = rows.find((row) => row.ms >= window.startMs && row.ms < window.endMs);
  if (within) return `at call trace turn ${within.turn}${suffix}; ${span}`;
  const before = [...rows].reverse().find((row) => row.ms <= window.startMs) ?? null;
  const after = rows.find((row) => row.ms >= window.endMs) ?? null;
  if (before && after) {
    if (before.turn === after.turn) return `at call trace turn ${before.turn}${suffix}; ${span}`;
    return `between call trace turn ${before.turn} and turn ${after.turn}${suffix}; ${span}`;
  }
  if (before) return `after call trace turn ${before.turn}${suffix}; ${span}`;
  if (after) return `before call trace turn ${after.turn}${suffix}; ${span}`;
  return null;
}

/**
 * The Call trace turn a check-in became: the first VONI reply at or after the
 * request time. A check-in over caller speech is that reply, so a FAIL cites
 * the exact turn the visitor was talked over. Null when no reply started after
 * the request — the FAIL then says no turn was merged instead of guessing.
 */
export function traceCheckInRef(
  excerpt: string[],
  atMs: number,
  sessionId?: string | null,
): string | null {
  let turn = 0;
  for (const line of excerpt) {
    if (!line.includes("  VONI    ")) continue;
    turn += 1;
    const match = /^\s*(\d+(?:\.\d+)?)s\s+VONI\s/.exec(line);
    if (!match) continue;
    if (Math.round(Number(match[1]) * 1000) >= atMs) return formatTraceTurn(turn, sessionId);
  }
  return null;
}

/**
 * The dead-air gate: zero uncovered silence over 2s, and a 15s silence
 * draws exactly one check-in that never talks over the caller. The golden
 * script holds a single 15s silence beat, so exactly-once is per run.
 * Failure details carry the offending durations plus trace pointers into
 * deadAir.gapsMs and the Call trace excerpt.
 */
export function evaluateDeadAir(evidence: DeadAirEvidence): ScoreboardGate {
  const gaps = evidence.gapsMs ?? [];
  const checkIns = evidence.checkIns ?? [];
  const longest = evidence.longestSilenceMs ?? null;
  const traceSuffix = evidence.trace ? `, trace ${evidence.trace}` : "";
  const reasons: string[] = [];

  const bad = gaps
    .map((gapMs, index) => ({ gapMs, index }))
    .filter(({ gapMs }) => gapMs > DEAD_AIR_MAX_MS);
  if (bad.length > 0) {
    const windows = evidence.gapWindows ?? [];
    const aligned = windows.length === gaps.length ? windows : [];
    const described = bad.map(({ gapMs, index }) => {
      const window = aligned[index];
      const where =
        window && Number.isFinite(window.startMs) && Number.isFinite(window.endMs)
          ? ` at ${formatWindowMs(window.startMs)}–${formatWindowMs(window.endMs)}`
          : "";
      const cite = window
        ? window.trace
          ? ` (${window.trace})`
          : " (no call trace turn merged for this window; see deadAir.gapsMs)"
        : "";
      return `${gapMs}ms${where}${cite}`;
    });
    reasons.push(
      `dead air ${described.join(", ")} exceeds ${DEAD_AIR_MAX_MS}ms without filler/check-in (see deadAir.gapsMs, silence-check-in beat${traceSuffix})`,
    );
  }

  const silenceReachedCheckIn =
    (longest ?? 0) >= SILENCE_CHECK_IN_TARGET_MS ||
    gaps.some((g) => g >= SILENCE_CHECK_IN_TARGET_MS) ||
    checkIns.some((c) => c.atSilenceMs >= SILENCE_CHECK_IN_TARGET_MS);
  // Ticket 18: the count FAIL cites the Call trace turn where it went wrong.
  // Zero check-ins cite the long silence itself (a silent stretch has no row);
  // extra check-ins cite their own turn. Unmerged evidence says so explicitly
  // instead of inventing a turn.
  const noTurn = "no call trace turn merged";
  const longestSilence = [...(evidence.silences ?? [])]
    .filter((silence) => silence.durationMs >= SILENCE_CHECK_IN_TARGET_MS)
    .sort((a, b) => b.durationMs - a.durationMs)[0];
  const zeroCite = longestSilence?.trace ? `; ${longestSilence.trace}` : ` (${noTurn} for this silence)`;
  const extraCite = checkIns
    .slice(1)
    .map((c) => `${c.atSilenceMs}ms (${c.trace ?? `${noTurn} for this check-in`})`)
    .join(", ");
  if (silenceReachedCheckIn && checkIns.length !== 1) {
    const where = checkIns.length === 0 ? zeroCite : `; extra check-in ${extraCite}`;
    reasons.push(
      `15s silence drew ${checkIns.length} check-ins, want exactly one${where} (silence-check-in beat${traceSuffix})`,
    );
  }

  const early = checkIns.filter((c) => c.atSilenceMs < SILENCE_CHECK_IN_TARGET_MS);
  if (early.length > 0) {
    reasons.push(
      `check-in at ${early
        .map((c) => `${c.atSilenceMs}ms (${c.trace ?? `${noTurn} for this check-in`})`)
        .join(", ")}, before ${SILENCE_CHECK_IN_TARGET_MS}ms of silence — the floor fires once after 15s on a free floor (silence-check-in beat${traceSuffix})`,
    );
  }

  // Ticket 19: a check-in that the visitor talked over must yield inside the
  // quoted cut budget. A measured yield at or under the bar passes even
  // though it overlapped; holding past it FAILs at the check-in's turn.
  const held = checkIns.filter(
    (c) => c.yieldMs !== undefined && c.yieldMs > CHECK_IN_YIELD_BUDGET_MS,
  );
  if (held.length > 0) {
    const where = held
      .map(
        (c) =>
          `held ${c.yieldMs}ms after the visitor started speaking (${c.trace ?? `${noTurn} for this check-in`})`,
      )
      .join(", ");
    reasons.push(
      `check-in ${where} — > ${CHECK_IN_YIELD_BUDGET_MS}ms; yield like a cut (silence-check-in beat${traceSuffix})`,
    );
  }
  // An overlap with no measured yield is still the unyielding check-in that
  // must never talk over the visitor (the existing floor bar).
  const overlapping = checkIns.filter((c) => c.overCaller && c.yieldMs === undefined);
  if (overlapping.length > 0) {
    const where = overlapping
      .map((c) => `${c.atSilenceMs}ms (${c.trace ?? `${noTurn} for this check-in`})`)
      .join(", ");
    reasons.push(
      `check-in over caller speech at ${where} silence — never talk over the visitor (silence-check-in beat${traceSuffix})`,
    );
  }

  // A covered long silence is not a gap, but the report still names what
  // covered it and the surrounding Call trace turn: every long silence shows
  // coverage or a timely check-in.
  const agentCovered = (evidence.silences ?? []).filter(
    (silence) => silence.durationMs > DEAD_AIR_MAX_MS && silence.coveredBy === "agent",
  );
  const coverageNote =
    agentCovered.length > 0
      ? `; ${agentCovered.length} long silence${agentCovered.length === 1 ? "" : "s"} covered by an agent turn (${agentCovered
          .map((silence) => `${silence.durationMs}ms${silence.trace ? `: ${silence.trace}` : ""}`)
          .join(", ")})`
      : "";

  if (reasons.length > 0) {
    return { name: "dead-air", status: "FAIL", detail: reasons.join("; ") };
  }
  if (silenceReachedCheckIn) {
    const yielded = checkIns.find((c) => c.yieldMs !== undefined);
    const yieldNote = yielded ? `; yielded in ${yielded.yieldMs}ms when the visitor spoke` : ", never over the caller";
    return {
      name: "dead-air",
      status: "PASS",
      detail: `no dead air over ${DEAD_AIR_MAX_MS}ms; 15s silence drew exactly one check-in at ${checkIns[0].atSilenceMs}ms${yieldNote}${coverageNote}`,
    };
  }
  const max = gaps.length > 0 ? Math.max(...gaps) : 0;
  return {
    name: "dead-air",
    status: "PASS",
    detail: `no dead air over ${DEAD_AIR_MAX_MS}ms across ${gaps.length} gaps (max ${max}ms); no 15s silence stretch${coverageNote}`,
  };
}

// ── Gate: email-invite (ticket 08, owner: email section) ─────────────────────

/**
 * Prospect-capture beat (ticket 08): the Email invite plus Test tag behaves
 * exactly once and survives hold/reload. Wording reuses the eval
 * invite-tag/forgot-tag/free-gate/returning checks (TAG Lime 42, no
 * digit-split, no invented tag, normalizeClaim andres@, hi@voni.cc) and the
 * e2e demo-email-test expectations (10s invite, chip mailto, clipboard,
 * localStorage voni:test-tag, poll-once, personal-address once,
 * returning-greeting, talk-clock 4->6min), with Call memory in sessionStorage
 * and hold/flap/return resume. All inputs are external observables: what Voni
 * audibly said, how many times the show tool ran, how many times the chip
 * showed, which tokens survived.
 */
export const EMAIL_INVITE_TAG = "Lime 42";

export type EmailInviteEvidence = {
  /** Gate tag; defaults to EMAIL_INVITE_TAG (the locked call tag). */
  tag?: string;
  /** What Voni audibly said (agent transcripts, one entry per turn). */
  agentLines: string[];
  /** Every contact-chip show: the inbox address plus the tag on the chip. */
  chipShows: { address: string; tag: string }[];
  /** How many times show_test_address ran (the invite). */
  showToolCalls: number;
  /** localStorage voni:test-tag before/after a Hold return or reload. */
  tagTokenBefore?: string | null;
  tagTokenAfter?: string | null;
  /** Call memory sessionStorage voni:demo-call: was the test invited before/after? */
  memoryInvitedBefore?: boolean;
  memoryInvitedAfter?: boolean;
  /** Same call across the return: the call token before/after. */
  callTokenBefore?: string | null;
  callTokenAfter?: string | null;
  /** The sender matched an earlier tag (other device) or carried one (callback). */
  returning?: boolean;
  /** Externally observed greeting as returning (again/back/good-to-hear/earlier-call). */
  greetedAsReturning?: boolean;
  /** Personal-address sender when the Work-email gate applies; null otherwise. */
  freeAddress?: string | null;
  /**
   * Call trace pointer for each agentLines entry (parallel array). A FAIL
   * about a spoken line cites the matching turn; null means the trace did
   * not merge that line, so the detail says so instead of guessing.
   */
  lineTurns?: (string | null)[];
  /** Call trace turn where the contact chip showed (chip failures cite it). */
  chipTraceTurn?: string | null;
  /**
   * Call trace turn where the Test tag was lost on Hold return. Omitted, the
   * scorer derives the later tag mention; null means no turn was merged and
   * the FAIL says so instead of guessing.
   */
  memoryTraceTurn?: string | null;
};

export type EmailInviteResult = {
  tag: string;
  tagMentions: number;
  digitSplit: boolean;
  inventedTags: string[];
  strayAddresses: string[];
  workEmailGateMentions: number;
  chipShows: number;
  memoryPersists: boolean | null;
  /** The turn a lost-tag FAIL cites; null when the trace did not merge one. */
  memoryTraceTurn: string | null;
  returningOk: boolean | null;
  showToolCalls: number;
  status: "PASS" | "FAIL";
  detail: string;
};

/** How many agent turns carry the tag (typed any way: lime42, Lime-42, Lime 42). */
export function countTagMentions(lines: string[], tag: string = EMAIL_INVITE_TAG): number {
  return lines.filter((line) => containsTag(line, tag)).length;
}

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** Spoken digit by digit ("Lime 4 2", "Lime four two") instead of one whole number ("Lime 42"). */
export function hasDigitSplitTag(lines: string[], tag: string = EMAIL_INVITE_TAG): boolean {
  const [word = "", digits = ""] = tag.split(" ");
  if (!word || !digits) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const digitChars = digits.split("");
  const digitSplit = new RegExp(`\\b${esc(word)}\\s+${digitChars.map((d) => esc(d)).join("\\s*[\\- ]\\s*")}\\b`, "i");
  const wordSplit = new RegExp(
    `\\b${esc(word)}\\s+${digitChars.map((d) => DIGIT_WORDS[Number(d)] ?? esc(d)).join("\\s+[\\- ]?\\s*")}\\b`,
    "i",
  );
  return lines.some((line) => {
    // A whole "lime 42" is not a split; a spaced "lime 4 2" is.
    if (containsTag(line, tag) && !digitSplit.test(line) && !wordSplit.test(line)) return false;
    return digitSplit.test(line) || wordSplit.test(line);
  });
}

/**
 * Any "Word digits" in a tag/subject line that is not this call's tag was
 * made up (eval invite-tag: any tag-like match outside the gate word, digits
 * other than a bare 0, in a line about the tag or subject).
 */
export function findInventedTags(lines: string[], tag: string = EMAIL_INVITE_TAG): string[] {
  const word = (tag.split(" ")[0] ?? "").toLowerCase();
  const gateWord = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const shape = /\b([A-Za-z]+)[ -]?(\d{1,3})\b/g;
  const found: string[] = [];
  for (const line of lines) {
    if (!/tag|subject/i.test(line)) continue;
    for (const m of line.matchAll(shape)) {
      if (!gateWord.test(m[1]) && m[2] !== "0") found.push(m[0]);
    }
  }
  return found;
}

/** The team inbox the closing line names (said aloud, never spelled). */
export const TEAM_INBOX_ADDRESS = "hi@voni.cc";

/**
 * Whether a closing line names the team inbox as spoken ("hi at voni dot
 * c c", or the written form a transcript may render). The demo test inbox
 * (`test@voni.cc`) and a vague "the team's there" do not count.
 */
export function namesTeamInbox(text: string): boolean {
  return /\bhi\s*(?:@|\bat\b)\s*voni\s*(?:\.|\bdot\b)\s*c[\s.,-]*c\b/i.test(text);
}

/**
 * Any spoken email address other than the team's hi@voni.cc (eval
 * strayAddress: pilot/voni.ai/@ plus the at/dot spoken form, after removing
 * the goodbye's hi@voni.cc). The invite never says or spells the inbox
 * address: it is on the visitor's screen.
 */
export function findStrayAddresses(lines: string[]): string[] {
  const spoken = /\b[a-z0-9._-]+\s*(?:@|\bat\b)\s*[a-z0-9-]+\s*(?:\.|\bdot\b)\s*[a-z]{2,}/i;
  const found: string[] = [];
  for (const line of lines) {
    const withoutTeam = line
      .replace(/hi@voni\.cc/gi, "")
      .replace(/hi\s+at\s+voni\s+dot\s+c\s*c/gi, "");
    if (/pilot|voni\.ai|@/i.test(withoutTeam) || spoken.test(withoutTeam)) found.push(line.trim());
  }
  return found;
}

/** Work-email gate lines ("that's a personal address … I need your work one"). */
export function countWorkEmailGate(lines: string[]): number {
  return lines.filter((line) => /personal address/i.test(line) && /work (one|email)/i.test(line)).length;
}

/**
 * Whether Call memory kept the invite, tag token, and call token across a
 * Hold return or reload. Only a complete before/after pair measures memory;
 * a lone before or after is unmeasured (null), never a guess. Null when no
 * pair was supplied.
 */
export function persistsEmailAcrossMemory(evidence: EmailInviteEvidence): boolean | null {
  type MemoryPair = { before: unknown; after: unknown };
  /** A readable before and after of one signal; null when either side is absent. */
  const pair = (before: unknown, after: unknown): MemoryPair | null =>
    before !== undefined && before !== null && after !== undefined ? { before, after } : null;
  const pairs = [
    pair(evidence.memoryInvitedBefore, evidence.memoryInvitedAfter),
    pair(evidence.tagTokenBefore, evidence.tagTokenAfter),
    pair(evidence.callTokenBefore, evidence.callTokenAfter),
  ].filter((entry): entry is MemoryPair => entry !== null);
  if (pairs.length === 0) return null;
  // A single measured mismatch is a lost tag; every measured pair must agree.
  return pairs.every(({ before, after }) => before === after);
}

export function evaluateEmailInvite(evidence: EmailInviteEvidence): EmailInviteResult {
  const tag = evidence.tag ?? EMAIL_INVITE_TAG;
  const agentLines = evidence.agentLines ?? [];
  const chipShows = evidence.chipShows ?? [];
  const showToolCalls = evidence.showToolCalls ?? 0;
  const returning = evidence.returning ?? false;
  const greeted = evidence.greetedAsReturning ?? false;
  const freeAddress = evidence.freeAddress ?? null;
  const lineTurns = evidence.lineTurns;

  const tagMentions = countTagMentions(agentLines, tag);
  const tagLineIndexes = agentLines.flatMap((line, index) => (containsTag(line, tag) ? [index] : []));
  const digitSplitIndex = agentLines.findIndex((line) => hasDigitSplitTag([line], tag));
  const inventedIndex = agentLines.findIndex((line) => findInventedTags([line], tag).length > 0);
  const strayIndex = agentLines.findIndex((line) => findStrayAddresses([line]).length > 0);
  const digitSplit = digitSplitIndex >= 0;
  const inventedTags = findInventedTags(agentLines, tag);
  const strayAddresses = findStrayAddresses(agentLines);
  const workEmailGateMentions = countWorkEmailGate(agentLines);
  const memoryPersists = persistsEmailAcrossMemory(evidence);
  const returningOk = returning ? greeted && showToolCalls <= 1 : null;
  // Every invite/chip FAIL names the moment: the line's own merged turn, the
  // chip's turn, or an explicit "not merged" so triage never guesses.
  const citeLine = (index: number | undefined): string => {
    const turn = index !== undefined && index >= 0 ? lineTurns?.[index] : null;
    return turn ? ` at ${turn}` : " (no Call trace turn merged)";
  };
  const citeChip = (): string => (evidence.chipTraceTurn ? ` at ${evidence.chipTraceTurn}` : " (no Call trace turn merged)");
  // The tag was lost on return: the evidence's own memory turn, else the later
  // tag mention (the repeat ask after the return), else an explicit "no turn".
  const memoryTurn =
    evidence.memoryTraceTurn !== undefined
      ? evidence.memoryTraceTurn
      : tagLineIndexes.length > 1
        ? (lineTurns?.[tagLineIndexes[1]] ?? null)
        : null;
  const citeMemory = (): string => (memoryTurn ? ` at ${memoryTurn}` : " (no Call trace turn merged)");

  const fails: string[] = [];
  if (showToolCalls > 1) fails.push(`invited ${showToolCalls} times${citeLine(tagLineIndexes[0])}`);
  if (!returning && showToolCalls !== 1) {
    fails.push(
      showToolCalls === 0
        ? `never invited the email test${evidence.chipTraceTurn ? ` at ${evidence.chipTraceTurn}` : ""}`
        : `invited ${showToolCalls} times${citeLine(tagLineIndexes[0])}`,
    );
  }
  if (returning && !greeted) fails.push("returning sender not greeted");
  if (returning && showToolCalls > 1) fails.push("second invite for a returning sender");

  if (showToolCalls === 0) {
    // Callback: the carried tag was checked at connect, no second invite.
    if (tagMentions !== 0) {
      fails.push(`said the tag ${tagMentions} times without an invite${citeLine(tagLineIndexes[0])}`);
    }
    if (chipShows.length !== 0) fails.push(`chip showed ${chipShows.length} times without an invite${citeChip()}`);
  } else {
    if (tagMentions !== 1) {
      fails.push(
        tagMentions === 0
          ? `never said the tag${citeLine(undefined)}`
          : `said the tag ${tagMentions} times${citeLine(tagLineIndexes[1])}`,
      );
    }
    if (digitSplit) fails.push(`said the tag digit by digit${citeLine(digitSplitIndex)}`);
    if (inventedTags.length > 0) fails.push(`invented a tag: "${inventedTags[0]}"${citeLine(inventedIndex)}`);
    if (strayAddresses.length > 0) {
      fails.push(`spoke an address: "${strayAddresses[0].slice(0, 80)}"${citeLine(strayIndex)}`);
    }
    if (chipShows.length !== 1) {
      fails.push(
        chipShows.length === 0
          ? `chip never showed${citeLine(tagLineIndexes[0])}`
          : `chip showed ${chipShows.length} times${citeChip()}`,
      );
    } else {
      if (chipShows[0].address !== DEMO_INBOX_ADDRESS) {
        fails.push(`chip showed ${chipShows[0].address}${citeChip()}`);
      }
      if (chipShows[0].tag !== tag) fails.push(`chip tag does not match the call tag${citeChip()}`);
    }
    if (freeAddress != null) {
      if (workEmailGateMentions !== 1) {
        fails.push(workEmailGateMentions === 0 ? "personal address without the work-email gate" : "work-email gate said twice");
      }
    } else if (workEmailGateMentions !== 0) {
      fails.push("work-email gate without a personal address");
    }
  }
  if (memoryPersists === false) fails.push(`tag did not persist across Hold return/reload${citeMemory()}`);

  const status = fails.length === 0 ? "PASS" : "FAIL";
  // Unmeasured memory (no hold/reload evidence) is not a pass: the gate
  // reports it separately as INFO (see emailInviteGate), so the PASS detail
  // never claims memory was kept.
  const memoryNote =
    memoryPersists === true ? ", memory kept" : memoryPersists === null ? ", memory unmeasured" : "";
  return {
    tag,
    tagMentions,
    digitSplit,
    inventedTags,
    strayAddresses,
    workEmailGateMentions,
    chipShows: chipShows.length,
    memoryPersists,
    memoryTraceTurn: memoryTurn,
    returningOk,
    showToolCalls,
    status,
    detail: status === "PASS" ? `tag said once (${tag}), chip once${memoryNote}` : fails.join("; "),
  };
}

export function emailInviteGate(result: EmailInviteResult): ScoreboardGate {
  // Unmeasured memory (no hold/reload evidence) is INFO, never PASS: only
  // a before/after pair that both show the tag persisted counts as kept,
  // and only a mismatch FAILs.
  if (result.status === "PASS" && result.memoryPersists === null) {
    return {
      name: "email-invite",
      status: "INFO",
      reason: "unmeasured-memory",
      detail: "unmeasured - provide a before/after Hold return pair",
    };
  }
  return {
    name: "email-invite",
    status: result.status,
    detail: result.detail,
  };
}

/** The final runner line carrying invite evidence, `EMAIL INVITE {...}`. */
export const EMAIL_INVITE_EVIDENCE_PREFIX = "EMAIL INVITE ";

/**
 * Raw invite evidence as the runner or an evidence file carries it: observed
 * counts plus the session's own turn numbers (1-based agent replies, the same
 * numbering as the merged Call trace's VONI rows).
 */
export type EmailInviteEvidenceFile = {
  tag?: string;
  agentLines: string[];
  lineTurns?: (number | string | null)[];
  chipShows: { address: string; tag: string }[];
  showToolCalls: number;
  chipTurn?: number | string | null;
  /** Call trace turn where the tag was lost on Hold return (optional; else derived). */
  memoryTurn?: number | string | null;
  traceSession?: string | null;
  memoryInvitedBefore?: boolean;
  memoryInvitedAfter?: boolean;
  tagTokenBefore?: string | null;
  tagTokenAfter?: string | null;
  callTokenBefore?: string | null;
  callTokenAfter?: string | null;
  returning?: boolean;
  greetedAsReturning?: boolean;
  freeAddress?: string | null;
};

/**
 * Validate invite evidence from the runner or `--email-json`. A malformed
 * evidence file is a harness error (no artifact), never silently ignored.
 * `requireSession` is on for hand-supplied files: without a Call trace
 * session a FAIL could not cite its turn.
 */
export function validateEmailInviteEvidence(
  raw: unknown,
  source: string,
  options: { requireSession: boolean },
): EmailInviteEvidenceFile {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("must be an object with the invite evidence");
  }
  const record = raw as Record<string, unknown>;
  if (record.tag !== undefined && typeof record.tag !== "string") fail("tag must be a string");
  if (!Array.isArray(record.agentLines) || record.agentLines.some((line) => typeof line !== "string")) {
    fail("agentLines must be an array of strings");
  }
  const agentLines = record.agentLines as string[];
  if (record.lineTurns !== undefined) {
    if (!Array.isArray(record.lineTurns) || record.lineTurns.length !== agentLines.length) {
      fail("lineTurns must be an array parallel to agentLines");
    }
    (record.lineTurns as unknown[]).forEach((turn, index) => {
      if (turn !== null && typeof turn !== "number" && typeof turn !== "string") {
        fail(`lineTurns[${index}] must be a turn number, a formatted turn, or null`);
      }
    });
  }
  if (!Array.isArray(record.chipShows)) fail("chipShows must be an array");
  const chipShows = (record.chipShows as unknown[]).map((show, index) => {
    if (show === null || typeof show !== "object") fail(`chipShows[${index}] must be an object`);
    const entry = show as Record<string, unknown>;
    if (typeof entry.address !== "string" || typeof entry.tag !== "string") {
      fail(`chipShows[${index}] needs a string address and tag`);
    }
    return { address: entry.address as string, tag: entry.tag as string };
  });
  if (
    typeof record.showToolCalls !== "number" ||
    !Number.isInteger(record.showToolCalls) ||
    record.showToolCalls < 0
  ) {
    fail("showToolCalls must be a non-negative integer");
  }
  if (
    record.chipTurn !== undefined &&
    record.chipTurn !== null &&
    typeof record.chipTurn !== "number" &&
    typeof record.chipTurn !== "string"
  ) {
    fail("chipTurn must be a turn number, a formatted turn, or null");
  }
  if (
    record.memoryTurn !== undefined &&
    record.memoryTurn !== null &&
    typeof record.memoryTurn !== "number" &&
    typeof record.memoryTurn !== "string"
  ) {
    fail("memoryTurn must be a turn number, a formatted turn, or null");
  }
  const traceSession = record.traceSession;
  if (traceSession !== undefined && traceSession !== null) {
    if (typeof traceSession !== "string" || !/^sess_[A-Za-z0-9_-]+$/.test(traceSession)) {
      fail("traceSession must be a session id like sess_abc");
    }
  }
  if (options.requireSession && (typeof traceSession !== "string" || traceSession.length === 0)) {
    fail("needs traceSession (the Call trace session id) so every FAIL can cite its turn");
  }
  // A hand-supplied file must carry a turn for everything it asserts: the
  // runner derives these itself, a browser probe has the session timeline.
  if (options.requireSession && agentLines.length > 0) {
    const turns = record.lineTurns as unknown[] | undefined;
    if (!Array.isArray(turns) || turns.some((turn) => turn === null)) {
      fail("needs lineTurns (one Call trace turn per agent line) so every spoken FAIL cites its turn");
    }
  }
  if (options.requireSession && chipShows.length > 0 && (record.chipTurn === undefined || record.chipTurn === null)) {
    fail("needs chipTurn (the Call trace turn where the chip showed) so a chip FAIL cites its turn");
  }
  const booleanFields = ["memoryInvitedBefore", "memoryInvitedAfter", "returning", "greetedAsReturning"] as const;
  for (const field of booleanFields) {
    if (record[field] !== undefined && typeof record[field] !== "boolean") fail(`${field} must be a boolean`);
  }
  const nullableStringFields = ["tagTokenBefore", "tagTokenAfter", "callTokenBefore", "callTokenAfter", "freeAddress"] as const;
  for (const field of nullableStringFields) {
    const value = record[field];
    if (value !== undefined && value !== null && typeof value !== "string") fail(`${field} must be a string or null`);
  }
  return {
    ...(record.tag !== undefined ? { tag: record.tag as string } : {}),
    agentLines,
    ...(record.lineTurns !== undefined
      ? { lineTurns: record.lineTurns as (number | string | null)[] }
      : {}),
    chipShows,
    showToolCalls: record.showToolCalls as number,
    ...(record.chipTurn !== undefined ? { chipTurn: record.chipTurn as number | string | null } : {}),
    ...(record.memoryTurn !== undefined ? { memoryTurn: record.memoryTurn as number | string | null } : {}),
    ...(traceSession !== undefined ? { traceSession: traceSession as string | null } : {}),
    ...(record.memoryInvitedBefore !== undefined
      ? { memoryInvitedBefore: record.memoryInvitedBefore as boolean }
      : {}),
    ...(record.memoryInvitedAfter !== undefined
      ? { memoryInvitedAfter: record.memoryInvitedAfter as boolean }
      : {}),
    ...(record.tagTokenBefore !== undefined ? { tagTokenBefore: record.tagTokenBefore as string | null } : {}),
    ...(record.tagTokenAfter !== undefined ? { tagTokenAfter: record.tagTokenAfter as string | null } : {}),
    ...(record.callTokenBefore !== undefined ? { callTokenBefore: record.callTokenBefore as string | null } : {}),
    ...(record.callTokenAfter !== undefined ? { callTokenAfter: record.callTokenAfter as string | null } : {}),
    ...(record.returning !== undefined ? { returning: record.returning as boolean } : {}),
    ...(record.greetedAsReturning !== undefined
      ? { greetedAsReturning: record.greetedAsReturning as boolean }
      : {}),
    ...(record.freeAddress !== undefined ? { freeAddress: record.freeAddress as string | null } : {}),
  };
}

/**
 * Parse the eval runner's last `EMAIL INVITE {...}` line. Null when the
 * runner printed no invite evidence (a dry run or another scenario); a
 * malformed line is a harness error, never ignored.
 */
export function parseEmailInviteOutput(stdout: string): EmailInviteEvidenceFile | null {
  let found: EmailInviteEvidenceFile | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(EMAIL_INVITE_EVIDENCE_PREFIX)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(EMAIL_INVITE_EVIDENCE_PREFIX.length));
    } catch (error) {
      throw new Error(
        `eval runner EMAIL INVITE line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    found = validateEmailInviteEvidence(raw, "eval runner EMAIL INVITE", { requireSession: false });
  }
  return found;
}

/** Score the email-invite beat and gate from external evidence, leaving every other beat alone. */
export function applyEmailInvite(artifact: ScoreboardArtifact, evidence: EmailInviteEvidence): ScoreboardArtifact {
  const result = evaluateEmailInvite(evidence);
  const gate = emailInviteGate(result);
  const gates = artifact.gates.some((g) => g.name === "email-invite")
    ? artifact.gates.map((g) => (g.name === "email-invite" ? gate : g))
    : [...artifact.gates, gate];
  return {
    ...artifact,
    emailInvite: result,
    beats: {
      ...artifact.beats,
      "email-invite": {
        gapMs: null,
        gapSamples: [],
        cutMs: null,
        resumeMs: null,
        drainMs: null,
        status: gate.status === "FAIL" ? "FAIL" : gate.status === "INFO" ? "INFO" : "PASS",
        note: gate.detail,
      } satisfies BeatTiming,
    },
    gates,
    subScores: buildSubScores(gates),
  };
}


export type ScoreboardArtifact = {
  schemaVersion: typeof SCOREBOARD_SCHEMA_VERSION;
  recordedAt: string;
  /** Gate voice, resolved through the shared voice registry. */
  voice: string;
  runs: number;
  /** The locked golden script this run scores against (fixed order/wording/windows). */
  goldenScript: {
    vertical: typeof GOLDEN_VERTICAL;
    budgetS: typeof GOLDEN_SCRIPT_BUDGET_S;
    beats: GoldenBeatSpec[];
  };
  /** Non-gate demo voices: regression-only, never gating (spec story 14). */
  regressionVoices: string[];
  beats: Record<GoldenBeat, BeatTiming>;
  /** Whole-call Reply gap: p50/p95 across every measured beat sample (nulls until measured). */
  replyGap: { p50Ms: number | null; p95Ms: number | null; samples: number };
  overheard: {
    recalled: number;
    total: number;
    byBeat: Record<GoldenBeat, { recalled: number; total: number }>;
    asides: OverheardAside[];
  };
  doubleTalk: { overlapMs: number[]; maxMs: number | null };
  /**
   * End-call drain evidence (ticket 09): how much of the closing line played
   * and how long after its audio ended the session closed. Nulls mean the
   * goodbye was never measured — the gate reports INFO, never a false FAIL.
   */
  endCallDrain: {
    /** Played speaking time / expected speaking time (eval bye-audio bar: >= 0.8). */
    goodbyeCoverage: number | null;
    /** Session end minus goodbye audio end; negative means hung up early. */
    hangUpDelayMs: number | null;
    /** The model spoke again after end_call instead of letting the line close. */
    narratedEnding: boolean;
    /** The closing line named the team inbox; null when never measured. */
    inboxNamed: boolean | null;
    /** The caller asked to end and no closing-line audio played afterwards. */
    missingGoodbye?: boolean;
  };
  deadAir: {
    gapsMs: number[];
    maxMs: number | null;
    checkIns: DeadAirCheckIn[];
    longestSilenceMs: number | null;
    gapWindows: DeadAirSilence[];
    silences: DeadAirSilence[];
  };
  probes: TimbreProbes;
  /** Shared gain reference the gate voice is matched to, with its post-gain level. */
  loudness: ScoreboardLoudness;
  transcripts: { sha256: string; redacted: string[] };
  humanRatings: HumanRatings;
  /** Blind-ballot binding as reviewable evidence: recording sha256, raters, protocol (ticket 28). */
  humanReview: HumanReview;
  gates: ScoreboardGate[];
  /** Five human-likeness sub-scores rolled up from the gates (review; no new thresholds). */
  subScores: SubScore[];
  /** Prospect-capture beat: invite/tag counts, chip-once, memory persistence (ticket 08). Null until evidence lands. */
  emailInvite: EmailInviteResult | null;
  evalRunner: {
    scenario: string;
    passed: boolean | null;
    /** ok: runner finished; failed: harness break; skipped: dry run. */
    status: "ok" | "failed" | "skipped";
    /** Why the harness broke; null when the runner finished or the run was dry. */
    breakReason: RunnerBreakReason | null;
    exitCode: number | null;
    durationMs: number;
    /** Wall-clock playout per live scenario run: reported, never folded into a gate. */
    timings: {
      scenarioRuns: RunnerPlayout[];
    };
    rawSha256: string;
  };
  /**
   * Fixed caller clips the live runner streamed, pinned by words + audio
   * fingerprint (ticket 05). A run whose clip changed is not comparable with
   * the prior run's cut latency, so the barge-in-cut gate refuses to green.
   * Optional: artifacts written before ticket 10 have no such evidence.
   */
  callerClips?: CallerClipFingerprint[];
  /** Merged Call trace excerpt for a finished real-call session (via --trace-session). */
  callTrace?: {
    sessionId: string;
    excerptSha256: string;
    excerpt: string[];
    /**
     * Every scenario call the suite merged gaps from (one entry per session).
     * Turn numbers restart in each, so the session id is part of the pointer.
     */
    sessions?: { sessionId: string; excerptSha256: string; excerpt: string[] }[];
  } | null;
  /** Unique id for this run (reproducibility: three consecutive greens on the reference desktop). */
  runId: string;
  /**
   * Exact code the run executed on (git HEAD + dirty hash, ticket 29). Null
   * when git could not report it — the streak then refuses to claim comparable
   * greens instead of pretending a clean tree.
   */
  codeFingerprint: CodeFingerprint | null;
  /**
   * Quarantined beats, by name, excluded from gating while flaky (empty
   * stub: quarantine by beat name, never by loosening thresholds).
   */
  quarantinedBeats: GoldenBeat[];
};

// ── Gate: overheard-recall (ticket 06, owner: overheard section) ─────────────

/**
 * Overheard speech: visitor words spoken while Voni holds the floor.
 * Marked in the live caption ("· overheard") and counted in the call
 * ledger (session transcripts) even when never answered — nothing said
 * while Voni speaks may vanish (spec story 7).
 */
export type OverheardKind = "steering" | "filler" | "content";

export type OverheardHandling = "answered" | "resumed-from" | "heard-only" | "lost";

export type OverheardAside = {
  /** Golden beat the aside belongs to (usually overheard-aside). */
  beat: GoldenBeat;
  /** Visitor words spoken while Voni held the floor. */
  text: string;
  /** What Voni was saying when the aside landed (overlap context). */
  agentText?: string;
  /** Live caption marked it Overheard speech (voice-call overheard row). */
  markedOverheard: boolean;
  /** Counted in the call ledger (session transcript / trace HEARD row). */
  inLedger: boolean;
  /** How the turn resolved: answered, resumed-from, heard-only, or lost. */
  handling: OverheardHandling;
  /** Call-trace pointer, e.g. `sess_abc :: 12.34s HEARD "..."`. */
  tracePointer: string;
};

export type OverheardFailure = { aside: OverheardAside; reason: string };

/**
 * Independent evidence for the two things an aside must prove (spec story 7):
 * the live caption marked it and the call ledger counted it. Both come from
 * the run itself; absent evidence is recorded as absent, never assumed.
 */
export type OverheardTraceEvidence = {
  /**
   * Session transcript ledger (`transcript.user` finals the runner heard).
   * When supplied, an aside absent from it was never counted, even if the
   * merged trace shows it.
   */
  ledger?: string[];
  /**
   * Caption rows the live transcript marked Overheard (browser probe).
   * When supplied (even empty), it is the marking evidence; otherwise a
   * HEARD row that overlaps agent audio is the marking evidence.
   */
  captionMarks?: string[];
};

export type OverheardEvaluation = {
  recalled: number;
  total: number;
  byBeat: Record<GoldenBeat, { recalled: number; total: number }>;
  failures: OverheardFailure[];
  gate: ScoreboardGate;
};

/**
 * Kind reuses the overlap intelligence: `yield` (steering, command,
 * end-call) must be answered; `ignore` (filler, back-channel, echo) must
 * never derail the turn; `judge` (real content) must at least be heard.
 */
export function classifyOverheard(text: string, agentText = ""): OverheardKind {
  const verdict = judgeOverlap(text, agentText);
  if (verdict === "yield") return "steering";
  if (verdict === "ignore") return "filler";
  return "content";
}

/** Null when recalled; otherwise the human-readable reason it was lost. */
export function overheardRecallReason(aside: OverheardAside): string | null {
  if (!aside.text.trim()) return "empty aside text (nothing to recall)";
  if (!aside.markedOverheard) return "not marked Overheard speech in the caption";
  if (!aside.inLedger) return "missing from the call ledger";
  if (!aside.tracePointer.trim()) return "missing trace pointer";
  if (aside.handling === "lost") return "lost: never answered nor resumed-from";
  const kind = classifyOverheard(aside.text, aside.agentText ?? "");
  if (kind === "steering") {
    return aside.handling === "answered"
      ? null
      : `steering not answered (handling=${aside.handling})`;
  }
  if (kind === "filler") {
    return aside.handling === "answered"
      ? "filler derailed the turn (answered instead of resumed-from)"
      : null;
  }
  return null;
}

/**
 * Score every aside during agent speech. Steering must be answered;
 * filler must be resumed-from (or simply heard without cutting) and never
 * answered; content must be at least marked and ledger-counted. Reports
 * recalled/total overall plus per-beat counts with trace pointers.
 */
export function evaluateOverheardRecall(asides: OverheardAside[]): OverheardEvaluation {
  const byBeat = Object.fromEntries(
    GOLDEN_BEATS.map((beat) => [beat, { recalled: 0, total: 0 }]),
  ) as Record<GoldenBeat, { recalled: number; total: number }>;
  const failures: OverheardFailure[] = [];
  let recalled = 0;
  for (const aside of asides) {
    const slot = byBeat[aside.beat] ?? (byBeat[aside.beat] = { recalled: 0, total: 0 });
    slot.total += 1;
    const reason = overheardRecallReason(aside);
    if (reason === null) {
      recalled += 1;
      slot.recalled += 1;
    } else {
      failures.push({ aside, reason });
    }
  }
  const total = asides.length;
  const gate: ScoreboardGate =
    total === 0
      ? {
          name: "overheard-recall",
          status: "FAIL",
          detail: "no overheard asides observed (expected ≥1 on overheard-aside)",
        }
      : failures.length === 0
        ? {
            name: "overheard-recall",
            status: "PASS",
            detail: `${recalled}/${total} asides recalled (marked + ledger-counted with trace pointers)`,
          }
        : {
            name: "overheard-recall",
            status: "FAIL",
            detail: `${failures.length}/${total} asides lost: ${failures
              .slice(0, 3)
              .map((f) => `${f.reason} [${f.aside.tracePointer}]`)
              .join("; ")}`,
          };
  return { recalled, total, byBeat, failures, gate };
}

/**
 * Derive overheard asides from a Call-trace excerpt (HEARD/VONI per-turn
 * rows plus CLIENT barge-in verdicts, merged by `call:trace`).
 *
 * Marking is evidence, not assumption: an aside is marked Overheard only
 * when the merged trace shows the HEARD row overlapping a VONI reply (its
 * `CUT at` falls inside the caller's speech, or the client resolved a
 * barge-in after it), or when an explicit caption probe marked it. A HEARD
 * row spoken into a free floor is ordinary caller speech, not an aside.
 *
 * Ledger counting is evidenced too: the HEARD row is the merged transcript,
 * and when the runner's session ledger is supplied the same words must appear
 * there. A caption mark with no HEARD row is marked-but-uncounted; a ledgered
 * aside the caption never marked is unmarked. Both FAIL, and every pointer
 * names the Call trace turn it overlapped (or says none merged). Pure and
 * offline: no network, no transport.
 */
export function overheardFromTraceExcerpt(
  excerpt: string[],
  sessionId: string,
  beat: GoldenBeat = "overheard-aside",
  evidence: OverheardTraceEvidence = {},
): OverheardAside[] {
  const rows = parseOverheardRows(excerpt);
  const marks = evidence.captionMarks;
  const ledger = evidence.ledger;
  const matches = (list: string[] | undefined, text: string): boolean =>
    list !== undefined && list.some((entry) => sameTraceWords(entry, text));
  const pointerFor = (row: TraceOverheardRow, agentTurn: number | null): string =>
    agentTurn
      ? `${formatTraceTurn(agentTurn, sessionId)} :: ${row.line.trim().slice(0, 160)}`
      : `${sessionId} :: no Call trace turn merged :: ${row.line.trim().slice(0, 160)}`;
  const asides: OverheardAside[] = [];

  rows.forEach((row, index) => {
    if (row.kind !== "heard" || !row.heardText.trim()) return;
    const overlapped = overheardOverlapsAgentAudio(rows, index);
    const marked = marks !== undefined ? matches(marks, row.heardText) : overlapped;
    // Speech into a free floor is a normal turn: ledgered, but never an aside.
    if (!overlapped && !marked) return;
    asides.push({
      beat,
      text: row.heardText,
      ...(row.agentText ? { agentText: row.agentText } : {}),
      markedOverheard: marked,
      inLedger: ledger !== undefined ? matches(ledger, row.heardText) : true,
      handling: overheardHandlingFromRows(rows, index),
      tracePointer: pointerFor(row, row.agentTurn),
    });
  });

  // A caption mark with no HEARD row: the client marked it, the server
  // transcript never counted it. Cite that no turn merged rather than guess.
  for (const mark of marks ?? []) {
    if (!mark.trim()) continue;
    if (rows.some((row) => row.kind === "heard" && sameTraceWords(row.heardText, mark))) continue;
    asides.push({
      beat,
      text: mark,
      markedOverheard: true,
      inLedger: ledger !== undefined ? matches(ledger, mark) : false,
      handling: "heard-only",
      tracePointer: `${sessionId} :: no Call trace turn merged :: caption mark "${mark.slice(0, 120)}"`,
    });
  }
  return asides;
}

type TraceOverheardRow = {
  kind: "voni" | "heard" | "client";
  line: string;
  /** 1-based VONI reply this row follows (0 before the first reply). */
  agentTurn: number | null;
  /** VONI: when the server cut that reply (`CUT at …`), in excerpt seconds. */
  cutAt: number | null;
  /** HEARD: the visitor's words and when their speech started. */
  heardText: string;
  heardStart: number | null;
  /** What Voni was saying over this row: the last reply's own words, verbatim. */
  agentText: string;
  /** CLIENT barge-in verdict, translated to handling. */
  handling: OverheardHandling | null;
};

/** Rows of the merged Call trace that carry overheard evidence. */
function parseOverheardRows(excerpt: string[]): TraceOverheardRow[] {
  const rows: TraceOverheardRow[] = [];
  let turn = 0;
  let agentText = "";
  for (const line of excerpt) {
    if (line.includes("  VONI    ")) {
      turn += 1;
      const cut = /CUT at (\d+\.\d+)s/.exec(line);
      agentText = /\bVONI\s+"([^"]+)"/.exec(line)?.[1] ?? "";
      rows.push({
        kind: "voni",
        line,
        agentTurn: turn,
        cutAt: cut ? Number(cut[1]) : null,
        heardText: "",
        heardStart: null,
        agentText,
        handling: null,
      });
      continue;
    }
    if (line.includes("  HEARD   ")) {
      const text = /HEARD\s+"([^"]+)"/.exec(line)?.[1] ?? "";
      // The API can omit user_speech_ended_at_ms when the server cut wins the
      // endpoint race (call-trace renders `(16.23s–  –  )`). The start is
      // authoritative: a CUT at >= start still proves the words began while
      // the reply held the floor. Never require the end.
      const span = /\((\d+\.\d+)s[–-]/.exec(line);
      rows.push({
        kind: "heard",
        line,
        agentTurn: turn || null,
        cutAt: null,
        heardText: text,
        heardStart: span ? Number(span[1]) : null,
        // The reply the words landed on: classification needs its context so
        // Voni's own echo counts as filler, never as fresh content.
        agentText,
        handling: null,
      });
      continue;
    }
    const barge = /barge-in\s+(yield|ignore|keep)\b/.exec(line);
    if (barge) {
      rows.push({
        kind: "client",
        line,
        agentTurn: turn || null,
        cutAt: null,
        heardText: "",
        heardStart: null,
        agentText,
        handling: barge[1] === "yield" ? "answered" : "resumed-from",
      });
    }
  }
  return rows;
}

/**
 * Did these visitor words land while a VONI reply held the floor? Two
 * independent trace facts say yes: the nearest reply before the HEARD row
 * was cut inside the caller's speech window, or the client resolved a
 * barge-in after it (which only happens over an interrupted reply).
 */
function overheardOverlapsAgentAudio(rows: TraceOverheardRow[], index: number): boolean {
  const heard = rows[index];
  for (let i = index - 1; i >= 0; i -= 1) {
    if (rows[i].kind !== "voni") continue;
    if (rows[i].cutAt !== null && heard.heardStart !== null && rows[i].cutAt! >= heard.heardStart) return true;
    break;
  }
  for (let i = index + 1; i < rows.length; i += 1) {
    if (rows[i].kind === "heard") break;
    if (rows[i].kind === "client" && rows[i].handling) return true;
  }
  return false;
}

/** The barge-in verdict that followed this HEARD row, else heard-only. */
function overheardHandlingFromRows(rows: TraceOverheardRow[], index: number): OverheardHandling {
  for (let i = index + 1; i < rows.length; i += 1) {
    if (rows[i].kind === "heard") break;
    if (rows[i].kind === "client" && rows[i].handling) return rows[i].handling!;
  }
  return "heard-only";
}

/** Word-folded match so STT punctuation/casing drift is not a lost aside. */
function sameTraceWords(left: string, right: string): boolean {
  const a = traceLineWords(left);
  const b = traceLineWords(right);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

// ── Gate: voice registry (ticket 02, owner: voice-registry section) ──────────

/**
 * The locked gate default: the first demo voice, resolved through the
 * registry at use time. Named once here so neither the orchestrator, the
 * scenarios, nor the assertions carry a voice literal.
 */
export const DEFAULT_GATE_VOICE: string = DEMO_VOICE_IDS[0];

/**
 * The gate voice is a parameter resolved through the shared voice registry,
 * never hard-coded in the orchestrator: deploying a new voice is a registry
 * change plus a regression run, not a harness change.
 */
export function resolveGateVoice(voiceId: string): string {
  const known = getVoice(voiceId);
  if (!known || !(DEMO_VOICE_IDS as readonly string[]).includes(voiceId)) {
    throw new Error(
      `unknown gate voice "${voiceId}": pick one of ${DEMO_VOICE_IDS.join(", ")}`,
    );
  }
  return known.id;
}

export type VoicePlayback = {
  /** Gate voice id, as resolved through the registry. */
  id: string;
  /** Server-side output level every agent ships (loudest, deterministic). */
  outputVolume: number;
  /** Client-side per-voice gain matching the voice to the reference level. */
  playbackGain: number;
};

/** Gate voice playback: server output volume plus per-voice gain, both from the registry. */
export function gateVoicePlayback(voiceId: string): VoicePlayback {
  const id = resolveGateVoice(voiceId);
  return { id, outputVolume: VOICE_OUTPUT_VOLUME, playbackGain: voicePlaybackGain(id) };
}

/**
 * One voice's applied loudness path, read from the shared registry: server
 * `output.volume` is the same constant for every voice, and the client gain is
 * `voicePlaybackGain`. There is no pipeline retune and no second gain stage.
 * A voice absent from `NATIVE_VOICE_LUFS` is unmeasured: reported as INFO.
 */
export function voiceGainRow(voiceId: string, gateVoice: string): VoiceGainRow {
  const check = checkLoudnessSanity(voiceId);
  return {
    voice: voiceId,
    isGate: voiceId === gateVoice,
    outputVolume: VOICE_OUTPUT_VOLUME,
    gain: voicePlaybackGain(voiceId),
    nativeLufs: NATIVE_VOICE_LUFS[voiceId] ?? null,
    matchedLufs: check.matchedLufs,
    status: check.unmeasured ? "INFO" : check.ok ? "PASS" : "FAIL",
    detail: check.detail,
  };
}

/**
 * The full gain table: the gate voice first, then every regression voice, all
 * resolved through the registry. Never a literal list.
 */
export function voiceGainTable(gateVoice: string): VoiceGainRow[] {
  const gate = resolveGateVoice(gateVoice);
  return [gate, ...regressionVoices(gate)].map((voice) => voiceGainRow(voice, gate));
}

/**
 * Non-gate demo voices run regression-only (no clip, no pop, no invented
 * test tag): adding voices never breaks existing ones (spec story 14).
 */
export function regressionVoices(gateVoice: string): string[] {
  resolveGateVoice(gateVoice);
  return (DEMO_VOICE_IDS as readonly string[]).filter((voice) => voice !== gateVoice);
}

// ── Gate: timbre-probes + accent-human (ticket 10, owner: timbre section) ─────

/** Integrated loudness every demo voice is gain-matched to (anna, per voices.ts). */
export const TIMBRE_REFERENCE_LUFS = SCOREBOARD_BUDGETS.timbreReferenceLufs.value;
/** Matched loudness must land within this of the reference to count as sane. */
export const TIMBRE_LUFS_TOLERANCE_DB = SCOREBOARD_BUDGETS.timbreLufsToleranceDb.value;

/**
 * Native integrated loudness per voice, measured from `public/voices/*.mp3`
 * (see the VOICE_PLAYBACK_GAIN comment in lib/agents/voices.ts). The table is
 * restated here so the gate checks the gain it actually runs with, not the
 * comment it was derived from. A voice with no entry here is unmeasured:
 * its probes still gate, its loudness is reported, not failed.
 */
export const NATIVE_VOICE_LUFS: Record<string, number> = {
  anna: -23.1,
  lola: -22.5,
  rafael: -23.8,
  juergen: -28.8,
  estelle: -30.3,
  giovanni: -34.9,
};

/**
 * Playout pop threshold (public/playout-processor.js POP_JUMP = 0.3 of full
 * scale) in int16 steps, so the offline session-evidence PCM analysis
 * (qa-voice-session analyzePcm largestAdjacentStep) flags the same clicks
 * the on-device probe would have posted.
 */
export const POP_JUMP_INT16 = SCOREBOARD_BUDGETS.popJumpInt16.value;

export type TimbreProbes = {
  jump: number;
  overload: number;
  clip: number;
  underrun: number;
  inputDrop: number;
};

/** Probe-count kinds shared by the orchestrator and the matrix (one validator, one shape). */
export const PROBE_COUNT_KINDS = ["jump", "overload", "clip", "underrun", "inputDrop"] as const;

/**
 * Shared probe-count validator (review: was duplicated in score-demo.mts
 * readProbeJson and score-matrix.mts readScoreArtifact). Missing counts
 * default to zero; anything negative or non-integer is a harness bug, not
 * a clean run. `source` prefixes the error (e.g. `--probe-json <path>`).
 */
export function validateProbeCounts(
  record: Record<string, unknown>,
  source: string,
): TimbreProbes {
  const probes = {} as TimbreProbes;
  for (const kind of PROBE_COUNT_KINDS) {
    const value = record[kind] ?? 0;
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(
        `${source}: probe count "${kind}" must be a non-negative int, got ${JSON.stringify(value)}`,
      );
    }
    probes[kind] = value as number;
  }
  return probes;
}

export type AgentChannelEvidence = {
  peakDbfs: number | null;
  clippedSampleRatio: number | null;
  largestAdjacentStep: number | null;
};

/** Post-gain integrated loudness, or null when the voice has no native measurement. */
export function matchedLoudnessLufs(voiceId: string): number | null {
  const native = NATIVE_VOICE_LUFS[voiceId];
  if (native === undefined) return null;
  return Number((native + 20 * Math.log10(voicePlaybackGain(voiceId))).toFixed(2));
}

export type LoudnessCheck = {
  ok: boolean;
  matchedLufs: number | null;
  detail: string;
};

/** Pure loudness math: native level plus linear gain against the reference. */
export function checkLoudness(input: { nativeLufs: number; gain: number }): LoudnessCheck {
  const matchedLufs = Number((input.nativeLufs + 20 * Math.log10(input.gain)).toFixed(2));
  const ok = Math.abs(matchedLufs - TIMBRE_REFERENCE_LUFS) <= TIMBRE_LUFS_TOLERANCE_DB;
  return {
    ok,
    matchedLufs,
    detail: ok
      ? `matched ${matchedLufs} LUFS vs reference ${TIMBRE_REFERENCE_LUFS} LUFS (native ${input.nativeLufs}, gain ${input.gain})`
      : `matched ${matchedLufs} LUFS misses reference ${TIMBRE_REFERENCE_LUFS} LUFS by more than ${TIMBRE_LUFS_TOLERANCE_DB} dB (native ${input.nativeLufs}, gain ${input.gain})`,
  };
}

/** Registry-backed loudness sanity for one voice (unmeasured, never failed). */
export function checkLoudnessSanity(voiceId: string): LoudnessCheck & { unmeasured?: boolean } {
  const native = NATIVE_VOICE_LUFS[voiceId];
  if (native === undefined) {
    return {
      ok: false,
      unmeasured: true,
      matchedLufs: null,
      detail: `no native loudness measurement for "${voiceId}": probes still gate, loudness is reported not failed`,
    };
  }
  return checkLoudness({ nativeLufs: native, gain: voicePlaybackGain(voiceId) });
}

/** Every probe count must be zero across the golden run; the detail names the offender. */
export function checkTimbreProbes(probes: TimbreProbes): { ok: boolean; detail: string } {
  for (const kind of ["jump", "overload", "clip", "underrun", "inputDrop"] as const) {
    if (probes[kind] > SCOREBOARD_BUDGETS.timbreProbeMaxCount.value) {
      return {
        ok: false,
        detail: `${kind} ${probes[kind]} > ${SCOREBOARD_BUDGETS.timbreProbeMaxCount.value} across the golden run (must be zero: no clip, pop, playout jump, underrun, or input-drop)`,
      };
    }
  }
  return { ok: true, detail: "jump/overload/clip/underrun/input-drop all zero" };
}

/**
 * Offline PCM check against the same defects the live probes watch:
 * clipped samples (analyzePcm clippedSampleRatio, the gain softLimit's
 * backstop) and playout-scale adjacent-sample jumps. Missing evidence
 * (dry run, decoder unavailable) passes open, never fails closed.
 */
export function checkEvidenceTimbre(channel: AgentChannelEvidence | null): {
  ok: boolean;
  detail: string;
} {
  if (channel === null) return { ok: true, detail: "no agent-channel evidence (dry run or decoder unavailable)" };
  const clipped = channel.clippedSampleRatio ?? 0;
  if (clipped > 0) {
    return {
      ok: false,
      detail: `clip ${clipped} of agent-channel samples at full scale (softLimit backstop missed)`,
    };
  }
  const step = channel.largestAdjacentStep ?? 0;
  if (step > POP_JUMP_INT16) {
    return {
      ok: false,
      detail: `jump of ${step} int16 steps exceeds the playout pop threshold ${POP_JUMP_INT16}`,
    };
  }
  return {
    ok: true,
    detail: `peak ${channel.peakDbfs} dBFS, no clipped samples, max adjacent step ${step}`,
  };
}

/**
 * The timbre auto gate: probe counts, session-evidence PCM, and loudness
 * sanity all have to agree. Any defect FAILs with the offender named;
 * unmeasured loudness is reported in the detail, never failed.
 */
export function evaluateTimbreGate(input: {
  probes: TimbreProbes;
  voiceId: string;
  agentChannel: AgentChannelEvidence | null;
}): ScoreboardGate {
  const probes = checkTimbreProbes(input.probes);
  if (!probes.ok) return { name: "timbre-probes", status: "FAIL", detail: probes.detail };
  const evidence = checkEvidenceTimbre(input.agentChannel);
  if (!evidence.ok) return { name: "timbre-probes", status: "FAIL", detail: evidence.detail };
  const loudness = checkLoudnessSanity(input.voiceId);
  if (!loudness.ok && !loudness.unmeasured) {
    return { name: "timbre-probes", status: "FAIL", detail: loudness.detail };
  }
  return {
    name: "timbre-probes",
    status: "PASS",
    detail: `${probes.detail}; ${loudness.detail}; ${evidence.detail}`,
  };
}

/**
 * Console gain table: the one loudness path per voice — server level plus
 * client gain, both from the registry, with the native and matched levels
 * that explain the number. Unmeasured voices print INFO (reported, not failed).
 */
export function formatVoiceGainTable(rows: VoiceGainRow[]): string {
  const lufs = (value: number | null) => (value === null ? "unmeasured" : `${value} LUFS`);
  const lines = rows.map((row) => {
    const scope = row.isGate ? "gate" : "regression";
    const line = `${row.status.padEnd(6)} ${row.voice.padEnd(10)} ${scope.padEnd(10)} vol=${row.outputVolume} gain=${row.gain} native ${lufs(row.nativeLufs)} matched ${lufs(row.matchedLufs)}`;
    return row.status === "INFO" ? `${line} — ${row.detail}` : line;
  });
  return ["demo voice gain (registry only: server volume + client playback gain)", ...lines].join("\n");
}

/** Dry-run listing: every beat with its window, plus the resolved gate and regression set. */
export function formatGoldenScript(gateVoice: string): string {
  const playback = gateVoicePlayback(gateVoice);
  const lines = GOLDEN_SCRIPT.map(
    (beat, index) =>
      `${index + 1}. ${beat.beat} — visitor: ${beat.visitor} — window: ${beat.window.metric} ${beat.window.min}–${beat.window.max} ${beat.window.unit} — expect: ${beat.expect}`,
  );
  const regression = regressionVoices(gateVoice)
    .map((voice) => `${voice} (gain ${voicePlaybackGain(voice)})`)
    .join(", ");
  return [
    `golden script (${GOLDEN_VERTICAL}, ~${GOLDEN_SCRIPT_BUDGET_S}s, gate ${playback.id} vol=${playback.outputVolume} gain=${playback.playbackGain})`,
    ...lines,
    `regression voices: ${regression}`,
  ].join("\n");
}

/**
 * Console budget report: the frozen numbers every verdict above is judged
 * against, printed with each run so a green is read next to its ruler. Values
 * come from the single budget table (never from the gate functions), so the
 * report cannot drift from what the gates enforce.
 */
export function formatBudgetReport(): string {
  const b = SCOREBOARD_BUDGETS;
  const lines = [
    "demo budgets (frozen; pinned in src/lib/demo/scoreboard-budgets.json — a threshold edit is a spec change)",
    `  golden script          ~${b.goldenScriptBudgetS.value}s, seven locked beats`,
    `  reply-gap              p50 ≤${b.replyGapP50Ms.value}ms, p95 ≤${b.replyGapP95Ms.value}ms`,
    `  barge-in-cut           cut ≤${b.realCutMs.value}ms, answered never resumed`,
    `  filler-resume          exact unheard tail ≤${b.fillerResumeTailMs.value}ms`,
    `  overheard-recall       ${b.overheardAsidesMin.value}/${b.overheardAsidesMax.value} aside marked Overheard speech + ledger-counted`,
    `  dead-air               uncovered gap ≤${b.deadAirMaxMs.value}ms; one check-in ${b.silenceCheckInTargetMs.value}-${b.silenceCheckInMaxMs.value}ms`,
    `  email-invite           tag said ${b.emailTagMentionsMin.value}× exactly, chip once`,
    `  double-talk            audible overlap ≤${b.doubleTalkMaxOverlapMs.value}ms after ${b.doubleTalkFadeOutS.value}s fade`,
    `  end-call-drain         coverage ≥${b.goodbyeAudioCoverageMin.value}, hang-up ≤${b.hangUpAfterGoodbyeMaxMs.value}ms, settle ${b.endCallSettlePolls.value}×${b.endCallPollMs.value}ms, grace ${b.endCallAudioGraceMs.value}ms, timeout ${b.endCallDrainTimeoutMs.value}ms`,
    `  timbre-probes          ref ${b.timbreReferenceLufs.value} LUFS ±${b.timbreLufsToleranceDb.value}dB, probes ≤${b.timbreProbeMaxCount.value}, pop jump ${b.popJumpInt16.value}`,
    `  accent-human           ${b.humanRatersRequired.value} raters, ${b.humanRatingScaleMin.value}-${b.humanRatingScaleMax.value}, blind on one recording`,
  ];
  return lines.join("\n");
}

// ── Gate: double-talk + end-call-drain (ticket 09, shared cut/drain section) ───

/**
 * Double-talk bar (spec story 8): zero audible overlap longer than 400ms
 * after any cut. Cuts fade what is sounding over DOUBLE_TALK_FADE_OUT_S and
 * flush the rest (session FADE_OUT_S; playout jitter pre-roll 500ms with edge
 * fades in the worklet), so anything still audible past 400ms is a real
 * talk-over, not the fade itself.
 */
export const DOUBLE_TALK_MAX_OVERLAP_MS = SCOREBOARD_BUDGETS.doubleTalkMaxOverlapMs.value;
/** Barge-in fade: what is sounding ramps to silence over this, never a hard stop. */
export const DOUBLE_TALK_FADE_OUT_S = SCOREBOARD_BUDGETS.doubleTalkFadeOutS.value;

/**
 * End-call drain handshake (spec story 10, ADR-0005 holdUntilReplyDone): the
 * end_call result waits for the goodbye reply to finish, then the session
 * hangs up only after END_CALL_SETTLE_POLLS consecutive settled polls AND
 * END_CALL_AUDIO_GRACE_MS since the last audio arrived, bounded by
 * END_CALL_DRAIN_TIMEOUT_MS. The goodbye must play in full (>=
 * GOODBYE_AUDIO_COVERAGE_MIN of its speaking time, per eval bye-audio) and
 * the model must not narrate the ending.
 */
// The live session owns these handshake constants; the scoreboard re-exports
// them so a retune in session.ts moves the same number the freeze guard pins
// (the freeze test cross-checks both against the committed record).
export { END_CALL_POLL_MS, END_CALL_SETTLE_POLLS, END_CALL_AUDIO_GRACE_MS, END_CALL_DRAIN_TIMEOUT_MS };
/** The goodbye's audio must arrive in full: >= 80% of its words' speaking time. */
export const GOODBYE_AUDIO_COVERAGE_MIN = SCOREBOARD_BUDGETS.goodbyeAudioCoverageMin.value;
/** Hang-up after goodbye audio end: the golden goodbye-drain window (0-1500ms). */
export const HANG_UP_AFTER_GOODBYE_MAX_MS = SCOREBOARD_BUDGETS.hangUpAfterGoodbyeMaxMs.value;

/**
 * The drain verdict both live hang-up scenarios return, so the fast and
 * over-answer paths are held to the same bar: inside the goodbye-drain
 * window and never closed before the goodbye's audio finished. Returns the
 * scenario failure text, or null when the measured drain passes.
 */
export function hangUpDrainFailure(ms: number): string | null {
  if (ms < 0) {
    return `hung up ${-ms}ms before the goodbye audio ended (chopped)`;
  }
  if (ms > HANG_UP_AFTER_GOODBYE_MAX_MS) {
    return `hang-up too slow: ${ms}ms > ${HANG_UP_AFTER_GOODBYE_MAX_MS}ms`;
  }
  return null;
}

export type DoubleTalkInput = {
  /** Audible overlap per cut, ms (fade 0.04s already accounted for by the 400ms bar). */
  overlapMs: number[];
  /** Trace pointer for failures, e.g. "sess_abc / greeting-cut". */
  traceRef?: string;
};

/** One audible window on the wall clock, ms (start inclusive, end exclusive). */
export type AudibleWindow = { start: number; end: number };

/**
 * What one cut leaves behind, from the playout's own timings. `cutAt` is when
 * the caller began speaking over the agent (the cut trigger, i.e. cut
 * latency); `flushAt` is when the server cut/flush was actually processed;
 * `agentUntil` is when agent audio actually went silent: a healthy flush
 * drops the queue so only the fade remains, while an ineffective flush (or
 * a fade that never completes) leaves queued audio sounding. The caller
 * window is the speech that was sounding under the cut, or null when the
 * caller was silent.
 */
export type DoubleTalkCut = {
  /** The cut trigger (caller speech start under the agent), wall clock ms. */
  cutAt: number;
  /** When the server cut/flush was processed, wall clock ms. */
  flushAt: number;
  /** When agent playout actually went silent, wall clock ms. */
  agentUntil: number;
  /** Caller speech audible under the cut; null when the caller was not speaking. */
  caller: AudibleWindow | null;
};

/** Both audios sounding together from `from` until agent silence. */
function overlapFrom(cut: DoubleTalkCut, from: number): number {
  if (!cut.caller) return 0;
  const start = Math.max(from, cut.caller.start);
  const end = Math.min(cut.agentUntil, cut.caller.end);
  return Math.max(0, Math.round(end - start));
}

/**
 * The double-talk measure the gate scores: POST-FLUSH residual overlap, the
 * ms both were still sounding after the server cut/flush was processed. A
 * prompt flush leaves only the fade's tail (normally <=40ms → PASS); a flush
 * that fails to drop the queue, or a fade that leaves agent audio sounding
 * past 400ms, FAILs. Time before the flush is cut latency, which the
 * barge-in-cut budget (1500ms) measures separately.
 */
export function postFlushOverlapMs(cut: DoubleTalkCut): number {
  return overlapFrom(cut, cut.flushAt);
}

/**
 * Diagnostic only: audible overlap from the caller's first word to agent
 * silence. This is CUT LATENCY (the barge-in-cut budget, up to 1500ms), not
 * double talk; the double-talk gate must never score it, or every healthy
 * cut slower than ~400ms would wrongly fail.
 */
export function cutOverlapMs(cut: DoubleTalkCut): number {
  return overlapFrom(cut, cut.cutAt);
}

/**
 * The cut window the playout's own timings produce. `playUntil` is the
 * wall-clock end of everything queued when the flush landed. A healthy flush
 * drops that queue, so the worklet's `fadeMs` is all that is left;
 * `keepSoundingMs` models an ineffective flush (fault injection): queued
 * audio keeps sounding after the flush for that long, then fades. The window
 * is never assumed to stop at flushAt + fade when the flush failed.
 */
export function playoutCutWindow(input: {
  cutAt: number;
  /** When the flush was processed; defaults to the cut trigger (prompt flush). */
  flushAt?: number;
  playUntil: number;
  fadeMs: number;
  /** Audio the flush failed to stop after the fade (0 for a healthy flush). */
  keepSoundingMs?: number;
  caller: AudibleWindow | null;
}): DoubleTalkCut {
  const flushAt = Math.max(input.cutAt, input.flushAt ?? input.cutAt);
  const residual = Math.max(0, input.fadeMs) + Math.max(0, input.keepSoundingMs ?? 0);
  return {
    cutAt: input.cutAt,
    flushAt,
    // The actual silence comes from the playout: a dropped queue stops at the
    // fade, a failed flush plays on for keepSoundingMs first.
    agentUntil: Math.min(input.playUntil, flushAt + residual),
    caller: input.caller,
  };
}

/** Double-talk gate: external behavior (audible overlap), never internals. */
export function evaluateDoubleTalk(input: DoubleTalkInput): ScoreboardGate {
  const trace = input.traceRef ? ` — trace: ${input.traceRef}` : "";
  if (input.overlapMs.length === 0) {
    return { name: "double-talk", status: "INFO", detail: "no cuts measured" };
  }
  const max = Math.max(...input.overlapMs);
  const cuts = input.overlapMs.join(", ");
  if (max > DOUBLE_TALK_MAX_OVERLAP_MS) {
    return {
      name: "double-talk",
      status: "FAIL",
      detail:
        `audible overlap ${max}ms > ${DOUBLE_TALK_MAX_OVERLAP_MS}ms after the flush ` +
        `(cuts: ${cuts}ms; fade ${DOUBLE_TALK_FADE_OUT_S}s + flush)${trace}`,
    };
  }
  return {
    name: "double-talk",
    status: "PASS",
    detail:
      `max overlap ${max}ms ≤ ${DOUBLE_TALK_MAX_OVERLAP_MS}ms across ` +
      `${input.overlapMs.length} cut${input.overlapMs.length === 1 ? "" : "s"} ` +
      `(fade ${DOUBLE_TALK_FADE_OUT_S}s + flush)`,
  };
}

/**
 * The live runner's machine-readable overlap evidence, one line per over-talk
 * run: `DOUBLE TALK {"scenario":"over-talk","session":"sess_…","overlapMs":[…],"fadeMs":40}`.
 * `overlapMs` lists the post-flush residual overlap per cut, the same number
 * the double-talk gate scores. The session id lets score-demo refuse to cite
 * a Call trace turn from a different call.
 */
export const DOUBLE_TALK_EVIDENCE_PREFIX = "DOUBLE TALK ";

export type DoubleTalkEvidence = {
  scenario: string;
  sessionId: string | null;
  /** Post-flush residual overlap per cut, ms. */
  overlapMs: number[];
  /** The fade the flush applied, ms (null when the run did not report it). */
  fadeMs: number | null;
};

function nonNegativeMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parse the runner's DOUBLE TALK line. Null when the run printed none (another
 * scenario, a dry run). A present but malformed line throws: overlap is either
 * measured or absent, never guessed from a broken payload.
 */
export function parseDoubleTalkOutput(stdout: string): DoubleTalkEvidence | null {
  let found: DoubleTalkEvidence | null = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimStart();
    if (!line.startsWith(DOUBLE_TALK_EVIDENCE_PREFIX)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(DOUBLE_TALK_EVIDENCE_PREFIX.length));
    } catch (error) {
      throw new Error(
        `eval runner DOUBLE TALK line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (raw === null || typeof raw !== "object") {
      throw new Error("eval runner DOUBLE TALK line must be a JSON object");
    }
    const candidate = raw as { scenario?: unknown; session?: unknown; overlapMs?: unknown; fadeMs?: unknown };
    if (typeof candidate.scenario !== "string" || !candidate.scenario.trim()) {
      throw new Error("eval runner DOUBLE TALK line needs a scenario name");
    }
    const session = candidate.session ?? null;
    if (session !== null && (typeof session !== "string" || !session.trim())) {
      throw new Error("eval runner DOUBLE TALK line has an invalid session id");
    }
    if (!Array.isArray(candidate.overlapMs)) {
      throw new Error("eval runner DOUBLE TALK line needs an overlapMs array");
    }
    const overlapMs = candidate.overlapMs.map((value) => {
      const ms = nonNegativeMs(value);
      if (ms === null) throw new Error("eval runner DOUBLE TALK line needs non-negative overlapMs");
      return Math.round(ms);
    });
    const fadeMs = candidate.fadeMs === undefined ? null : nonNegativeMs(candidate.fadeMs);
    if (candidate.fadeMs !== undefined && fadeMs === null) {
      throw new Error("eval runner DOUBLE TALK line has an invalid fadeMs");
    }
    found = { scenario: candidate.scenario, sessionId: session, overlapMs, fadeMs };
  }
  return found;
}

/**
 * The live runner's machine-readable aside evidence, one line per over-talk
 * run: `OVERHEARD ASIDE {"scenario":"over-talk","session":"sess_…",
 * "text":"We're a bakery, actually.","startMs":16230,"cutMs":17040,…}`.
 * The runner prints it only after asserting the caller started speaking while
 * Voni's reply still had queued audio AND the server cut landed at/after that
 * start on the same reply, so the marker itself is proof of the overlap.
 * score-demo uses it only when the merged trace yields no aside (the API can
 * omit `user_speech_ended_at_ms`); the ledger still has to count the words.
 */
export const OVERHEARD_ASIDE_EVIDENCE_PREFIX = "OVERHEARD ASIDE ";

export type OverheardAsideEvidence = {
  scenario: string;
  sessionId: string;
  /** The visitor's words spoken over Voni. */
  text: string;
  /** What Voni was saying when the aside landed (may be empty). */
  agentText: string;
  /** The reply id the aside landed on, when the runner knew it. */
  replyId: string | null;
  /** Call-relative ms when the caller's speech started. */
  startMs: number;
  /** Call-relative ms when the caller's spoken audio ended (null when unknown). */
  endMs: number | null;
  /** Call-relative ms of the server cut that ended Voni's reply. */
  cutMs: number;
};

/**
 * Parse the runner's OVERHEARD ASIDE line. Null when the run printed none
 * (another scenario, a dry run). A present but malformed line throws: the
 * overlap is either proven by the runner or absent, never inferred from a
 * broken payload. `cutMs >= startMs` is the overlap proof, so an inverted
 * span is rejected outright.
 */
export function parseOverheardAsideOutput(stdout: string): OverheardAsideEvidence | null {
  let found: OverheardAsideEvidence | null = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimStart();
    if (!line.startsWith(OVERHEARD_ASIDE_EVIDENCE_PREFIX)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(OVERHEARD_ASIDE_EVIDENCE_PREFIX.length));
    } catch (error) {
      throw new Error(
        `eval runner OVERHEARD ASIDE line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (raw === null || typeof raw !== "object") {
      throw new Error("eval runner OVERHEARD ASIDE line must be a JSON object");
    }
    const candidate = raw as {
      scenario?: unknown;
      session?: unknown;
      text?: unknown;
      agentText?: unknown;
      replyId?: unknown;
      startMs?: unknown;
      endMs?: unknown;
      cutMs?: unknown;
    };
    if (typeof candidate.scenario !== "string" || !candidate.scenario.trim()) {
      throw new Error("eval runner OVERHEARD ASIDE line needs a scenario name");
    }
    if (typeof candidate.session !== "string" || !/^sess_[A-Za-z0-9_-]+$/.test(candidate.session)) {
      throw new Error("eval runner OVERHEARD ASIDE line needs a session id like sess_abc");
    }
    if (typeof candidate.text !== "string" || !candidate.text.trim()) {
      throw new Error("eval runner OVERHEARD ASIDE line needs the aside text");
    }
    const startMs = nonNegativeMs(candidate.startMs);
    const cutMs = nonNegativeMs(candidate.cutMs);
    if (startMs === null || cutMs === null) {
      throw new Error("eval runner OVERHEARD ASIDE line needs non-negative startMs/cutMs");
    }
    if (cutMs < startMs) {
      throw new Error(
        `eval runner OVERHEARD ASIDE line has the cut before the aside (start ${startMs}ms, cut ${cutMs}ms)`,
      );
    }
    const endMs = candidate.endMs === undefined || candidate.endMs === null ? null : nonNegativeMs(candidate.endMs);
    if (candidate.endMs !== undefined && candidate.endMs !== null && endMs === null) {
      throw new Error("eval runner OVERHEARD ASIDE line has an invalid endMs");
    }
    const agentText = typeof candidate.agentText === "string" ? candidate.agentText : "";
    const replyId = candidate.replyId === undefined || candidate.replyId === null ? null : candidate.replyId;
    if (replyId !== null && typeof replyId !== "string") {
      throw new Error("eval runner OVERHEARD ASIDE line has an invalid replyId");
    }
    found = {
      scenario: candidate.scenario,
      sessionId: candidate.session,
      text: candidate.text,
      agentText,
      replyId,
      startMs: Math.round(startMs),
      endMs: endMs === null ? null : Math.round(endMs),
      cutMs: Math.round(cutMs),
    };
  }
  return found;
}

/**
 * Turn the runner's asserted aside marker into the gate's aside record. The
 * marker is marked Overheard because the runner measured the overlap; ledger
 * counting is independent (a missing ledger is a FAIL, never assumed).
 */
export function overheardFromRunEvidence(
  evidence: OverheardAsideEvidence,
  beat: GoldenBeat = "overheard-aside",
  ledger?: string[],
): OverheardAside[] {
  return [
    {
      beat,
      text: evidence.text,
      ...(evidence.agentText.trim() ? { agentText: evidence.agentText } : {}),
      markedOverheard: true,
      inLedger: ledger !== undefined && ledger.some((entry) => sameTraceWords(entry, evidence.text)),
      handling: "heard-only",
      tracePointer:
        `${evidence.sessionId} :: ${(evidence.startMs / 1000).toFixed(2)}s HEARD ` +
        `"${evidence.text.slice(0, 120)}" (runner cut ${(evidence.cutMs / 1000).toFixed(2)}s)`,
    },
  ];
}

/**
 * The live runner's machine-readable goodbye evidence, one line per goodbye
 * run: `GOODBYE DRAIN {"scenario":"bye-audio","session":"sess_…","turn":4,
 * "coverage":0.97,"inboxNamed":true}`. `turn` is the 1-based VONI reply that
 * carried the closing line (null when none played), `coverage` is the played
 * audio time over the line's expected speaking time, and `inboxNamed` says
 * whether that line actually said hi@voni.cc. The session id lets score-demo
 * refuse to cite a Call trace turn from a different call.
 */
export const GOODBYE_DRAIN_EVIDENCE_PREFIX = "GOODBYE DRAIN ";

export type GoodbyeDrainEvidence = {
  scenario: string;
  sessionId: string | null;
  /** 1-based VONI reply that carried the closing line; null when none played. */
  turn: number | null;
  /** Played / expected speaking time; null when no closing line played. */
  coverage: number | null;
  /** The closing line named the team inbox as spoken. */
  inboxNamed: boolean;
  /**
   * The model spoke again after its own hang-up signal (post-End call
   * narration); null when the line did not measure it.
   */
  narratedEnding: boolean | null;
  /** Session close minus goodbye audio end, when the run measured it. */
  hangUpDelayMs: number | null;
};

/**
 * Parse the runner's GOODBYE DRAIN line. Null when the run printed none
 * (another scenario, a dry run). A present but malformed line throws:
 * coverage is either measured or absent, never guessed from a broken payload.
 */
export function parseGoodbyeDrainOutput(stdout: string): GoodbyeDrainEvidence | null {
  let found: GoodbyeDrainEvidence | null = null;
  // Several runs: keep the worst closing line, so a chopped or inbox-less
  // take cannot hide behind a later green one.
  const worse = (candidate: GoodbyeDrainEvidence): boolean => {
    if (found === null) return true;
    if (found.inboxNamed && !candidate.inboxNamed) return true;
    if (!found.inboxNamed && candidate.inboxNamed) return false;
    // Narration is never averaged away: a run that narrated the ending is
    // the one the gate must see, whatever a later run's coverage.
    if (candidate.narratedEnding === true && found.narratedEnding !== true) return true;
    if (found.narratedEnding === true && candidate.narratedEnding !== true) return false;
    return (
      candidate.coverage !== null &&
      (found.coverage === null || candidate.coverage < found.coverage)
    );
  };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimStart();
    if (!line.startsWith(GOODBYE_DRAIN_EVIDENCE_PREFIX)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(GOODBYE_DRAIN_EVIDENCE_PREFIX.length));
    } catch (error) {
      throw new Error(
        `eval runner GOODBYE DRAIN line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (raw === null || typeof raw !== "object") {
      throw new Error("eval runner GOODBYE DRAIN line must be a JSON object");
    }
    const candidate = raw as {
      scenario?: unknown;
      session?: unknown;
      turn?: unknown;
      coverage?: unknown;
      inboxNamed?: unknown;
      narratedEnding?: unknown;
      hangUpDelayMs?: unknown;
    };
    if (typeof candidate.scenario !== "string" || !candidate.scenario.trim()) {
      throw new Error("eval runner GOODBYE DRAIN line needs a scenario name");
    }
    const session = candidate.session ?? null;
    if (session !== null && (typeof session !== "string" || !session.trim())) {
      throw new Error("eval runner GOODBYE DRAIN line has an invalid session id");
    }
    const turn = candidate.turn ?? null;
    if (turn !== null && (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1)) {
      throw new Error("eval runner GOODBYE DRAIN line has an invalid turn");
    }
    const coverage = candidate.coverage ?? null;
    if (coverage !== null && (typeof coverage !== "number" || !Number.isFinite(coverage) || coverage < 0)) {
      throw new Error("eval runner GOODBYE DRAIN line has an invalid coverage");
    }
    if (typeof candidate.inboxNamed !== "boolean") {
      throw new Error("eval runner GOODBYE DRAIN line needs inboxNamed");
    }
    const narratedEnding = candidate.narratedEnding ?? null;
    if (narratedEnding !== null && typeof narratedEnding !== "boolean") {
      throw new Error("eval runner GOODBYE DRAIN line has an invalid narratedEnding");
    }
    const hangUpDelayMs = candidate.hangUpDelayMs === undefined ? null : nonNegativeMs(candidate.hangUpDelayMs);
    if (candidate.hangUpDelayMs !== undefined && hangUpDelayMs === null) {
      throw new Error("eval runner GOODBYE DRAIN line has an invalid hangUpDelayMs");
    }
    const evidence: GoodbyeDrainEvidence = {
      scenario: candidate.scenario,
      sessionId: session,
      turn,
      coverage,
      inboxNamed: candidate.inboxNamed,
      narratedEnding,
      hangUpDelayMs,
    };
    if (worse(evidence)) found = evidence;
  }
  return found;
}

/** One measured hang-up line: the delay and the call it ran long on. */
export type RunnerHangUpEvidence = {
  /** Session close minus the goodbye's audio end. */
  ms: number;
  /** The call's own session, so a FAIL cites that call's turn, never another's. */
  sessionId: string | null;
};

/**
 * The runner's measured closing-line drain: `hung up Nms after the goodbye
 * finished playing (session sess_…)`, one line per hang-up run. A delay can
 * be negative when the session closed before the goodbye's audio ended.
 * Several runs report the worst hang-up, with its own session, the number
 * and call the gate must see: an early close (chopped) outranks a slow one,
 * because taking the largest delay would hide it. Null when no hang-up was
 * measured.
 */
export function parseRunnerHangUp(stdout: string): RunnerHangUpEvidence | null {
  let worst: RunnerHangUpEvidence | null = null;
  for (const line of stdout.split("\n")) {
    const match = line.match(/hung up (-?\d+(?:\.\d+)?)ms after the goodbye finished playing(?: \(session (\S+)\))?/);
    if (!match) continue;
    const ms = Math.round(Number(match[1]));
    const worse =
      worst === null ||
      (ms < 0 && (worst.ms >= 0 || ms < worst.ms)) ||
      (ms >= 0 && worst.ms >= 0 && ms > worst.ms);
    if (worse) worst = { ms, sessionId: match[2] ?? null };
  }
  return worst;
}

/** The worst measured hang-up delay, in ms; null when none was measured. */
export function runnerHangUpDelayMs(stdout: string): number | null {
  return parseRunnerHangUp(stdout)?.ms ?? null;
}

/**
 * The runner's explicit "no closing line played" marker for a hang-up run:
 * `no goodbye audio after the end request (session sess_…)`. That is measured
 * evidence of a missing goodbye, so the drain gate FAILs instead of measuring
 * from the greeting or staying INFO. Null when the marker never printed.
 */
export function parseRunnerMissingGoodbye(stdout: string): { sessionId: string | null } | null {
  const match = stdout.match(/no goodbye audio after the end request(?: \(session (\S+)\))?/);
  return match ? { sessionId: match[1] ?? null } : null;
}

export type EndCallDrainInput = {
  /** Played / expected goodbye speaking time; null when never measured. */
  goodbyeCoverage: number | null;
  /** Session end minus goodbye audio end; null when never measured. */
  hangUpDelayMs: number | null;
  /** The model spoke again after end_call instead of letting the line close. */
  narratedEnding: boolean;
  /** The closing line named the team inbox; null when never measured. */
  inboxNamed?: boolean | null;
  /**
   * The caller asked to end and no closing-line audio played afterwards. This
   * is a measured FAIL ("no goodbye"), never a reason to measure the drain
   * from an earlier reply such as the greeting.
   */
  missingGoodbye?: boolean;
  /** Trace pointer for failures, e.g. "call trace turn 4 (sess_xyz)". */
  traceRef?: string;
};

/** End-call drain gate: the full closing plays before the session closes. */
export function evaluateEndCallDrain(input: EndCallDrainInput): ScoreboardGate {
  const trace = input.traceRef ? ` — trace: ${input.traceRef}` : "";
  if (input.missingGoodbye) {
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail: `no goodbye audio after End call: the caller never heard a closing line${trace}`,
    };
  }
  if (input.narratedEnding) {
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail: `model narrated the ending after end_call (goodbye never closed the call)${trace}`,
    };
  }
  if (input.inboxNamed === false) {
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail: `closing line never named the team inbox ${TEAM_INBOX_ADDRESS}${trace}`,
    };
  }
  if (input.goodbyeCoverage !== null && input.goodbyeCoverage < GOODBYE_AUDIO_COVERAGE_MIN) {
    const pct = Math.round(input.goodbyeCoverage * 100);
    const bar = Math.round(GOODBYE_AUDIO_COVERAGE_MIN * 100);
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail: `goodbye audio ${pct}% < ${bar}% of its speaking time (chopped)${trace}`,
    };
  }
  if (input.hangUpDelayMs !== null && input.hangUpDelayMs < 0) {
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail:
        `hung up ${-input.hangUpDelayMs}ms before goodbye audio ended ` +
        `(delay ${input.hangUpDelayMs}ms: chopped)${trace}`,
    };
  }
  if (input.hangUpDelayMs !== null && input.hangUpDelayMs > HANG_UP_AFTER_GOODBYE_MAX_MS) {
    return {
      name: "end-call-drain",
      status: "FAIL",
      detail:
        `hang-up ${input.hangUpDelayMs}ms after goodbye audio ` +
        `> ${HANG_UP_AFTER_GOODBYE_MAX_MS}ms bar (line held)${trace}`,
    };
  }
  // Coverage or hang-up timing must be measured before this gate claims PASS;
  // the inbox alone is not a drain measurement.
  if (input.goodbyeCoverage === null && input.hangUpDelayMs === null) {
    const inbox = input.inboxNamed === true ? ` (${TEAM_INBOX_ADDRESS} named, audio unmeasured)` : "";
    return { name: "end-call-drain", status: "INFO", detail: `no goodbye measured${inbox}` };
  }
  const coverage = input.goodbyeCoverage === null ? "unmeasured" : `${Math.round(input.goodbyeCoverage * 100)}%`;
  const delay = input.hangUpDelayMs === null ? "unmeasured" : `${input.hangUpDelayMs}ms`;
  const inbox = input.inboxNamed === true ? ` ${TEAM_INBOX_ADDRESS}` : " (inbox unmeasured)";
  return {
    name: "end-call-drain",
    status: "PASS",
    detail:
      `closing line${inbox}, goodbye ${coverage} ≥ ${Math.round(GOODBYE_AUDIO_COVERAGE_MIN * 100)}%, ` +
      `hang-up ${delay} after goodbye audio ` +
      `(drain ${END_CALL_POLL_MS}ms×${END_CALL_SETTLE_POLLS} + ${END_CALL_AUDIO_GRACE_MS}ms grace)`,
  };
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Redact PII the way the session-evidence exporter does before persisting. */
export function redactTranscript(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d ()-]{7,}\d/g, "[phone]")
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, "[credential]");
}

export function redactLines(stdout: string, limit = 200): string[] {
  return stdout
    .split("\n")
    .map((line) => redactTranscript(line).trim())
    .filter(Boolean)
    .slice(0, limit);
}

// ── Gate: filler-resume (ticket 04, owner: filler section) ────────────────────

/**
 * Ticket 04: filler-ignored + resume-tail gate.
 *
 * Back-channels never derail the Demo call: filler, back-channel speech and
 * the agent's own echo must never steal the floor. The source of truth is
 * the overlap judge (`judgeOverlap` in ../voice/barge-in): filler/echo
 * resolve to "ignore" synchronously, commands and end-call requests to
 * "yield", and anything ambiguous goes to the Jev judge with a short
 * timeout and fail-closed heuristics (an undecided or timed-out judgment
 * yields, so the caller is answered instead of talked over).
 *
 * When a filler does briefly cut the agent, the recovery must be human: the
 * agent resumes exactly the unheard rest of the cut line (same
 * `unheardRest` the session uses) within the resume-tail budget, and never
 * answers over the resumption.
 *
 * Thresholds quoted, not retuned (spec: the harness proves the baseline):
 * - overlap judge budget BARGE_IN_JUDGE_MS (400ms) decides yield vs resume;
 * - the session waits RESUME_WAIT_MS (500ms) for the server's own reply to
 *   the barge-in, then falls back after NO_WORDS_RESUME_MS (800ms) with no
 *   caller words — both well inside the resume-tail budget below.
 */

/** A brief filler cut recovers with the exact unheard tail inside this budget (spec story 6). */
export const FILLER_RESUME_TAIL_BUDGET_MS = SCOREBOARD_BUDGETS.fillerResumeTailMs.value;

/**
 * Resolved overlap outcome the pipeline reported for the filler beat:
 * the synchronous judge verdict, or "keep" once the Jev judge decided an
 * ambiguous overlap was not real and the agent resumed.
 */
export type FillerVerdict = OverlapVerdict | "keep";

/** Observed evidence for the filler-ignored beat: what the caller said, what the floor did. */
export type FillerResumeEvidence = {
  /** The overlapping visitor speech ("Okaay so", "mm-hmm", "yeah", agent echo). */
  visitorText: string;
  /** The agent line it overlapped (source for the echo check and the resume tail). */
  agentText: string;
  /** What the pipeline decided: ignore/keep resumes, yield (or undecided judge) steals the floor. */
  verdict: FillerVerdict;
  /** Visitor-speech-start → agent-audio-stop; null when the filler never cut. */
  cutMs: number | null;
  /** Cut → resume first audio; null when never cut, or when cut and never resumed. */
  resumeMs: number | null;
  /** What the agent said as the resume ("" when never cut). */
  resumedText: string;
  /** Agent words heard before the cut (the resume re-says the cut word, then the rest). */
  heardText: string;
  /** The server answered over the resumption instead of letting it play. */
  answeredOver: boolean;
  /**
   * The runner observed a cut whose latency could not be measured. Keeps the
   * gate on the cut path (never a never-cut PASS) without inventing an ms.
   */
  cutObserved?: boolean;
  /**
   * The answer kept playing through the back-channel instead of being
   * dropped or replaced. Optional: CLI-flag evidence predates the runner's
   * answer marker and leaves it unmeasured (undefined, never a guessed true).
   */
  answerContinued?: boolean;
  /**
   * How the turn resolved for this filler verdict, in the ledger's own
   * vocabulary: a filler must be `resumed-from` (or `heard-only` when the
   * answer never cut), never `answered`. Derived from the runner's observed
   * marker; undefined when the evidence predates it (unmeasured, not guessed).
   */
  handling?: OverheardHandling;
  /** Call trace turn the failure points at (spec: every failure names its turn). */
  traceTurn?: string;
};

/** The runner's own answer marker for one filler overlap. */
export type FillerAnswerMarker = "continued" | "resumed" | "dropped" | "derailed";

/**
 * Resolve the overlap handling from the runner's observed answer marker. The
 * marker is evidence, so this maps it; it never decides that a filler was
 * "answered" unless the runner actually observed an answer instead of a
 * resume. `null` stays unmeasured (older evidence), never a guessed value.
 *
 * A filler's answer **continuing** through the back-channel is `heard-only`
 * (the floor never moved); a filler that cut and picked the tail back up is
 * `resumed-from`; one that was treated as a new turn is `answered`; one whose
 * answer vanished is `lost`.
 */
export function fillerHandlingFor(answer: FillerAnswerMarker | null): OverheardHandling | null {
  switch (answer) {
    case null:
      return null;
    case "continued":
      return "heard-only";
    case "resumed":
      return "resumed-from";
    case "derailed":
      return "answered";
    case "dropped":
      return "lost";
  }
}

/**
 * The tail evidence the live runner captured for a filler cut: the agent
 * line it interrupted, the words the caller heard before the cut, and the
 * words the agent said as the resume, plus cut → resume first audio. The
 * scoreboard compares the resume with `unheardRest` itself, so a skip or a
 * paraphrase can never be blessed by a boolean.
 */
export type FillerTailEvidence = {
  /** The full agent line the filler overlapped (source of the unheard rest). */
  agentText: string;
  /** Words of that line whose audio had played before the server cut. */
  heardText: string;
  /** What the agent said as the resume ("" when it never played one). */
  resumedText: string;
  /** Cut → resume first audio; null when the resume never played. */
  resumeMs: number | null;
};

/**
 * What the live eval runner observed for one filler overlap. The runner
 * prints one line per run:
 *
 *   filler never cut; events [["ignore","Okaay so"]]; handling heard-only
 *   filler cut at 318ms; events [["ignore","Okaay so"]]; handling resumed-from;
 *     tail {"agent":"…","heard":"…","resumed":"…","resumeMs":412}
 *
 * `events` is the floor's own overlap decisions; `handling` is how the turn
 * resolved (filler never "answer"); `tail` is the verbatim cut/resume
 * evidence. The `answer …`, `handling …` and `tail …` suffixes are all
 * optional so older runs still parse, but an absent suffix stays unmeasured
 * rather than assumed.
 */
export type FillerRunObservation = {
  visitorText: string;
  verdict: FillerVerdict;
  /** The runner observed a cut (even when its latency could not be measured). */
  cut: boolean;
  /** Caller-speech-start → agent-audio-stop; null when the filler never cut. */
  cutMs: number | null;
  /** A cut was followed by the session's resume create. */
  resumed: boolean;
  /** The answer continued/resumed; false when it was dropped/derailed. */
  answerContinued: boolean | null;
  /** How the turn resolved, from the runner's own marker (null = unmeasured). */
  handling: OverheardHandling | null;
  /** The cut/resume tail evidence, or null when the runner captured none. */
  tail: FillerTailEvidence | null;
};

/**
 * Parse the runner's last `filler …` observation. Returns null when the run
 * printed no filler line or the line is malformed — absent evidence, never a
 * guessed verdict. The last line wins because a multi-run score is judged on
 * the most recent observed call, matching `extractTraceSessionId`.
 */
export function parseFillerRunOutput(stdout: string): FillerRunObservation | null {
  let last: RegExpExecArray | null = null;
  const pattern =
    /^\s*filler (never cut|cut(?: at (\d+(?:\.\d+)?)ms)?); events (\[.*?\])(?:; answer (continued|resumed|dropped|derailed))?(?:; handling (answered|resumed-from|heard-only|lost))?(?:; tail (\{.*\}))?(?:; said ("(?:[^"\\]|\\.)*"))?\s*$/gm;
  for (const match of stdout.matchAll(pattern)) last = match as RegExpExecArray;
  if (!last) return null;
  let events: unknown;
  try {
    events = JSON.parse(last[3]);
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  if (lastEvent !== null && (!Array.isArray(lastEvent) || lastEvent.length < 2)) return null;
  let saidText: string | null = null;
  if (last[7] !== undefined) {
    try {
      const parsed = JSON.parse(last[7]);
      if (typeof parsed === "string" && parsed.trim()) saidText = parsed;
    } catch {
      return null;
    }
  }
  const verdict = Array.isArray(lastEvent) ? lastEvent[0] : null;
  const eventText = Array.isArray(lastEvent) ? lastEvent[1] : saidText;
  // A run where no overlap reached the floor still has evidence when the
  // runner said which filler it tried: the floor held (or the answer ended
  // before the words landed). Without that text there is nothing to score.
  if (events.length === 0 && !saidText) return null;
  if (eventText === null || eventText === undefined) return null;
  const visitorText = String(eventText);
  if (!["yield", "ignore", "judge", "keep"].includes(String(verdict ?? "ignore"))) return null;
  if (!visitorText.trim()) return null;
  const cutMs = last[2] === undefined ? null : Number(last[2]);
  if (cutMs !== null && !Number.isFinite(cutMs)) return null;
  const cut = last[1] !== "never cut";
  const answer = (last[4] ?? null) as FillerAnswerMarker | null;
  const reportedHandling = (last[5] ?? null) as OverheardHandling | null;
  const handling = reportedHandling ?? fillerHandlingFor(answer);
  let tail: FillerTailEvidence | null = null;
  if (last[6] !== undefined) {
    let rawTail: unknown;
    try {
      rawTail = JSON.parse(last[6]);
    } catch {
      return null;
    }
    const candidate = rawTail as { agent?: unknown; heard?: unknown; resumed?: unknown; resumeMs?: unknown } | null;
    if (candidate === null || typeof candidate !== "object") return null;
    if (
      typeof candidate.agent !== "string" ||
      typeof candidate.heard !== "string" ||
      typeof candidate.resumed !== "string"
    ) {
      return null;
    }
    const resumeMs = candidate.resumeMs ?? null;
    if (resumeMs !== null && (typeof resumeMs !== "number" || !Number.isFinite(resumeMs) || resumeMs < 0)) {
      return null;
    }
    tail = {
      agentText: candidate.agent,
      heardText: candidate.heard,
      resumedText: candidate.resumed,
      resumeMs,
    };
  }
  const answerContinued =
    handling !== null
      ? handling === "resumed-from" || handling === "heard-only"
      : answer !== null
        ? answer === "continued" || answer === "resumed"
        : null;
  return {
    visitorText,
    verdict: verdict as FillerVerdict,
    cut,
    cutMs,
    resumed: cut && (handling === "resumed-from" || answer === "resumed"),
    answerContinued,
    handling,
    tail,
  };
}

/**
 * Turn the runner's observation into gate evidence. A cut that resumed is
 * ticket 13's exact-tail evidence: it is only scoreable with the observed
 * tail, so the boolean alone never blesses it (returning null leaves the
 * skeleton INFO until the tail is measured). Never-cut and cut-that-stole or
 * dropped observations carry whatever tail the runner captured.
 */
export function fillerEvidenceFromRun(observation: FillerRunObservation): FillerResumeEvidence | null {
  // A cut that resumed is ticket 13's exact-tail evidence, so this never
  // blesses it from a boolean alone.
  if (observation.cut && observation.resumed && !observation.tail) return null;
  // A cut's tail is only comparable when the agent line it interrupted was
  // captured; without it the gate stays unmeasured rather than guessing.
  if (observation.cut && observation.tail && !observation.tail.agentText.trim()) return null;
  return {
    visitorText: observation.visitorText,
    agentText: observation.tail?.agentText ?? "",
    verdict: observation.verdict,
    cutMs: observation.cutMs,
    resumeMs: observation.tail?.resumeMs ?? null,
    resumedText: observation.tail?.resumedText ?? "",
    heardText: observation.tail?.heardText ?? "",
    answeredOver: false,
    ...(observation.cut ? { cutObserved: true } : {}),
    ...(observation.answerContinued !== null ? { answerContinued: observation.answerContinued } : {}),
    ...(observation.handling !== null ? { handling: observation.handling } : {}),
  };
}

/**
 * Gate the filler-ignored beat. PASS keeps the floor (or recovers it
 * humanly); every FAIL names the cut milliseconds, the judge verdict and
 * the Call trace turn so the failure points at a turn, not a vibe.
 */
export function evaluateFillerResumeGate(evidence: FillerResumeEvidence): ScoreboardGate {
  const name = "filler-resume";
  const trace = evidence.traceTurn ?? "(no turn merged)";
  const expected = judgeOverlap(evidence.visitorText, evidence.agentText);
  const cut =
    evidence.cutMs !== null ? `${evidence.cutMs}ms` : evidence.cutObserved ? "cut (unmeasured)" : "never cut";
  const handling = evidence.handling ?? "unmeasured";
  const fail = (detail: string): ScoreboardGate => ({
    name,
    status: "FAIL",
    detail: `${detail} (cut: ${cut}; judge verdict: ${evidence.verdict}, expected: ${expected}; handling: ${handling}; trace: ${trace})`,
  });
  const cutObserved = evidence.cutMs !== null || evidence.cutObserved === true;
  const tail = unheardRest(evidence.agentText, evidence.heardText);
  // The cut can land after the answer's last word (measured live: the filler
  // hit 2213ms in, when nothing was left unheard). There is then nothing to
  // resume: skipping the resume is correct, not a dropped tail.
  if (
    cutObserved &&
    evidence.agentText.trim() !== "" &&
    (tail.trim() === "" || nothingLeftUnheard(evidence.agentText, evidence.heardText)) &&
    evidence.resumeMs === null &&
    evidence.resumedText.trim() === "" &&
    !evidence.answeredOver
  ) {
    return {
      name,
      status: "PASS",
      detail:
        `filler "${evidence.visitorText}" cut at ${cut} with no unheard tail ` +
        `(the cut landed after the answer finished); nothing left unheard; handling: ${handling}; trace: ${trace}`,
    };
  }
  // Not filler at all: steering, end-call and real content yield per the
  // judge. Blessing a yield here would hide a threshold regression, and the
  // real-cut ticket owns the yield path.
  if (expected === "yield") {
    return fail(`not filler per the overlap judge: "${evidence.visitorText}" yields`);
  }
  // Fail-closed: a stolen floor, or an ambiguous overlap still held for the
  // judge, counts as derailed — the caller must be answered, not resumed.
  if (evidence.verdict === "yield" || evidence.verdict === "judge") {
    return fail(`floor stolen by back-channel "${evidence.visitorText}": fail-closed yield`);
  }
  // Ambiguous overlap resumes only on an explicit Jev keep.
  if (expected === "judge" && evidence.verdict !== "keep") {
    return fail(`ambiguous overlap "${evidence.visitorText}" resumed without a Jev keep`);
  }
  // A filler is resumed-from (or heard-only when the answer never cut); the
  // runner observed the turn resolving as a fresh answer instead.
  if (evidence.handling === "answered") {
    return fail(`filler "${evidence.visitorText}" was answered instead of resumed-from`);
  }
  if (evidence.cutMs === null && !evidence.cutObserved && evidence.answerContinued === false) {
    return fail(
      `answer dropped: the back-channel did not let "${evidence.visitorText}" pass through the answer`,
    );
  }
  if (evidence.cutMs === null && !evidence.cutObserved) {
    if (evidence.resumeMs !== null || evidence.answeredOver) {
      return fail("inconsistent evidence: never cut but a resume was reported");
    }
    return {
      name,
      status: "PASS",
      detail: `filler "${evidence.visitorText}" ignored (judge verdict: ${evidence.verdict}, expected: ${expected}); floor held, never cut; handling: ${handling}; trace: ${trace}`,
    };
  }
  if (evidence.resumeMs === null) {
    return fail("brief cut never resumed: the exact unheard tail never played");
  }
  if (evidence.resumeMs > FILLER_RESUME_TAIL_BUDGET_MS) {
    return fail(
      `resume tail too slow: ${evidence.resumeMs}ms exceeds the ${FILLER_RESUME_TAIL_BUDGET_MS}ms budget (judge ${BARGE_IN_JUDGE_MS}ms + server-wait ${RESUME_WAIT_MS}ms + no-words ${NO_WORDS_RESUME_MS}ms)`,
    );
  }
  if (evidence.answeredOver) {
    return fail("answered over the resumption instead of resuming the exact tail");
  }
  if (evidence.resumedText.trim() !== tail.trim()) {
    return fail(`resume tail inexact: said "${evidence.resumedText}" instead of "${tail}"`);
  }
  return {
    name,
    status: "PASS",
    detail: `filler "${evidence.visitorText}" cut at ${evidence.cutMs}ms (judge verdict: ${evidence.verdict}), resumed the exact tail in ${evidence.resumeMs}ms (budget ${FILLER_RESUME_TAIL_BUDGET_MS}ms); handling: ${handling}; trace: ${trace}`,
  };
}

// ── Gate: barge-in-cut (ticket 05, owner: real-cut section) ───────────────────

/**
 * Ticket 05: real-cut answered gate (spec story 4).
 *
 * A real Barge-in with a point always wins the floor fast and gets answered,
 * never resumed-over. The server owns the cut (ADR-0003): the session stops
 * the agent, then the overlap judge decides yield versus resume. This gate
 * reuses that same judge, so "real" here means exactly what the pipeline
 * yields on: steering, command, and end-call requests always yield, and
 * multi-word content goes to Jev, which fail-closes to yield (only a real
 * Jev "keep" resumes). Filler, back-channels, and echo never yield.
 */

/** A real cut lands within the stop-over 1.5s bar (spec story 4). */
export const REAL_CUT_MAX_MS = SCOREBOARD_BUDGETS.realCutMs.value;

/** Eval scenarios whose output carries real-cut evidence. */
export const REAL_CUT_SCENARIOS = ["stop-over", "hang-up-over", "hang-up-fast"] as const;

/**
 * The live runner's proof line for a post-cut answer. score-demo reads only
 * this line (never the cut ms) to decide `answered`, so a fast cut alone can
 * never green the point.
 */
export const REAL_CUT_ANSWER_PREFIX = "answered the point after the cut:";

/**
 * Whether a reply.create instruction is the agent picking up the abandoned
 * tail after a cut. The session's resume path quotes the unheard rest "word
 * for word"; the older floor phrasing is kept so a replay still matches.
 */
export function isResumeInstructions(instructions: string): boolean {
  return /finish your sentence|pick up where you left off|word for word:/i.test(instructions);
}

/**
 * What a post-cut answer transcript can honestly prove: the caller's point
 * reached the session, a fresh agent turn followed the cut, and the session
 * never sent a resume of the abandoned tail. It does not judge semantics — the
 * transcript it returns is the reviewable evidence, not a model's opinion.
 */
export type PostCutAnswerEvidence = {
  answered: boolean;
  /** The fresh agent line after the cut, or null. */
  answer: string | null;
  /** The resume instruction sent after the cut, or null. */
  resumed: string | null;
  /** The caller's point appeared in a final user transcript. */
  pointHeard: boolean;
  /** Why the cut was not answered, or null when it was. */
  reason: string | null;
};

export function heardPoint(heard: string[], point: string): boolean {
  const needle = traceLineWords(point);
  if (!needle) return false;
  return heard.some((line) => ` ${traceLineWords(line)} `.includes(` ${needle} `));
}

/**
 * The fresh agent line that followed both the cut and the caller's point. The
 * point's own transcript is the floor: an acknowledgement that landed before
 * the point can never be mistaken for the answer. Null without a cut, and the
 * interrupted reply is excluded by id.
 */
export function postCutAnswerText(input: {
  cutAt: number | null;
  cutReplyId: string | null;
  point: string;
  heardTurns: { text: string; at: number }[];
  agentTurns: { replyId: string | null; text: string; at: number }[];
}): string | null {
  if (input.cutAt === null) return null;
  const pointHeardAt =
    input.heardTurns.find((turn) => heardPoint([turn.text], input.point))?.at ?? input.cutAt;
  const from = Math.max(input.cutAt, pointHeardAt);
  return (
    input.agentTurns.find(
      (turn) => turn.replyId !== input.cutReplyId && turn.at >= from && turn.text.trim(),
    )?.text ?? null
  );
}

export function judgePostCutAnswer(input: {
  point: string;
  heard: string[];
  answer: string | null;
  creates: string[];
}): PostCutAnswerEvidence {
  const answer = input.answer?.trim() ? input.answer : null;
  const pointHeard = heardPoint(input.heard, input.point);
  const resumed = input.creates.find((line) => isResumeInstructions(line)) ?? null;
  const reason = resumed
    ? "resumed the abandoned tail instead of answering"
    : !pointHeard
      ? "the caller's point was never heard"
      : answer === null
        ? "no agent answer after the cut"
        : null;
  return { answered: reason === null, answer, resumed, pointHeard, reason };
}

/**
 * Externally observable real-cut evidence: cut latency from caller speech
 * start to the server cut, the judge verdict from the session events, whether
 * the agent answered the point, whether old material was resumed instead, and
 * the Call trace turn that shows it. `ended` covers end-call requests, whose
 * yield is the goodbye plus hang-up rather than a measured cut.
 */
export type RealCutEvidence = {
  cutMs: number | null;
  verdict: string | null;
  verdictSource: string | null;
  answered: boolean;
  resumed: boolean;
  ended: boolean;
  traceTurn: string | null;
};

/**
 * Whether caller speech over the agent is real enough to yield, using the
 * shared overlap judge (barge-in.ts) and its thresholds — never a copy of
 * them. Command ("stop", "hold on") and end-call ("hang up") requests always
 * yield; content ("tell me the price please") goes to the judge; filler
 * ("mm-hmm", "Okaay so") and echo never do.
 */
export function isRealCutExpected(visitorText: string, agentText = ""): boolean {
  return judgeOverlap(visitorText, agentText) !== "ignore";
}

/** Failure detail always reports cut ms plus judge verdict with the trace turn. */
function realCutDetail(evidence: RealCutEvidence, reason: string): string {
  const cut = evidence.cutMs === null ? "never cut" : `cut ${evidence.cutMs}ms`;
  const verdict = evidence.verdict ?? "unreported";
  const source = evidence.verdictSource ? `/${evidence.verdictSource}` : "";
  const trace = evidence.traceTurn ?? "no Call trace turn merged";
  return `${cut} (verdict ${verdict}${source}; trace: ${trace}) — ${reason}`;
}

/**
 * The real-cut gate: PASS only when a real cut yields fast and is answered
 * on point with no resume of old material. Every FAIL names the cut
 * milliseconds, the judge verdict, and the Call trace turn (or says no turn
 * was merged). A cut measured on a changed caller clip is a FAIL: the number
 * is not comparable with the prior run, so it can never green on a shorter
 * or differently synthesized take.
 */
export function evaluateRealCut(
  evidence: RealCutEvidence,
  clipDrift: string | null = null,
): ScoreboardGate {
  if (clipDrift) {
    return {
      name: "barge-in-cut",
      status: "FAIL",
      detail: realCutDetail(
        evidence,
        `caller clip changed since the prior run (${clipDrift}); the cut number is not comparable`,
      ),
    };
  }
  if (evidence.resumed) {
    return {
      name: "barge-in-cut",
      status: "FAIL",
      detail: realCutDetail(evidence, "resumed with old material instead of answering"),
    };
  }
  if (evidence.cutMs === null && !evidence.ended) {
    return {
      name: "barge-in-cut",
      status: "FAIL",
      detail: realCutDetail(evidence, "never cut"),
    };
  }
  if (evidence.cutMs !== null && evidence.cutMs > REAL_CUT_MAX_MS) {
    return {
      name: "barge-in-cut",
      status: "FAIL",
      detail: realCutDetail(
        evidence,
        `cut too late: ${evidence.cutMs}ms exceeds ${REAL_CUT_MAX_MS}ms`,
      ),
    };
  }
  if (!evidence.answered && !evidence.ended) {
    return {
      name: "barge-in-cut",
      status: "FAIL",
      detail: realCutDetail(evidence, "the point was never answered"),
    };
  }
  const cut = evidence.cutMs === null ? "yielded; session ended with no resume" : `answered in ${evidence.cutMs}ms`;
  const trace = evidence.traceTurn ? `; trace: ${evidence.traceTurn}` : "";
  return {
    name: "barge-in-cut",
    status: "PASS",
    detail: `real cut ${cut} (verdict ${evidence.verdict ?? "unreported"})${trace}`,
  };
}

/**
 * Parse real-cut evidence from the eval runner's stdout. Returns null when
 * the output carries no real-cut scenario summary, so unrelated scenarios
 * leave the gate ungated. A stop-over run counts as answered only when the
 * runner printed its post-cut answer line: a fast cut by itself is not proof
 * that the point was answered. When the merged Call trace excerpt is supplied,
 * the evidence points at the turn after the cut — the answer turn on a PASS,
 * the resume turn on a FAIL.
 */
export function extractRealCutEvidence(stdout: string, excerpt: string[] = []): RealCutEvidence | null {
  const summary = stdout.match(/^(stop-over|hang-up-over|hang-up-fast): (\d+)\/(\d+)/m);
  if (!summary) return null;
  const scenario = summary[1];
  const passed = Number(summary[2]) > 0;
  const cut = stdout.match(/cut (\d+(?:\.\d+)?)ms after the caller started/);
  const verdict = stdout.match(/\["(yield|ignore|keep|judge)"(,|\])/)?.[1] ?? null;
  const resumed =
    /resumed (?:instead of|after)|Pick up where you left off|Finish your sentence/i.test(stdout);
  const ended = scenario.startsWith("hang-up") && passed && !resumed;
  const answeredLine = stdout
    .split("\n")
    .some((line) => line.trimStart().startsWith(`${REAL_CUT_ANSWER_PREFIX} "`));
  const answered = scenario === "stop-over" ? answeredLine && !resumed : passed && !resumed;
  const pointers = traceTurnPointers(excerpt);
  const turn = cut
    ? (pointers.answerTurn ?? pointers.cutTurn)
    : (pointers.cutTurn ?? pointers.goodbyeTurn);
  return {
    cutMs: cut ? Number(cut[1]) : null,
    verdict,
    verdictSource: null,
    answered,
    resumed,
    ended,
    traceTurn: turn !== null ? formatTraceTurn(turn) : null,
  };
}

/** Stamp evaluated real-cut evidence onto the artifact beat and gate. */
export function applyRealCutGate(
  artifact: ScoreboardArtifact,
  evidence: RealCutEvidence,
  clipDrift: string | null = null,
): ScoreboardArtifact {
  const gate = evaluateRealCut(evidence, clipDrift);
  const prior = artifact.beats["real-cut-answered"];
  const gates = artifact.gates.map((g) => (g.name === "barge-in-cut" ? gate : g));
  return {
    ...artifact,
    beats: {
      ...artifact.beats,
      "real-cut-answered": {
        gapMs: prior.gapMs,
        gapSamples: prior.gapSamples,
        cutMs: evidence.cutMs,
        resumeMs: prior.resumeMs,
        drainMs: null,
        status: gate.status === "PASS" ? "PASS" : "FAIL",
        note: gate.detail,
      } satisfies BeatTiming,
    },
    gates,
    subScores: buildSubScores(gates),
  };
}

// ── Gate: greeting-cut (ticket 08, owner: greeting-cut section) ─────────────

/**
 * Ticket 08: the greeting cut is the caller's first impression (spec story 1).
 *
 * "Wait, stop." one second into the greeting always cuts the greeting inside
 * the locked window. The bar is the greeting window in GOLDEN_SCRIPT, which
 * quotes the same 1.5s cut contract as the real cut — quoted, never retuned.
 * The scenario asserts it on the runner side and the scoreboard gates the
 * measured number, so a slow greeting can never green on INFO.
 */
export const GREETING_CUT_MAX_MS = GOLDEN_SCRIPT.find((beat) => beat.beat === "greeting-cut")!.window.max;

/**
 * Externally observable greeting-cut evidence: the measured cut latency and
 * the Call trace turn that shows it. `cutMs: null` with a failed scenario
 * summary is a measured "never cut"; no summary at all stays unmeasured.
 */
export type GreetingCutEvidence = {
  cutMs: number | null;
  traceTurn: string | null;
};

/**
 * The greeting-cut scenario's own pass predicate (runner side): a measured
 * cut at or inside the greeting budget passes; beyond it fails with the ms.
 * Same inclusive bound as the stop-over contract, so the two never diverge.
 */
export function greetingCutFailure(cutMs: number | null, reason: CutLatencyReason | null = null): string | null {
  if (cutMs === null) return `greeting never cut (${reason ?? "no cut"})`;
  return cutMs <= GREETING_CUT_MAX_MS ? null : `greeting cut too late: ${cutMs}ms`;
}

/**
 * The Call trace turn a greeting-cut failure cites: the first interrupted
 * reply (`CUT at`), else the call's first agent reply — structurally the
 * greeting that held too long. Null only when the merged excerpt carries no
 * VONI row, so the detail says "no Call trace turn merged" instead of
 * inventing a pointer.
 */
export function greetingCutTraceTurn(excerpt: string[]): number | null {
  const { cutTurn } = traceTurnPointers(excerpt);
  if (cutTurn !== null) return cutTurn;
  return excerpt.some((line) => line.includes("  VONI    ")) ? 1 : null;
}

/**
 * Parse greeting-cut evidence from the eval runner's stdout. A scenario
 * summary is required; without the numeric line a passed run stays
 * unmeasured (INFO, never a false PASS), while a failed run is evidence the
 * greeting never cut.
 */
export function extractGreetingCutEvidence(
  stdout: string,
  excerpt: string[] = [],
  sessionId: string | null = null,
): GreetingCutEvidence | null {
  const summary = stdout.match(/^greeting-cut: (\d+)\/(\d+)/m);
  if (!summary) return null;
  const passed = Number(summary[1]) > 0;
  const cut = stdout.match(/greeting cut (\d+(?:\.\d+)?)ms after the caller started/);
  if (!cut && passed) return null;
  const turn = greetingCutTraceTurn(excerpt);
  return {
    cutMs: cut ? Number(cut[1]) : null,
    traceTurn: turn !== null ? formatTraceTurn(turn, sessionId) : null,
  };
}

function greetingCutDetail(evidence: GreetingCutEvidence, reason: string): string {
  const cut = evidence.cutMs === null ? "never cut" : `cut ${evidence.cutMs}ms`;
  const trace = evidence.traceTurn ?? "no Call trace turn merged";
  return `${cut} (trace: ${trace}) — ${reason}`;
}

/** The greeting-cut gate: PASS inside the locked window, FAIL beyond it or never cut. */
export function evaluateGreetingCut(evidence: GreetingCutEvidence): ScoreboardGate {
  if (evidence.cutMs === null) {
    return {
      name: "greeting-cut",
      status: "FAIL",
      detail: greetingCutDetail(evidence, "the greeting held too long: it was never cut"),
    };
  }
  if (evidence.cutMs > GREETING_CUT_MAX_MS) {
    return {
      name: "greeting-cut",
      status: "FAIL",
      detail: greetingCutDetail(
        evidence,
        `cut too late: ${evidence.cutMs}ms exceeds ${GREETING_CUT_MAX_MS}ms`,
      ),
    };
  }
  const trace = evidence.traceTurn ?? "no Call trace turn merged";
  return {
    name: "greeting-cut",
    status: "PASS",
    detail: `greeting cut in ${evidence.cutMs}ms (budget ${GREETING_CUT_MAX_MS}ms; trace: ${trace})`,
  };
}

/** Stamp evaluated greeting-cut evidence onto the artifact beat and gate. */
export function applyGreetingCutGate(
  artifact: ScoreboardArtifact,
  evidence: GreetingCutEvidence,
): ScoreboardArtifact {
  const gate = evaluateGreetingCut(evidence);
  const prior = artifact.beats["greeting-cut"];
  const gates = artifact.gates.map((g) => (g.name === "greeting-cut" ? gate : g));
  return {
    ...artifact,
    beats: {
      ...artifact.beats,
      "greeting-cut": {
        gapMs: prior.gapMs,
        gapSamples: prior.gapSamples,
        cutMs: evidence.cutMs,
        resumeMs: prior.resumeMs,
        drainMs: prior.drainMs,
        status: gate.status,
        note: gate.detail,
      } satisfies BeatTiming,
    },
    gates,
    subScores: buildSubScores(gates),
  };
}

// ── Measurement: fixed-clip cut latency (ticket 05, owner: real-cut section) ─

/**
 * Ticket 05: cut latency is only comparable across runs when both ends of
 * the interval are fixed.
 *
 * t0 is caller speech start — the moment the pump actually transmits the
 * clip's first voiced sample — not the tick that enqueued the clip. t1 is
 * the server cut (the session flushes the playout on an interrupted
 * `reply.done`; the client never cuts locally, ADR-0003). The clip itself is
 * pinned by a fingerprint over its words, byte length, duration, and leading
 * silence, so a re-synthesized take or an edited line is detectable instead
 * of silently moving the baseline.
 */

/** PCM16 sample magnitude at or below which a sample counts as pre-speech silence. */
export const CALLER_ONSET_SILENCE = 120;

/** Fixed identity of one caller clip: same words, same audio, same onset. */
export type CallerClipFingerprint = {
  /** The fixed words the clip speaks. */
  text: string;
  /** PCM16 mono bytes (identical bytes ⇒ identical duration and audio). */
  bytes: number;
  durationMs: number;
  sha256: string;
  /** Leading silence before the first voiced sample (clip-relative ms). */
  onsetMs: number;
};

/** Clip-relative offset of the first sample louder than the silence floor. */
export function callerClipOnsetMs(pcm: Uint8Array, sampleRate = 24_000): number {
  if (sampleRate <= 0) throw new Error(`sampleRate must be positive, got ${sampleRate}`);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  for (let i = 0; i < samples; i += 1) {
    if (Math.abs(view.getInt16(i * 2, true)) > CALLER_ONSET_SILENCE) return (i / sampleRate) * 1000;
  }
  // All silence: the clip never voices, so its onset is its end.
  return (samples / sampleRate) * 1000;
}

/** Pin one caller clip so a changed take is detectable, never a silent baseline shift. */
export function callerClipFingerprint(
  text: string,
  pcm: Uint8Array,
  sampleRate = 24_000,
): CallerClipFingerprint {
  return {
    text,
    bytes: pcm.byteLength,
    durationMs: Math.round((pcm.byteLength / 2 / sampleRate) * 1000),
    sha256: sha256Hex(pcm),
    onsetMs: Math.round(callerClipOnsetMs(pcm, sampleRate) * 1000) / 1000,
  };
}

/** null when the clips are identical; a human-readable reason when the clip changed. */
export function callerClipDrift(
  expected: CallerClipFingerprint,
  actual: CallerClipFingerprint,
): string | null {
  if (expected.text !== actual.text) {
    return `words differ: "${expected.text}" → "${actual.text}"`;
  }
  if (expected.bytes !== actual.bytes) {
    return `audio bytes differ: ${expected.bytes} → ${actual.bytes}`;
  }
  if (expected.durationMs !== actual.durationMs) {
    return `audio duration differs: ${expected.durationMs}ms → ${actual.durationMs}ms`;
  }
  if (expected.sha256 !== actual.sha256) {
    return `audio samples differ at the same length (sha256 ${expected.sha256.slice(0, 12)} → ${actual.sha256.slice(0, 12)})`;
  }
  if (expected.onsetMs !== actual.onsetMs) {
    return `caller onset differs: ${expected.onsetMs}ms → ${actual.onsetMs}ms`;
  }
  return null;
}

/**
 * Compare the caller clips a run measured against the prior run's pinned
 * fingerprints. Clips are matched by their fixed words (a scenario speaks a
 * fixed line), so a new scenario's clip is not drift; the same line with
 * different audio, duration, or onset is. Null means every compared clip is
 * byte-identical — cut latency stays comparable.
 */
export function callerClipChanges(
  prior: CallerClipFingerprint[] = [],
  next: CallerClipFingerprint[] = [],
): string | null {
  for (const actual of next) {
    const expected = prior.find((clip) => clip.text === actual.text);
    if (!expected) continue;
    const drift = callerClipDrift(expected, actual);
    if (drift) return `"${actual.text}" ${drift}`;
  }
  return null;
}

/**
 * What the runner knows about one caller clip at measure time.
 * `enqueuedAt` is kept only to prove t0 ignores it (and to flag an impossible
 * frame time); the pump fills `firstFrameAt` when it transmits the frame that
 * carries the clip's first voiced sample.
 */
export type CallerOnset = {
  /** Queue tick when say() appended the clip (the old, wrong t0). */
  enqueuedAt: number;
  /** Pump tick that transmitted the frame carrying the clip's first voiced sample. */
  firstFrameAt: number | null;
  /** Clip-relative offset of the first voiced sample. */
  onsetMs: number;
  /** Clip-relative offset where that transmitted frame begins (sub-frame precision). */
  frameOffsetMs?: number;
};

export type CutLatencyReason =
  | "no cut"
  | "caller speech never transmitted"
  | "frame before enqueue"
  | "cut before caller speech start";

export type CutLatency = {
  cutMs: number | null;
  speechStartedAt: number | null;
  /** Why no latency was produced; null when cutMs is measured. */
  reason: CutLatencyReason | null;
};

/** Caller speech start: the transmitted frame + the onset's offset inside it. */
export function callerSpeechStart(onset: CallerOnset): number | null {
  if (onset.firstFrameAt === null || onset.firstFrameAt < onset.enqueuedAt) return null;
  return onset.firstFrameAt + Math.max(0, onset.onsetMs - (onset.frameOffsetMs ?? 0));
}

/**
 * Cut latency from caller speech start to the server cut. A cut that lands
 * before the caller's onset is not a caller-caused cut, so it reports null
 * with a reason instead of a negative or enqueue-inflated number.
 */
export function measureCutLatency(onset: CallerOnset, cutAt: number | null): CutLatency {
  if (cutAt === null) return { cutMs: null, speechStartedAt: callerSpeechStart(onset), reason: "no cut" };
  if (onset.firstFrameAt === null) {
    return { cutMs: null, speechStartedAt: null, reason: "caller speech never transmitted" };
  }
  if (onset.firstFrameAt < onset.enqueuedAt) {
    return { cutMs: null, speechStartedAt: null, reason: "frame before enqueue" };
  }
  const speechStartedAt = callerSpeechStart(onset)!;
  if (cutAt < speechStartedAt) {
    return { cutMs: null, speechStartedAt, reason: "cut before caller speech start" };
  }
  return { cutMs: cutAt - speechStartedAt, speechStartedAt, reason: null };
}

// ── Plumbing versus judgment: the eval runner's outcome (ticket 06) ──────────
// The runner finishing proves the pipes are healthy; only scoreboard gates
// decide PASS or FAIL. Scenario failures and measured gate breaches are
// judgment. A spawn failure, a kill, a crash, a run with no summary, a run
// that opened no Call trace session, or a run that received no agent audio is
// a harness break: the numbers were never taken, so triage starts at the
// harness, never at the thresholds.

/** One scenario row the runner printed: `stop-over: 0/1`. */
export type RunnerScenarioSummary = { name: string; passed: number; runs: number };

/** Wall-clock playout for one live voice-session run; reported, never gated. */
export type RunnerPlayout = { scenario: string; run: number; wallClockMs: number };

/** The final machine-readable line the eval runner prints: `EVAL SUMMARY {...}`. */
export type EvalRunnerSummary = {
  scenario: string;
  runs: number;
  failures: number;
  scenarios: RunnerScenarioSummary[];
  traceSessions: string[];
  playout: RunnerPlayout[];
  /** Agent audio chunks received by live client runs; null when none ran. */
  audioChunks: number | null;
  /** At least one live scenario was attempted. */
  live: boolean;
  /** Fixed caller clips streamed this run, with their audio fingerprints. */
  clips?: CallerClipFingerprint[];
};

/** Why the harness broke, never why a gate failed. */
export type RunnerBreakReason =
  | "spawn-failed"
  | "killed"
  | "crashed"
  | "missing-summary"
  | "missing-trace"
  | "missing-audio";

/** Runner outcome: finished (plumbing PASS) or harness break (plumbing FAIL). */
export type RunnerClassification = {
  status: "finished" | "harness-break";
  reason: RunnerBreakReason | null;
  detail: string;
  summary: EvalRunnerSummary | null;
  scenarios: RunnerScenarioSummary[];
};

function parseScenarioSummaries(stdout: string): RunnerScenarioSummary[] {
  const rows: RunnerScenarioSummary[] = [];
  for (const match of stdout.matchAll(/^([a-z][a-z0-9-]*): (\d+)\/(\d+)$/gm)) {
    rows.push({ name: match[1], passed: Number(match[2]), runs: Number(match[3]) });
  }
  return rows;
}

function parseEvalSummary(stdout: string): EvalRunnerSummary | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("EVAL SUMMARY ")) continue;
    try {
      const raw = JSON.parse(line.slice("EVAL SUMMARY ".length)) as Partial<EvalRunnerSummary>;
      if (raw === null || typeof raw !== "object") return null;
      const scenarios = Array.isArray(raw.scenarios)
        ? raw.scenarios
            .filter(
              (row): row is RunnerScenarioSummary =>
                row !== null &&
                typeof row === "object" &&
                typeof row.name === "string" &&
                Number.isFinite(row.passed) &&
                Number.isFinite(row.runs),
            )
            .map((row) => ({ name: row.name, passed: Number(row.passed), runs: Number(row.runs) }))
        : [];
      const playout = Array.isArray(raw.playout)
        ? raw.playout
            .filter(
              (row): row is RunnerPlayout =>
                row !== null &&
                typeof row === "object" &&
                typeof row.scenario === "string" &&
                Number.isFinite(row.run) &&
                Number.isFinite(row.wallClockMs),
            )
            .map((row) => ({
              scenario: row.scenario,
              run: Number(row.run),
              wallClockMs: Number(row.wallClockMs),
            }))
        : [];
      const clips = Array.isArray(raw.clips)
        ? raw.clips
            .filter(
              (clip): clip is CallerClipFingerprint =>
                clip !== null &&
                typeof clip === "object" &&
                typeof clip.text === "string" &&
                Number.isFinite(clip.bytes) &&
                Number.isFinite(clip.durationMs) &&
                typeof clip.sha256 === "string" &&
                Number.isFinite(clip.onsetMs),
            )
            .map((clip) => ({
              text: clip.text,
              bytes: Number(clip.bytes),
              durationMs: Number(clip.durationMs),
              sha256: clip.sha256,
              onsetMs: Number(clip.onsetMs),
            }))
        : [];
      return {
        scenario: typeof raw.scenario === "string" ? raw.scenario : "",
        runs: Number.isFinite(raw.runs) ? Number(raw.runs) : scenarios.reduce((sum, row) => sum + row.runs, 0),
        failures: Number.isFinite(raw.failures)
          ? Number(raw.failures)
          : scenarios.reduce((sum, row) => sum + (row.runs - row.passed), 0),
        scenarios,
        traceSessions: Array.isArray(raw.traceSessions)
          ? raw.traceSessions.filter((id): id is string => typeof id === "string" && id.length > 0)
          : [],
        playout,
        audioChunks:
          typeof raw.audioChunks === "number" && Number.isFinite(raw.audioChunks) ? raw.audioChunks : null,
        live: raw.live === true,
        ...(clips.length > 0 ? { clips } : {}),
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Caller clip fingerprints the runner printed in its summary; [] when none. */
export function callerClipsFromRunnerStdout(stdout: string): CallerClipFingerprint[] {
  return parseEvalSummary(stdout)?.clips ?? [];
}

function traceSessionsIn(stdout: string): string[] {
  const ids: string[] = [];
  for (const match of stdout.matchAll(/\btrace session (sess_[A-Za-z0-9_-]+)\b/g)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/**
 * Classify the eval runner by what it printed, never by scenario verdicts.
 * A summary proves the runner finished; any exit code then still means
 * plumbing PASS (scenario failures are judgment). No summary, a spawn error,
 * a kill, or a live run with no trace/audio is a harness break.
 */
export function classifyRunnerOutcome(input: {
  stdout: string;
  exitCode: number | null;
  error?: string | null;
}): RunnerClassification {
  const printed = parseScenarioSummaries(input.stdout);
  const summary = parseEvalSummary(input.stdout);
  const scenarios = summary && summary.scenarios.length > 0 ? summary.scenarios : printed;
  const harnessBreak = (reason: RunnerBreakReason, detail: string): RunnerClassification => ({
    status: "harness-break",
    reason,
    detail: `harness break: ${detail} (no gates measured; fix the harness, not the thresholds)`,
    summary,
    scenarios,
  });
  if (input.error) {
    return harnessBreak("spawn-failed", `eval runner spawn failed (${input.error})`);
  }
  if (summary === null && scenarios.length === 0) {
    if (input.exitCode === null) {
      return harnessBreak("killed", "eval runner was killed before printing a summary");
    }
    return input.exitCode === 0
      ? harnessBreak("missing-summary", "eval runner exited 0 without printing a summary")
      : harnessBreak("crashed", `eval runner exited ${input.exitCode} before printing a summary`);
  }
  // A summary is the runner's own proof it finished. Missing evidence the
  // run itself reports (trace/audio) breaks the harness, not a gate.
  if (summary && summary.live) {
    const sessions = summary.traceSessions.length > 0 ? summary.traceSessions : traceSessionsIn(input.stdout);
    if (sessions.length === 0) {
      return harnessBreak("missing-trace", "eval runner finished but opened no Call trace session (missing trace)");
    }
    if (summary.audioChunks === 0) {
      return harnessBreak("missing-audio", "eval runner finished but received no agent audio (missing audio)");
    }
  }
  const failures =
    summary?.failures ?? scenarios.reduce((sum, row) => sum + (row.runs - row.passed), 0);
  const scenarioCount = scenarios.length;
  return {
    status: "finished",
    reason: null,
    detail:
      `eval runner finished (${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"}, ` +
      `${failures} scenario failure${failures === 1 ? "" : "s"}) — plumbing PASS; gate judgment is separate`,
    summary,
    scenarios,
  };
}

/** Console line separating plumbing health and playout from gate verdicts. */
export function formatEvalRunnerReport(artifact: ScoreboardArtifact): string {
  const runner = artifact.evalRunner;
  const head =
    runner.status === "skipped"
      ? "eval runner: skipped (dry run)"
      : runner.status === "ok"
        ? `eval runner: finished in ${runner.durationMs}ms — plumbing PASS (scenario verdicts are judgment)`
        : `eval runner: HARNESS BREAK (${runner.breakReason ?? "unknown"}) — no plumbing measured; this is not a gate FAIL`;
  const rows = runner.timings.scenarioRuns;
  const playout =
    rows.length === 0
      ? "playout (wall clock, never gated): unmeasured"
      : `playout (wall clock, never gated): ${rows
          .map((row) => `${row.scenario} #${row.run} ${row.wallClockMs}ms`)
          .join(", ")}`;
  return `${head}\n${playout}`;
}

// ── Skeleton: plumbing, measurements, and gate assembly in spec priority ─────
// (ticket 01, owner: skeleton section). Gates report in the spec's fail-fast
// priority: plumbing (harness) → measurements → reply-gap → end-of-turn →
// greeting-cut (ticket 08, the greeting's own cut before barge-in) →
// barge-in-cut + filler-resume → overheard-recall → email-invite →
// double-talk → dead-air → end-call-drain → timbre-probes → accent-human →
// manual/external stubs. Console and artifact share this order.

/** Spec-priority gate order for fail-fast triage (spec implementation decision: gap → cut → overheard → naturalness). */
export const GATE_PRIORITY = [
  "plumbing",
  "measurements",
  "reply-gap",
  "end-of-turn",
  "greeting-cut",
  "barge-in-cut",
  "filler-resume",
  "overheard-recall",
  "email-invite",
  "double-talk",
  "dead-air",
  "end-call-drain",
  "timbre-probes",
  "accent-human",
  "phone-checklist",
  "talk-hold-pinned",
] as const;

/** Skeleton gates: reported but never failed without measured evidence. */
function skeletonGates(
  runnerOutcome: RunnerClassification | null,
  replySamples: ReplyGapSample[],
  traceSessionId: string | null,
  agentInput: { turn_detection?: unknown } | null | undefined,
  traceExcerpt: string[],
  fillerGate: ScoreboardGate | null = null,
  overheardGate: ScoreboardGate | null = null,
  deadAir?: DeadAirEvidence | null,
  doubleTalkInput?: DoubleTalkInput | null,
  endCallDrainInput?: EndCallDrainInput | null,
  probes?: TimbreProbes | null,
  agentChannel?: AgentChannelEvidence | null,
  humanRatings?: HumanRatings | null,
  voiceId?: string,
  options?: {
    measured?: boolean;
    measuredSources?: MeasuredEvidenceKind[];
  },
): ScoreboardGate[] {
  // Ticket 06: a finished runner is plumbing health even when its scenarios
  // or measured gates FAIL; only a harness break fails plumbing.
  const plumbing: ScoreboardGate =
    runnerOutcome === null
      ? { name: "plumbing", status: "PASS", detail: "dry run: eval runner skipped (placeholder, no audio measured)" }
      : runnerOutcome.status === "finished"
        ? { name: "plumbing", status: "PASS", detail: runnerOutcome.detail }
        : { name: "plumbing", status: "FAIL", detail: runnerOutcome.detail };
  // Finding B: a real (non-dry) run with zero measured evidence must fail
  // instead of greening on empty INFO gates. --dry-run stays explicit-dry.
  const dryRun = runnerOutcome === null;
  const measurements: ScoreboardGate =
    options?.measured || dryRun
      ? {
          name: "measurements",
          status: "INFO",
          reason: dryRun ? "dry-run" : "measured-evidence",
          detail: dryRun
            ? "dry run: no measurements required (explicit evidence still gates)"
            : `measured evidence present (${(options?.measuredSources ?? []).join(", ")})`,
        }
      : {
          name: "measurements",
          status: "FAIL",
          detail: "no measurements - run real audio or pass evidence flags",
        };
  const replyGate =
    replySamples.length > 0
      ? replyGapGate(replySamples, traceSessionId ?? undefined)
      : { name: "reply-gap", status: "INFO" as const, detail: "unmeasured: run --scenario all or pass --trace-session/--gap beat=ms to gate reply gaps" };
  const endOfTurn =
    agentInput === undefined
      ? { name: "end-of-turn", status: "INFO" as const, detail: "unmeasured: agent body not checked" }
      : meaningBasedEndOfTurnGate(agentInput, traceExcerpt);
  const filler: ScoreboardGate =
    fillerGate ?? { name: "filler-resume", status: "INFO", detail: "unmeasured: run --scenario filler-over or pass --filler-* evidence to gate filler recovery" };
  const deadAirGate: ScoreboardGate = deadAir
    ? evaluateDeadAir(deadAir)
    : {
        name: "dead-air",
        status: "INFO",
        detail: "unmeasured: supply --dead-air-gaps/--longest-silence-ms/--check-in-at-ms to gate",
      };
  const doubleTalkGate: ScoreboardGate = doubleTalkInput
    ? evaluateDoubleTalk(doubleTalkInput)
    : evaluateDoubleTalk({ overlapMs: [] });
  const endCallDrainGate: ScoreboardGate = endCallDrainInput
    ? evaluateEndCallDrain(endCallDrainInput)
    : evaluateEndCallDrain({ goodbyeCoverage: null, hangUpDelayMs: null, narratedEnding: false });
  const timbreProbes: TimbreProbes = probes ?? { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 };
  const timbreGate = evaluateTimbreGate({
    probes: timbreProbes,
    voiceId: voiceId ?? "",
    agentChannel: agentChannel ?? null,
  });
  const humanGate = evaluateHumanGate(timbreGate.status === "PASS", humanRatings ?? emptyHumanRatings(null));
  // Spec priority order (gap → cut → overheard → naturalness); failing
  // gates surface in this order for fail-fast triage.
  const gates: ScoreboardGate[] = [
    plumbing,
    measurements,
    replyGate,
    endOfTurn,
    {
      name: "greeting-cut",
      status: "INFO",
      detail: "unmeasured: run --scenario greeting-cut (the fixed caller clip) to gate the greeting cut",
    },
    {
      name: "barge-in-cut",
      status: "INFO",
      detail: "no real-cut evidence (run --scenario stop-over or pass --cut-ms/--cut-verdict/--cut-answered)",
    },
    filler,
    overheardGate ??
      { name: "overheard-recall", status: "INFO", detail: "unmeasured: run --scenario over-talk or pass --overheard-json to gate overheard recall" },
    { name: "email-invite", status: "INFO", detail: "unmeasured: run --scenario invite-tag or pass --email-json to gate the invite and chip" },
    doubleTalkGate,
    deadAirGate,
    endCallDrainGate,
    timbreGate,
    humanGate,
    // Review stubs, deliberately out of ticket scope: the real-phone
    // checklist and Talk/Hold pinning are manual/external, so they stay
    // INFO rows instead of a false green.
    {
      name: "phone-checklist",
      status: "INFO",
      detail: "manual: the real-phone checklist (app-switch/lock/reload/pop-probe calls) gates demo-readiness, not this command",
    },
    {
      name: "talk-hold-pinned",
      status: "INFO",
      detail: "talk clock/hold pinned externally (hold/flap/return suite); scoring never confuses absence handling with pipeline lag",
    },
  ];
  const rank = new Map<string, number>(GATE_PRIORITY.map((name, index) => [name, index] as const));
  return gates.toSorted(
    (a, b) => (rank.get(a.name) ?? GATE_PRIORITY.length) - (rank.get(b.name) ?? GATE_PRIORITY.length),
  );
}

/**
 * Every measured input the run can carry, in stable order. Presence alone is
 * not provenance: an empty container (no gaps, no asides, no dead-air rows)
 * means nothing was observed and is not reported.
 */
export const MEASURED_EVIDENCE_KINDS = [
  "gaps",
  "trace-gaps",
  "filler-resume",
  "overheard-asides",
  "dead-air",
  "double-talk",
  "end-call-drain",
  "timbre-probes",
  "agent-channel",
  "human-ratings",
  "greeting-cut",
  "real-cut",
  "email-invite",
] as const;

export type MeasuredEvidenceKind = (typeof MEASURED_EVIDENCE_KINDS)[number];

/**
 * Provenance classification for the measurements gate: which inputs carry
 * observed values. Empty containers and default placeholders return nothing,
 * so a dry run or an evidence-free real run can never look measured.
 */
export function measuredEvidenceSources(input: {
  gaps?: Partial<Record<GoldenBeat, number[]>>;
  traceGaps?: TraceGap[];
  fillerResume?: FillerResumeEvidence | null;
  overheardAsides?: OverheardAside[];
  deadAir?: DeadAirEvidence | null;
  doubleTalkOverlapMs?: number[];
  endCallDrain?: {
    goodbyeCoverage: number | null;
    hangUpDelayMs: number | null;
    narratedEnding: boolean;
    inboxNamed?: boolean | null;
    missingGoodbye?: boolean;
  };
  probes?: TimbreProbes;
  agentChannel?: AgentChannelEvidence | null;
  humanRatings?: HumanRatings;
  greetingCutEvidencePresent?: boolean;
  realCutEvidencePresent?: boolean;
  emailInviteEvidencePresent?: boolean;
}): MeasuredEvidenceKind[] {
  const sources: MeasuredEvidenceKind[] = [];
  if (input.gaps && Object.values(input.gaps).some((samples) => (samples ?? []).some((n) => Number.isFinite(n)))) {
    sources.push("gaps");
  }
  if ((input.traceGaps ?? []).some((gap) => Number.isFinite(gap.gapMs))) sources.push("trace-gaps");
  if (input.fillerResume != null) sources.push("filler-resume");
  if ((input.overheardAsides ?? []).length > 0) sources.push("overheard-asides");
  const deadAir = input.deadAir;
  if (
    deadAir &&
    (deadAir.gapsMs.length > 0 || deadAir.longestSilenceMs != null || deadAir.checkIns.length > 0)
  ) {
    sources.push("dead-air");
  }
  if ((input.doubleTalkOverlapMs ?? []).length > 0) sources.push("double-talk");
  const drain = input.endCallDrain;
  if (
    drain &&
    (drain.goodbyeCoverage != null ||
      drain.hangUpDelayMs != null ||
      drain.narratedEnding ||
      drain.missingGoodbye === true ||
      drain.inboxNamed != null)
  ) {
    sources.push("end-call-drain");
  }
  // Explicit probes (even all-zero) are a completed measurement; the artifact
  // only receives this field when --probe-json was actually read.
  if (input.probes !== undefined) sources.push("timbre-probes");
  if (input.agentChannel != null) sources.push("agent-channel");
  if ((input.humanRatings?.ratings ?? []).length > 0) sources.push("human-ratings");
  if (input.greetingCutEvidencePresent) sources.push("greeting-cut");
  if (input.realCutEvidencePresent) sources.push("real-cut");
  if (input.emailInviteEvidencePresent) sources.push("email-invite");
  return sources;
}

/**
 * Whether the run carries any measured evidence for the required gates.
 * Thin wrapper over measuredEvidenceSources so every caller shares one
 * provenance rule (empty containers and placeholders do not count).
 */
export function hasMeasuredEvidence(input: {
  gaps?: Partial<Record<GoldenBeat, number[]>>;
  traceGaps?: TraceGap[];
  fillerResume?: FillerResumeEvidence | null;
  overheardAsides?: OverheardAside[];
  deadAir?: DeadAirEvidence | null;
  doubleTalkOverlapMs?: number[];
  endCallDrain?: {
    goodbyeCoverage: number | null;
    hangUpDelayMs: number | null;
    narratedEnding: boolean;
    inboxNamed?: boolean | null;
    missingGoodbye?: boolean;
  };
  probes?: TimbreProbes;
  agentChannel?: AgentChannelEvidence | null;
  humanRatings?: HumanRatings;
  greetingCutEvidencePresent?: boolean;
  realCutEvidencePresent?: boolean;
  emailInviteEvidencePresent?: boolean;
}): boolean {
  return measuredEvidenceSources(input).length > 0;
}

function emptyOverheardByBeat(): Record<GoldenBeat, { recalled: number; total: number }> {
  return Object.fromEntries(
    GOLDEN_BEATS.map((beat) => [beat, { recalled: 0, total: 0 }]),
  ) as Record<GoldenBeat, { recalled: number; total: number }>;
}

export function buildSkeletonArtifact(input: {
  voice: string;
  scenario: string;
  runnerStdout: string;
  exitCode: number | null;
  durationMs: number;
  runs: number;
  /** Measured reply gaps per beat (visitor end-of-speech → first agent audio). Absent = unmeasured. */
  gaps?: Partial<Record<GoldenBeat, number[]>>;
  /**
   * Gaps merged from a Call trace excerpt (scripts/call-trace.mts `gap Nms`
   * numbers). The first merged turn attributes to a beat only when verified:
   * an explicit --trace-beat map, or a trace excerpt that opens with a
   * greeting-cut marker (see attributeFirstTraceGap). Unverified first turns
   * stay call-level. Later turns always stay call-level: only the golden
   * order is fixed, never the turn count (resumes and tool turns interleave).
   */
  traceGaps?: TraceGap[];
  /** Explicit beat map for the first merged trace turn (CLI --trace-beat). */
  traceBeat?: GoldenBeat | null;
  /** Dry run: skips the eval runner, stays green without measurements (explicit evidence still gates). */
  dryRun?: boolean;
  /** Eval-runner spawn failure text (harness break when set on a real run). */
  evalError?: string | null;
  /** Greeting-cut evidence handled outside the skeleton (parsed) counts as measured. */
  greetingCutEvidencePresent?: boolean;
  /** Real-cut evidence handled outside the skeleton (parsed or explicit flags) counts as measured. */
  realCutEvidencePresent?: boolean;
  /** Email-invite evidence handled outside the skeleton (runner line or --email-json) counts as measured. */
  emailInviteEvidencePresent?: boolean;
  /** Unique id for this run; generated when omitted. */
  runId?: string;
  /** Exact code the run executed on; tests inject it, the CLI reads git. */
  codeFingerprint?: CodeFingerprint | null;
  /** Session the gaps were merged from (trace pointer for a failing gate). */
  traceSessionId?: string | null;
  /** Stored agent body input for the end-of-turn check (undefined = not checked). */
  agentInput?: { turn_detection?: unknown } | null;
  /** Merged Call trace excerpt lines (scanned for turn_detection CONFIG lines). */
  traceExcerpt?: string[];
  /** Observed filler-beat evidence: when present, the filler-resume gate evaluates instead of staying INFO. */
  fillerResume?: FillerResumeEvidence | null;
  /** Overheard asides observed while Voni held the floor; omit to keep the skeleton INFO gate. */
  overheardAsides?: OverheardAside[];
  /** Measured dead-air evidence; omitted means unmeasured (gate stays INFO). */
  deadAir?: DeadAirEvidence | null;
  /** Measured audible overlap per cut; empty/omitted means unmeasured (INFO). */
  doubleTalkOverlapMs?: number[];
  /**
   * Trace pointer for a double-talk FAIL when the overlap came from a
   * different call than the merged excerpt (never cite another call's turn).
   */
  doubleTalkTraceRef?: string;
  /** Measured goodbye drain evidence; omitted means unmeasured (INFO). */
  endCallDrain?: {
    goodbyeCoverage: number | null;
    hangUpDelayMs: number | null;
    narratedEnding: boolean;
    inboxNamed?: boolean | null;
    missingGoodbye?: boolean;
  };
  /**
   * Trace pointer for a drain FAIL from evidence that measured its own closing
   * turn (the live runner's GOODBYE DRAIN line). Wins over the excerpt-derived
   * goodbye turn, which may belong to a different scenario's session.
   */
  endCallDrainTraceRef?: string;
  /** Trace pointer attached to failure details, e.g. a sess_ id. */
  traceRef?: string;
  /** Session onAudioProbe counts; zeroed in dry runs. */
  probes?: TimbreProbes;
  /** qa-voice-session agent-channel PCM analysis; absent in dry runs. */
  agentChannel?: AgentChannelEvidence | null;
  /** Blind ballots filed with --rate/--recording; empty until judged. */
  humanRatings?: HumanRatings;
  /** Fixed caller clip fingerprints the live runner streamed; absent means unrecorded. */
  callerClips?: CallerClipFingerprint[];
}): ScoreboardArtifact {
  const fillerGate = input.fillerResume ? evaluateFillerResumeGate(input.fillerResume) : null;
  const samples: ReplyGapSample[] = [];
  const finiteGaps = (beat: GoldenBeat): number[] => (input.gaps?.[beat] ?? []).filter((n) => Number.isFinite(n));
  const explicitGreetingCut = finiteGaps("greeting-cut").length > 0;
  const allTraceGaps = input.traceGaps ?? [];
  // Suite routing attributes a scenario's own trace to its beat explicitly;
  // those gaps never take part in the opening-turn guess below.
  const preAttributed = allTraceGaps.filter((gap): gap is TraceGap & { beat: GoldenBeat } => gap.beat !== undefined);
  const unattributed = allTraceGaps.filter((gap) => gap.beat === undefined);
  // Review (finding D): the first merged trace turn is attributed to a beat
  // only when verified — an explicit --trace-beat map, or an excerpt that
  // opens with a greeting-cut marker. Unverified turns stay call-level.
  const attribution = attributeFirstTraceGap(input.traceExcerpt ?? [], { beatMap: input.traceBeat ?? undefined });
  const attributedBeat = explicitGreetingCut || preAttributed.length > 0 ? null : attribution.beat;
  const traceFirstTurnIndex = explicitGreetingCut ? null : (unattributed[0]?.turnIndex ?? null);
  const traceFirstToBeat =
    attributedBeat !== null && unattributed.length > 0
      ? [{
          beat: attributedBeat,
          gapMs: unattributed[0].gapMs,
          turnIndex: traceFirstTurnIndex,
          sessionId: unattributed[0].sessionId ?? input.traceSessionId ?? undefined,
        }]
      : [];
  const traceAttributed = traceFirstToBeat.length > 0;
  const traceGapsForBeat = (beat: GoldenBeat) => [
    ...preAttributed
      .filter((gap) => gap.beat === beat)
      .map((gap) => ({
        gapMs: gap.gapMs,
        turnIndex: gap.turnIndex,
        sessionId: gap.sessionId ?? input.traceSessionId ?? undefined,
      })),
    ...(beat === (traceFirstToBeat[0]?.beat ?? null) && traceFirstToBeat[0]
      ? [{
          gapMs: traceFirstToBeat[0].gapMs,
          turnIndex: traceFirstToBeat[0].turnIndex,
          sessionId: traceFirstToBeat[0].sessionId,
        }]
      : []),
  ];
  for (const beat of GOLDEN_BEATS) {
    for (const traceSample of traceGapsForBeat(beat)) {
      samples.push({
        beat,
        gapMs: traceSample.gapMs,
        turnIndex: traceSample.turnIndex,
        sessionId: traceSample.sessionId,
      });
    }
    for (const gapMs of finiteGaps(beat)) {
      samples.push({ beat, gapMs, turnIndex: null, sessionId: input.traceSessionId ?? undefined });
    }
  }
  for (const traceGap of unattributed.slice(traceAttributed ? 1 : 0)) {
    samples.push({
      beat: null,
      gapMs: traceGap.gapMs,
      turnIndex: traceGap.turnIndex,
      sessionId: traceGap.sessionId ?? input.traceSessionId ?? undefined,
    });
  }
  const traceUnverified =
    allTraceGaps.length > 0 && !traceAttributed && !explicitGreetingCut && preAttributed.length === 0;
  const overall = summarizeReplyGaps(samples);
  const beats = Object.fromEntries(
    GOLDEN_BEATS.map((beat) => {
      const beatSamples = finiteGaps(beat).concat(traceGapsForBeat(beat).map((gap) => gap.gapMs));
      const measured = beatSamples.length > 0;
      const beatSummary = summarizeReplyGaps(
        beatSamples.map((gapMs) => ({ beat, gapMs, turnIndex: null as number | null })),
      );
      const breaches =
        (beatSummary?.p50Ms ?? 0) > REPLY_GAP_P50_BUDGET_MS ||
        (beatSummary?.p95Ms ?? 0) > REPLY_GAP_P95_BUDGET_MS;
      // Unverified trace attribution never claims the greeting-cut beat:
      // INFO with the warning, not PASS.
      const unverifiedNote =
        traceUnverified && beat === "greeting-cut" && !measured ? attribution.note : null;
      return [
        beat,
        {
          gapMs: beatSummary?.p50Ms ?? null,
          gapSamples: beatSamples,
          cutMs: null,
          resumeMs: null,
          drainMs: null,
          status: measured ? "PASS" : "INFO",
          note: unverifiedNote ??
            (measured
              ? `reply gap p50 ${beatSummary?.p50Ms}ms / p95 ${beatSummary?.p95Ms}ms over ${beatSamples.length} run${beatSamples.length === 1 ? "" : "s"}${breaches ? " (over budget: see reply-gap gate)" : ""}`
              : "skeleton: placeholder until per-beat timing lands"),
        } satisfies BeatTiming,
      ];
    }),
  ) as Record<GoldenBeat, BeatTiming>;
  if (fillerGate && input.fillerResume) {
    const prior = beats["filler-ignored"];
    beats["filler-ignored"] = {
      gapMs: prior.gapMs,
      gapSamples: prior.gapSamples,
      cutMs: input.fillerResume.cutMs,
      resumeMs: input.fillerResume.resumeMs,
      drainMs: null,
      status: fillerGate.status === "FAIL" ? "FAIL" : "PASS",
      note: fillerGate.detail,
    };
  }
  const evaluation =
    input.overheardAsides === undefined
      ? null
      : evaluateOverheardRecall(input.overheardAsides);
  const doubleTalkOverlapMs = input.doubleTalkOverlapMs ?? [];
  const drain = input.endCallDrain ?? {
    goodbyeCoverage: null,
    hangUpDelayMs: null,
    narratedEnding: false,
    inboxNamed: null,
  };
  const traceRef = input.traceRef ?? input.traceSessionId ?? undefined;
  // Turn pointers come from the merged excerpt only: the interrupted reply for
  // a double-talk cut, the reply after end_call for the goodbye drain, and the
  // cut row for a check-in that talked over the caller. Missing rows fall back
  // to the session-level pointer, never a guessed turn.
  const turnPointers = traceTurnPointers(input.traceExcerpt ?? []);
  const traceSession = input.traceSessionId ?? null;
  const cutTraceRef =
    turnPointers.cutTurn !== null ? formatTraceTurn(turnPointers.cutTurn, traceSession) : traceRef;
  const goodbyeTraceRef =
    turnPointers.goodbyeTurn !== null
      ? formatTraceTurn(turnPointers.goodbyeTurn, traceSession)
      : traceSession
        ? `no turn merged (${traceSession})`
        : traceRef;
  const deadAirInput = input.deadAir
    ? {
        ...input.deadAir,
        checkIns: input.deadAir.checkIns.map((checkIn) => {
          if (checkIn.overCaller !== true || checkIn.trace || checkIn.atMs === undefined) return checkIn;
          // The actual turn: the VONI reply the check-in request became. A
          // later reply is the only honest derivation; without one the FAIL
          // states that no turn was merged.
          const trace = traceCheckInRef(input.traceExcerpt ?? [], checkIn.atMs, traceSession);
          return trace ? { ...checkIn, trace } : checkIn;
        }),
      }
    : input.deadAir;
  const deadAirGaps = deadAirInput?.gapsMs ?? [];
  const deadAirCheckIns = deadAirInput?.checkIns ?? [];
  const doubleTalkInput: DoubleTalkInput = {
    overlapMs: doubleTalkOverlapMs,
    ...(input.doubleTalkTraceRef
      ? { traceRef: input.doubleTalkTraceRef }
      : cutTraceRef
        ? { traceRef: cutTraceRef }
        : {}),
  };
  // A narrated ending is proven by evidence (the runner) or by the merged
  // trace itself: a VONI reply after the goodbye is exactly that narration.
  const narratedEnding = drain.narratedEnding || turnPointers.narrationTurn !== null;
  // Its FAIL cites the post-End turn. When the merged trace carries no such
  // row, say so explicitly rather than pointing at the goodbye.
  const narrationTraceRef =
    turnPointers.narrationTurn !== null
      ? formatTraceTurn(turnPointers.narrationTurn, traceSession)
      : `no turn merged${traceSession ? ` (${traceSession})` : ""}`;
  const endCallDrainInput: EndCallDrainInput = {
    ...drain,
    narratedEnding,
    // A narration FAIL from the suite's own run cites that run's session (the
    // bye-audio call), never the primary excerpt's turn from another call.
    ...(input.endCallDrainTraceRef
      ? { traceRef: input.endCallDrainTraceRef }
      : narratedEnding
        ? { traceRef: narrationTraceRef }
        : goodbyeTraceRef
          ? { traceRef: goodbyeTraceRef }
          : {}),
  };
  const timbreProbes: TimbreProbes = input.probes ?? { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 };
  const agentChannel = input.agentChannel ?? null;
  const humanRatings = input.humanRatings ?? emptyHumanRatings(null);
  const loudnessCheck = checkLoudnessSanity(input.voice);
  const dryRun = input.dryRun ?? false;
  const measuredSources = measuredEvidenceSources({
    gaps: input.gaps,
    traceGaps: input.traceGaps,
    fillerResume: input.fillerResume,
    overheardAsides: input.overheardAsides,
    deadAir: deadAirInput,
    doubleTalkOverlapMs,
    endCallDrain: { ...drain, narratedEnding },
    ...(input.probes !== undefined ? { probes: input.probes } : {}),
    ...(agentChannel !== null ? { agentChannel } : {}),
    ...(humanRatings.ratings.length > 0 ? { humanRatings } : {}),
    ...(input.greetingCutEvidencePresent ? { greetingCutEvidencePresent: true } : {}),
    ...(input.realCutEvidencePresent ? { realCutEvidencePresent: true } : {}),
    ...(input.emailInviteEvidencePresent ? { emailInviteEvidencePresent: true } : {}),
  });
  const measured = measuredSources.length > 0;
  // Ticket 06: the runner's own output decides plumbing health. A dry run
  // skips the runner entirely (null), never classifies a placeholder as a break.
  const runnerOutcome = dryRun
    ? null
    : classifyRunnerOutcome({
        stdout: input.runnerStdout,
        exitCode: input.exitCode,
        error: input.evalError ?? null,
      });
  const gatesPreview = skeletonGates(
    runnerOutcome,
    samples,
    input.traceSessionId ?? null,
    input.agentInput,
    input.traceExcerpt ?? [],
    fillerGate,
    evaluation?.gate ?? null,
    deadAirInput,
    doubleTalkInput,
    endCallDrainInput,
    timbreProbes,
    agentChannel,
    humanRatings,
    input.voice,
    { measured, measuredSources },
  );
  // Finding D: when trace gaps exist but attribution is unverified, the
  // reply-gap gate says so instead of silently implying beat attribution.
  if (traceUnverified) {
    const replyGate = gatesPreview.find((g) => g.name === "reply-gap")!;
    replyGate.detail += ` (${attribution.note})`;
  }
  const goodbyeDrainGate = gatesPreview.find((g) => g.name === "end-call-drain")!;
  // Attach drain evidence to the goodbye-drain beat (ticket 09), preserving
  // reply-gap measurements for other beats.
  {
    const prior = beats["goodbye-drain"];
    const measured = drain.hangUpDelayMs !== null || drain.goodbyeCoverage !== null;
    beats["goodbye-drain"] = {
      gapMs: prior.gapMs,
      gapSamples: prior.gapSamples,
      cutMs: prior.cutMs,
      resumeMs: prior.resumeMs,
      drainMs: drain.hangUpDelayMs,
      status: measured ? goodbyeDrainGate.status : prior.status,
      note: measured ? goodbyeDrainGate.detail : prior.note,
    };
  }
  return {
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    voice: input.voice,
    runs: input.runs,
    goldenScript: {
      vertical: GOLDEN_VERTICAL,
      budgetS: GOLDEN_SCRIPT_BUDGET_S,
      beats: GOLDEN_SCRIPT,
    },
    regressionVoices: regressionVoices(input.voice),
    beats,
    replyGap: { p50Ms: overall?.p50Ms ?? null, p95Ms: overall?.p95Ms ?? null, samples: overall?.count ?? 0 },
    overheard: evaluation
      ? { recalled: evaluation.recalled, total: evaluation.total, byBeat: evaluation.byBeat, asides: input.overheardAsides! }
      : { recalled: 0, total: 0, byBeat: emptyOverheardByBeat(), asides: [] },
    doubleTalk: {
      overlapMs: doubleTalkOverlapMs,
      maxMs: doubleTalkOverlapMs.length > 0 ? Math.max(...doubleTalkOverlapMs) : null,
    },
    endCallDrain: { ...drain, narratedEnding, inboxNamed: drain.inboxNamed ?? null },
    deadAir: {
      gapsMs: deadAirGaps,
      maxMs: deadAirGaps.length > 0 ? Math.max(...deadAirGaps) : null,
      checkIns: deadAirCheckIns,
      longestSilenceMs: input.deadAir?.longestSilenceMs ?? null,
      gapWindows: deadAirInput?.gapWindows ?? [],
      silences: deadAirInput?.silences ?? [],
    },
    probes: timbreProbes,
    loudness: {
      referenceLufs: TIMBRE_REFERENCE_LUFS,
      matchedLufs: loudnessCheck.matchedLufs,
      gain: gateVoicePlayback(input.voice).playbackGain,
      outputVolume: gateVoicePlayback(input.voice).outputVolume,
      ok: loudnessCheck.ok,
      detail: loudnessCheck.detail,
      voices: voiceGainTable(input.voice),
    },
    transcripts: {
      sha256: sha256Hex(input.runnerStdout),
      redacted: redactLines(input.runnerStdout),
    },
    humanRatings,
    humanReview: humanReview(
      humanRatings,
      gatesPreview.find((gate) => gate.name === "timbre-probes")?.status === "PASS",
    ),
    gates: gatesPreview,
    subScores: buildSubScores(gatesPreview),
    emailInvite: null,
    evalRunner: {
      scenario: input.scenario,
      passed: dryRun
        ? null
        : runnerOutcome!.status === "finished"
          ? runnerOutcome!.summary
            ? runnerOutcome!.summary.failures === 0
            : runnerOutcome!.scenarios.every((row) => row.passed === row.runs)
          : false,
      status: dryRun ? "skipped" : runnerOutcome!.status === "finished" ? "ok" : "failed",
      breakReason: runnerOutcome?.reason ?? null,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      timings: { scenarioRuns: runnerOutcome?.summary?.playout ?? [] },
      rawSha256: sha256Hex(input.runnerStdout),
    },
    callerClips: input.callerClips ?? [],
    runId: input.runId ?? `run-${input.voice}-${Date.now().toString(36)}`,
    codeFingerprint: input.codeFingerprint ?? null,
    quarantinedBeats: [],
  };
}

/** Console pass/fail table: one row per gate. */
export function formatGateTable(artifact: ScoreboardArtifact): string {
  const rows = artifact.gates.map(
    (gate) => `${gate.status.padEnd(6)} ${gate.name.padEnd(16)} ${gate.detail}`,
  );
  return [
    `demo scoreboard (${artifact.voice}, ${artifact.runs} run${artifact.runs === 1 ? "" : "s"})`,
    ...rows,
  ].join("\n");
}

// ── Artifact diff: what changed since the prior run (ticket 07) ──────────────

/** One metric's prior/next value and signed change; null when either side is unmeasured. */
export type ScoreboardMetricDelta = {
  prior: number | null;
  next: number | null;
  /** next - prior; null when either side is unmeasured. */
  deltaMs: number | null;
  changed: boolean;
};

/** A gate's status transition (a gate missing on one side shows null). */
export type ScoreboardGateTransition = {
  name: string;
  prior: GateStatus | null;
  next: GateStatus | null;
  changed: boolean;
};

/** One beat's metric and status changes between two artifacts. */
export type ScoreboardBeatDelta = {
  beat: GoldenBeat;
  status: { prior: GateStatus; next: GateStatus; changed: boolean };
  gapMs: ScoreboardMetricDelta;
  cutMs: ScoreboardMetricDelta;
  resumeMs: ScoreboardMetricDelta;
  drainMs: ScoreboardMetricDelta;
  changed: boolean;
};

/** Pure diff between two scoreboard artifacts: gates, beats, reply gap, drain. */
export type ScoreboardArtifactDiff = {
  priorRunId: string;
  nextRunId: string;
  priorRecordedAt: string;
  nextRecordedAt: string;
  priorVoice: string;
  nextVoice: string;
  gates: ScoreboardGateTransition[];
  /** Only the gates whose status changed, in next-run order. */
  changedGates: ScoreboardGateTransition[];
  beats: ScoreboardBeatDelta[];
  /** Only the beats with a metric or status change, in golden order. */
  changedBeats: ScoreboardBeatDelta[];
  replyGap: {
    prior: ScoreboardArtifact["replyGap"];
    next: ScoreboardArtifact["replyGap"];
    p50DeltaMs: number | null;
    p95DeltaMs: number | null;
    samplesDelta: number;
  };
  endCallDrain: {
    prior: ScoreboardArtifact["endCallDrain"];
    next: ScoreboardArtifact["endCallDrain"];
    goodbyeCoverageDelta: number | null;
    hangUpDelayDeltaMs: number | null;
    narratedEndingChanged: boolean;
  };
  /**
   * Fixed caller clips (ticket 10): a changed clip means the cut delta is not
   * comparable, so the diff says so instead of reporting a shorter take as a
   * faster interruption.
   */
  callerClips: {
    prior: CallerClipFingerprint[];
    next: CallerClipFingerprint[];
    changed: boolean;
    /** Human-readable drift of the first compared clip that changed. */
    drift: string | null;
  };
  /**
   * Plumbing health (ticket 06) across the two runs. Older artifacts predate
   * `breakReason`/`timings`, so both sides are read as possibly absent: a
   * missing field diffs as null/empty instead of throwing.
   */
  evalRunner: {
    status: { prior: ScoreboardArtifact["evalRunner"]["status"]; next: ScoreboardArtifact["evalRunner"]["status"]; changed: boolean };
    breakReason: { prior: RunnerBreakReason | null; next: RunnerBreakReason | null; changed: boolean };
    playout: {
      prior: RunnerPlayout[];
      next: RunnerPlayout[];
      /** Total wall clock change across all scenario runs; null when either side is unmeasured. */
      wallClockDeltaMs: number | null;
      changed: boolean;
    };
    changed: boolean;
  };
  changed: boolean;
};

/** An artifact read from disk may predate the ticket-06 runner fields. */
type PossiblyOlderEvalRunner = Partial<ScoreboardArtifact["evalRunner"]> & {
  timings?: Partial<ScoreboardArtifact["evalRunner"]["timings"]>;
};

function runnerPlayout(artifact: ScoreboardArtifact): RunnerPlayout[] {
  const runner = (artifact.evalRunner ?? {}) as PossiblyOlderEvalRunner;
  const rows = runner.timings?.scenarioRuns;
  return Array.isArray(rows) ? rows : [];
}

function samePlayout(prior: RunnerPlayout[], next: RunnerPlayout[]): boolean {
  return (
    prior.length === next.length &&
    prior.every((row, index) => {
      const other = next[index];
      return (
        other !== undefined &&
        row.scenario === other.scenario &&
        row.run === other.run &&
        row.wallClockMs === other.wallClockMs
      );
    })
  );
}

function metricDelta(prior: number | null, next: number | null): ScoreboardMetricDelta {
  return {
    prior,
    next,
    deltaMs: prior !== null && next !== null ? next - prior : null,
    changed: prior !== next,
  };
}

function numericDelta(prior: number | null, next: number | null): number | null {
  return prior !== null && next !== null ? next - prior : null;
}

/**
 * Diff two scoreboard artifacts so a run shows what moved since the prior
 * one: per-gate status transitions, per-beat metric deltas, and the reply-gap
 * and end-call-drain roll-ups. Pure: both sides are read, nothing is inferred
 * and no missing measurement becomes a zero.
 */
export function diffScoreboardArtifact(
  prev: ScoreboardArtifact,
  next: ScoreboardArtifact,
): ScoreboardArtifactDiff {
  const priorGates = new Map(prev.gates.map((gate) => [gate.name, gate.status] as const));
  const nextGates = new Map(next.gates.map((gate) => [gate.name, gate.status] as const));
  const gateNames = [...next.gates.map((gate) => gate.name)];
  for (const gate of prev.gates) {
    if (!nextGates.has(gate.name)) gateNames.push(gate.name);
  }
  const gates: ScoreboardGateTransition[] = gateNames.map((name) => {
    const prior = priorGates.get(name) ?? null;
    const current = nextGates.get(name) ?? null;
    return { name, prior, next: current, changed: prior !== current };
  });

  const beats: ScoreboardBeatDelta[] = GOLDEN_BEATS.map((beat) => {
    const prior = prev.beats[beat];
    const current = next.beats[beat];
    const status = {
      prior: prior.status,
      next: current.status,
      changed: prior.status !== current.status,
    };
    const gapMs = metricDelta(prior.gapMs, current.gapMs);
    const cutMs = metricDelta(prior.cutMs, current.cutMs);
    const resumeMs = metricDelta(prior.resumeMs, current.resumeMs);
    const drainMs = metricDelta(prior.drainMs, current.drainMs);
    return {
      beat,
      status,
      gapMs,
      cutMs,
      resumeMs,
      drainMs,
      changed:
        status.changed || gapMs.changed || cutMs.changed || resumeMs.changed || drainMs.changed,
    };
  });

  const replyGap = {
    prior: prev.replyGap,
    next: next.replyGap,
    p50DeltaMs: numericDelta(prev.replyGap.p50Ms, next.replyGap.p50Ms),
    p95DeltaMs: numericDelta(prev.replyGap.p95Ms, next.replyGap.p95Ms),
    samplesDelta: next.replyGap.samples - prev.replyGap.samples,
  };
  const endCallDrain = {
    prior: prev.endCallDrain,
    next: next.endCallDrain,
    goodbyeCoverageDelta: numericDelta(prev.endCallDrain.goodbyeCoverage, next.endCallDrain.goodbyeCoverage),
    hangUpDelayDeltaMs: numericDelta(prev.endCallDrain.hangUpDelayMs, next.endCallDrain.hangUpDelayMs),
    narratedEndingChanged: prev.endCallDrain.narratedEnding !== next.endCallDrain.narratedEnding,
  };
  const priorClips = prev.callerClips ?? [];
  const nextClips = next.callerClips ?? [];
  const clipDrift = callerClipChanges(priorClips, nextClips);
  const callerClips = {
    prior: priorClips,
    next: nextClips,
    changed: clipDrift !== null,
    drift: clipDrift,
  };
  const changedGates = gates.filter((gate) => gate.changed);
  const changedBeats = beats.filter((beat) => beat.changed);
  const replyGapChanged =
    prev.replyGap.p50Ms !== next.replyGap.p50Ms ||
    prev.replyGap.p95Ms !== next.replyGap.p95Ms ||
    prev.replyGap.samples !== next.replyGap.samples;
  const drainChanged =
    prev.endCallDrain.goodbyeCoverage !== next.endCallDrain.goodbyeCoverage ||
    prev.endCallDrain.hangUpDelayMs !== next.endCallDrain.hangUpDelayMs ||
    (prev.endCallDrain.inboxNamed ?? null) !== (next.endCallDrain.inboxNamed ?? null) ||
    endCallDrain.narratedEndingChanged;
  const priorRunner = (prev.evalRunner ?? {}) as PossiblyOlderEvalRunner;
  const nextRunner = (next.evalRunner ?? {}) as PossiblyOlderEvalRunner;
  const priorPlayout = runnerPlayout(prev);
  const nextPlayout = runnerPlayout(next);
  const priorWallClock = priorPlayout.reduce((sum, row) => sum + row.wallClockMs, 0);
  const nextWallClock = nextPlayout.reduce((sum, row) => sum + row.wallClockMs, 0);
  const runnerStatusChanged = priorRunner.status !== nextRunner.status;
  const breakReasonChanged = (priorRunner.breakReason ?? null) !== (nextRunner.breakReason ?? null);
  const playoutChanged = !samePlayout(priorPlayout, nextPlayout);
  const evalRunner = {
    status: { prior: priorRunner.status ?? "skipped", next: nextRunner.status ?? "skipped", changed: runnerStatusChanged },
    breakReason: {
      prior: priorRunner.breakReason ?? null,
      next: nextRunner.breakReason ?? null,
      changed: breakReasonChanged,
    },
    playout: {
      prior: priorPlayout,
      next: nextPlayout,
      wallClockDeltaMs:
        priorPlayout.length > 0 && nextPlayout.length > 0 ? nextWallClock - priorWallClock : null,
      changed: playoutChanged,
    },
    changed: runnerStatusChanged || breakReasonChanged || playoutChanged,
  };
  return {
    priorRunId: prev.runId,
    nextRunId: next.runId,
    priorRecordedAt: prev.recordedAt,
    nextRecordedAt: next.recordedAt,
    priorVoice: prev.voice,
    nextVoice: next.voice,
    gates,
    changedGates,
    beats,
    changedBeats,
    replyGap,
    endCallDrain,
    callerClips,
    evalRunner,
    changed:
      changedGates.length > 0 ||
      changedBeats.length > 0 ||
      replyGapChanged ||
      drainChanged ||
      callerClips.changed ||
      evalRunner.changed,
  };
}

function formatMsTransition(prior: number | null, next: number | null): string {
  if (prior === null && next === null) return "unmeasured";
  if (prior === null) return `unmeasured → ${next}ms`;
  if (next === null) return `${prior}ms → unmeasured`;
  const delta = next - prior;
  const sign = delta > 0 ? "+" : "";
  return `${prior}ms → ${next}ms (${sign}${delta}ms)`;
}

function formatPercent(value: number | null): string {
  return value === null ? "unmeasured" : `${Math.round(value * 100)}%`;
}

function formatCoverageTransition(prior: number | null, next: number | null): string {
  if (prior === null && next === null) return "unmeasured";
  const delta = numericDelta(prior, next);
  const change = delta === null ? "" : ` (${delta > 0 ? "+" : ""}${Math.round(delta * 100)}pp)`;
  return `${formatPercent(prior)} → ${formatPercent(next)}${change}`;
}

/** Console report: only what changed, plus the reply-gap and drain roll-ups. */
export function formatArtifactDiff(diff: ScoreboardArtifactDiff): string {
  const voice =
    diff.priorVoice === diff.nextVoice ? "" : ` (voice ${diff.priorVoice} → ${diff.nextVoice})`;
  const sameRun = diff.priorRunId === diff.nextRunId;
  const priorLabel = sameRun ? `${diff.priorRunId} @ ${diff.priorRecordedAt}` : diff.priorRunId;
  const nextLabel = sameRun ? `${diff.nextRunId} @ ${diff.nextRecordedAt}` : diff.nextRunId;
  const lines = [`artifact diff (${priorLabel} → ${nextLabel})${voice}`];
  if (!diff.changed) {
    lines.push("  no changes since the prior artifact");
    return lines.join("\n");
  }
  if (diff.changedGates.length > 0) {
    lines.push(`  gates: ${diff.changedGates.length} changed, ${diff.gates.length - diff.changedGates.length} unchanged`);
    for (const gate of diff.changedGates) {
      lines.push(`    ${gate.name.padEnd(16)} ${gate.prior ?? "absent"} → ${gate.next ?? "absent"}`);
    }
  }
  if (diff.changedBeats.length > 0) {
    lines.push(`  beats: ${diff.changedBeats.length} changed, ${diff.beats.length - diff.changedBeats.length} unchanged`);
    for (const beat of diff.changedBeats) {
      const parts: string[] = [];
      if (beat.status.changed) parts.push(`status ${beat.status.prior} → ${beat.status.next}`);
      if (beat.gapMs.changed) parts.push(`gap ${formatMsTransition(beat.gapMs.prior, beat.gapMs.next)}`);
      if (beat.cutMs.changed) parts.push(`cut ${formatMsTransition(beat.cutMs.prior, beat.cutMs.next)}`);
      if (beat.resumeMs.changed) parts.push(`resume ${formatMsTransition(beat.resumeMs.prior, beat.resumeMs.next)}`);
      if (beat.drainMs.changed) parts.push(`drain ${formatMsTransition(beat.drainMs.prior, beat.drainMs.next)}`);
      lines.push(`    ${beat.beat.padEnd(20)} ${parts.join(", ")}`);
    }
  }
  if (diff.callerClips.changed) {
    lines.push(
      `  caller clip  ${diff.callerClips.drift} — cut latency is not comparable with the prior run`,
    );
  }
  if (diff.evalRunner.changed) {
    // Plumbing health is reported beside the gates but stays a harness verdict,
    // and playout is wall clock that never becomes a gate.
    const runner = diff.evalRunner;
    const parts: string[] = [`status ${runner.status.prior} → ${runner.status.next}`];
    if (runner.breakReason.changed) {
      parts.push(`break ${runner.breakReason.prior ?? "none"} → ${runner.breakReason.next ?? "none"}`);
    }
    if (runner.playout.changed) {
      const wallClock =
        runner.playout.wallClockDeltaMs === null
          ? `${runner.playout.prior.length} → ${runner.playout.next.length} runs`
          : `wall clock ${runner.playout.wallClockDeltaMs > 0 ? "+" : ""}${runner.playout.wallClockDeltaMs}ms`;
      parts.push(`playout ${runner.playout.prior.length} → ${runner.playout.next.length} runs (${wallClock})`);
    }
    lines.push(`  eval runner  ${parts.join(", ")}`);
  }
  lines.push(
    `  reply gap  p50 ${formatMsTransition(diff.replyGap.prior.p50Ms, diff.replyGap.next.p50Ms)}, ` +
      `p95 ${formatMsTransition(diff.replyGap.prior.p95Ms, diff.replyGap.next.p95Ms)}, ` +
      `n ${diff.replyGap.prior.samples} → ${diff.replyGap.next.samples}`,
  );
  lines.push(
    `  goodbye  coverage ${formatCoverageTransition(diff.endCallDrain.prior.goodbyeCoverage, diff.endCallDrain.next.goodbyeCoverage)}, ` +
      `hang-up ${formatMsTransition(diff.endCallDrain.prior.hangUpDelayMs, diff.endCallDrain.next.hangUpDelayMs)}, ` +
      `narration ${diff.endCallDrain.prior.narratedEnding ? "yes" : "no"} → ${diff.endCallDrain.next.narratedEnding ? "yes" : "no"}`,
  );
  return lines.join("\n");
}

/** Console per-beat overheard recall counts with trace pointers. */
export function formatOverheardReport(artifact: ScoreboardArtifact): string {
  const lines = [
    `overheard recall ${artifact.overheard.recalled}/${artifact.overheard.total}`,
  ];
  for (const beat of GOLDEN_BEATS) {
    const slot = artifact.overheard.byBeat[beat];
    if (!slot || slot.total === 0) {
      lines.push(`  ${beat}: ${slot?.recalled ?? 0}/${slot?.total ?? 0}`);
      continue;
    }
    lines.push(`  ${beat}: ${slot.recalled}/${slot.total}`);
    for (const aside of artifact.overheard.asides.filter((a) => a.beat === beat)) {
      const kind = classifyOverheard(aside.text, aside.agentText ?? "");
      lines.push(
        `    - "${aside.text}" (${kind} ${aside.handling}) [${aside.tracePointer}]`,
      );
    }
  }
  return lines.join("\n");
}

// ── Review: five sub-scores + fail-fast priority (spec: five + fails fast) ───
// Lightweight roll-up over the existing gates (no new thresholds): each
// sub-score is the worst of its member gates, and gate evaluation/reporting
// follows the spec priority (gap → cut → overheard → naturalness).

export type SubScoreName = "responsiveness" | "barge-in" | "overheard" | "naturalness" | "voice";

export type SubScore = {
  name: SubScoreName;
  label: string;
  status: GateStatus;
  detail: string;
  gates: string[];
};

export const SUB_SCORE_DEFS: { name: SubScoreName; label: string; gates: string[] }[] = [
  { name: "responsiveness", label: "Responsiveness p50/p95", gates: ["reply-gap", "end-of-turn"] },
  { name: "barge-in", label: "Barge-in cut", gates: ["barge-in-cut", "filler-resume"] },
  { name: "overheard", label: "Overheard recall", gates: ["overheard-recall"] },
  { name: "naturalness", label: "Naturalness double-talk/dead-air", gates: ["double-talk", "dead-air", "end-call-drain"] },
  { name: "voice", label: "Voice timbre/accent", gates: ["timbre-probes", "accent-human"] },
];

/** Aggregate the five sub-scores from existing gates: worst member status wins, no new thresholds. */
export function buildSubScores(gates: ScoreboardGate[]): SubScore[] {
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  return SUB_SCORE_DEFS.map((def) => {
    const members = def.gates.map((name) => byName.get(name)).filter((m) => m !== undefined);
    const missing = def.gates.filter((name) => !byName.has(name));
    const statuses = members.map((member) => member.status);
    const status: GateStatus =
      statuses.includes("FAIL")
        ? "FAIL"
        : statuses.includes("INFO") || missing.length > 0
          ? "INFO"
          : "PASS";
    const detail = members
      .map((member) => `${member.name}: ${member.detail}`)
      .concat(missing.map((name) => `${name}: not scored`))
      .join("; ");
    return { name: def.name, label: def.label, status, detail, gates: def.gates };
  });
}

/** Console sub-score table: one row per human-likeness area, in spec priority. */
export function formatSubScoreTable(artifact: ScoreboardArtifact): string {
  const rows = artifact.subScores.map(
    (sub) => `${sub.status.padEnd(6)} ${sub.name.padEnd(16)} ${sub.detail}`,
  );
  return [`demo sub-scores (5, priority order)`, ...rows].join("\n");
}

// ── Ticket 10: voice regression matrix ──────────────────────────────────────
//
// Non-gate voices run regression-only (spec story 14): no clip, no pop, no
// invented test tag. Deploying a new voice is a registry entry plus a full
// matrix run — never a harness change, never a golden-script edit.

/** Tag discipline for one voice: the call tag said once exactly, whole, and only. */
export type TagDiscipline = {
  saidOnceExactly: boolean;
  digitSpelled: boolean;
  /** Distinct invented tags heard (folded "word digits"), at most five. */
  invented: string[];
};

const foldTagText = (text: string): string =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** The tag-word list the expected tag comes from (its call's language). */
function tagWordList(expectedTag: string): string[] {
  const word = foldTagText(expectedTag).split(" ")[0];
  return (
    Object.values(TAG_WORDS).find((list) => list.some((w) => w.toLowerCase() === word)) ?? TAG_WORDS.en
  ).map((w) => w.toLowerCase());
}

const MATRIX_DIGIT_WORDS = "zero|one|two|three|four|five|six|seven|eight|nine|forty";

/**
 * Tag discipline over redacted transcript lines, reusing the shared email-test
 * vocabulary (test-tag.ts containsTag/countTags/TAG_WORDS): fuzzy matching
 * ("lime42", "Lime-42") forgives typing, so only genuinely distinct tags count
 * as invented, while a digit-by-digit saying ("Lime four two", "Lime 4 2")
 * fails even though the inbox would still match it.
 */
export function analyzeTagMentions(lines: string[], expectedTag = "Lime 42"): TagDiscipline {
  const joined = lines.join("\n");
  const folded = foldTagText(joined);
  const [word, digits] = foldTagText(expectedTag).split(" ");
  // The email matcher's lone-digit joiner, restated for invented-tag mining.
  const typed = folded.replace(/(^|[^0-9])(\d)[\s-]+(\d)(?![0-9])/g, "$1$2$3");
  const occurrences = [
    ...typed.matchAll(new RegExp(`(?:^|[^a-z0-9])${word}[\\s\\-_.:#]*${digits}(?!\\d)`, "g")),
  ].length;
  const distinctCount = countTags(joined, expectedTag);
  const digitSpelled = new RegExp(
    `(^|[^a-z0-9])${word}\\s+(\\d[\\s-]+\\d|(?:${MATRIX_DIGIT_WORDS})[\\s-]+(?:${MATRIX_DIGIT_WORDS}|two))(?!\\d)`,
  ).test(folded);
  const list = tagWordList(expectedTag);
  const seen = new Set(
    [...typed.matchAll(new RegExp(`(?:^|[^a-z0-9])(${list.join("|")})[\\s\\-_.:#]*(\\d{2})(?!\\d)`, "g"))].map(
      (m) => `${m[1]} ${m[2]}`,
    ),
  );
  seen.delete(`${word} ${digits}`);
  return {
    saidOnceExactly: containsTag(joined, expectedTag) && occurrences === 1 && distinctCount === 1,
    digitSpelled,
    invented: [...seen].slice(0, 5),
  };
}

export type RegressionVoiceResult = {
  voice: string;
  isGate: boolean;
  status: "PASS" | "FAIL";
  detail: string;
  probes: TimbreProbes;
  tag: TagDiscipline;
};

/**
 * One voice's regression verdict: probes zero, no invented tag, the call tag
 * said once as one whole number. Same bar for gate and non-gate voices —
 * regression-only means the matrix never gates the pipeline, not that it
 * looks away.
 */
export function checkRegressionVoice(input: {
  voice: string;
  isGate: boolean;
  probes: TimbreProbes;
  tag: TagDiscipline;
}): RegressionVoiceResult {
  const scope = input.isGate ? "gate" : "regression";
  const fail = (detail: string): RegressionVoiceResult => ({
    voice: input.voice,
    isGate: input.isGate,
    status: "FAIL",
    detail: `${scope} ${input.voice}: ${detail}`,
    probes: input.probes,
    tag: input.tag,
  });
  for (const kind of ["jump", "overload", "clip", "underrun", "inputDrop"] as const) {
    if (input.probes[kind] > 0) {
      return fail(`${kind} ${input.probes[kind]} > 0 (must be zero: no clip, pop, jump, underrun, or input-drop)`);
    }
  }
  if (input.tag.invented.length > 0) {
    return fail(`invented test tag ${input.tag.invented.join(", ")} (say only the call tag)`);
  }
  if (input.tag.digitSpelled) {
    return fail("test tag spelled digit by digit (say the number as one whole number)");
  }
  if (!input.tag.saidOnceExactly) {
    return fail("test tag not said exactly once (say the call tag once, never invented)");
  }
  return {
    voice: input.voice,
    isGate: input.isGate,
    status: "PASS",
    detail: `${scope} ${input.voice}: probes zero; test tag said once exactly`,
    probes: input.probes,
    tag: input.tag,
  };
}

/**
 * Matrix voice set: a registry parameter, never literals. Empty means every
 * demo voice; anything else is validated through the voice registry, so a
 * newly registered voice joins the matrix by naming it.
 */
export function resolveMatrixVoices(csv: string): string[] {
  if (!csv.trim()) return [...DEMO_VOICE_IDS];
  const voices: string[] = [];
  for (const raw of csv.split(",")) {
    const voice = raw.trim();
    if (!voice) continue;
    resolveGateVoice(voice);
    if (!voices.includes(voice)) voices.push(voice);
  }
  return voices.length > 0 ? voices : [...DEMO_VOICE_IDS];
}

export type RegressionVoiceInput = {
  voice: string;
  probes: TimbreProbes;
  tagLines: string[];
  expectedTag?: string;
  /** Gate artifact rows carried verbatim (read only from the gate voice's artifact). */
  gates?: ScoreboardGate[];
  /** Gate artifact sub-scores carried verbatim (never recomputed by the matrix). */
  subScores?: SubScore[];
};

/**
 * The gate verdict a matrix run reports, carried from the gate voice's own
 * score artifact. The matrix reads these rows and never re-evaluates them, so
 * a regression voice cannot turn required green into red (or red into green).
 */
export type MatrixGateVerdict = {
  voice: string;
  status: GateStatus;
  detail: string;
  /** Names of carried gates that FAIL; empty means no required gate failed. */
  failing: string[];
  gates: ScoreboardGate[];
  subScores: SubScore[];
};

/** Carry the gate artifact's verdict: FAIL if any carried gate failed, else PASS. */
export function gateVerdictFromArtifact(
  voice: string,
  gates: ScoreboardGate[] | undefined,
  subScores: SubScore[] | undefined,
): MatrixGateVerdict {
  if (!gates) {
    return {
      voice,
      status: "INFO",
      detail: `gate ${voice}: INFO (not judged; no gates carried from its score artifact)`,
      failing: [],
      gates: [],
      subScores: subScores ?? [],
    };
  }
  const failing = gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.name);
  const informational = gates.filter((gate) => gate.status === "INFO").map((gate) => gate.name);
  return {
    voice,
    status: failing.length > 0 ? "FAIL" : "PASS",
    detail:
      failing.length > 0
        ? `gate ${voice}: FAIL (${failing.join(", ")})`
        : `gate ${voice}: PASS (no required gate failed${informational.length > 0 ? `; ${informational.length} informational` : ""})`,
    failing,
    gates,
    subScores: subScores ?? [],
  };
}

export type RegressionMatrix = {
  schemaVersion: typeof SCOREBOARD_SCHEMA_VERSION;
  recordedAt: string;
  gateVoice: string;
  expectedTag: string;
  voices: string[];
  results: RegressionVoiceResult[];
  /** The gate voice's carried verdict; regression rows never modify it. */
  gate: MatrixGateVerdict;
  /** The applied loudness path per matrix voice (ticket 25): registry only. */
  gains: VoiceGainRow[];
  gates: ScoreboardGate[];
};

/** Full matrix verdict: one regression row per voice plus the overall row. */
export function buildRegressionMatrix(input: {
  gateVoice: string;
  entries: RegressionVoiceInput[];
  expectedTag?: string;
}): RegressionMatrix {
  const gateVoice = resolveGateVoice(input.gateVoice);
  const expectedTag = input.expectedTag ?? "Lime 42";
  const results = input.entries.map((entry) => {
    resolveGateVoice(entry.voice);
    return checkRegressionVoice({
      voice: entry.voice,
      isGate: entry.voice === gateVoice,
      probes: entry.probes,
      tag: analyzeTagMentions(entry.tagLines, entry.expectedTag ?? expectedTag),
    });
  });
  const clean = results.filter((result) => result.status === "PASS").length;
  const gateEntry = input.entries.find((entry) => entry.voice === gateVoice);
  const gates: ScoreboardGate[] = results.map((result) => ({
    name: `regression:${result.voice}`,
    status: result.status,
    detail: result.detail,
  }));
  gates.push({
    name: "matrix",
    status: clean === results.length ? "PASS" : "FAIL",
    detail: `${clean}/${results.length} voices regression-clean (gate ${gateVoice}; no clip, pop, jump, underrun, input-drop, or invented tag)`,
  });
  return {
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    gateVoice,
    expectedTag,
    voices: results.map((result) => result.voice),
    results,
    gate: gateVerdictFromArtifact(gateVoice, gateEntry?.gates, gateEntry?.subScores),
    gains: results.map((result) => voiceGainRow(result.voice, gateVoice)),
    gates,
  };
}

/** Console table: gate verdict plus one row per voice, the applied gain table, and summary. */
export function formatMatrixTable(matrix: RegressionMatrix): string {
  const clean = matrix.results.filter((result) => result.status === "PASS").length;
  const subScores =
    matrix.gate.subScores.length > 0
      ? `; sub-scores ${matrix.gate.subScores.map((sub) => `${sub.name} ${sub.status}`).join(", ")}`
      : "";
  const gateRow = `${"GATE".padEnd(6)} ${matrix.gate.voice.padEnd(12)} ${matrix.gate.detail}${subScores}`;
  const rows = matrix.results.map(
    (result) => `${result.status.padEnd(6)} ${result.voice.padEnd(12)} ${result.detail}`,
  );
  return [
    `demo voice matrix (gate ${matrix.gateVoice}, ${matrix.results.length} voices, ${clean}/${matrix.results.length} clean)`,
    gateRow,
    ...rows,
    formatVoiceGainTable(matrix.gains),
  ].join("\n");
}

// ── Streak: three consecutive greens on one code + candidate behavior run ───
// (ticket 29, owner: exit claim). The streak is a pure judgement over stored
// artifacts: no live audio, no thresholds, no invented evidence. It refuses a
// green claim when the code moved, when a required gate is anything but PASS,
// or when the candidate behavior suite never ran green on the same code.

/**
 * Exact repository state a run executed on (ticket 29): the committed HEAD
 * plus a hash of the uncommitted working tree. `git status --porcelain` alone
 * misses content of modified tracked files, so both porcelain output and the
 * full `git diff HEAD` are hashed. A missing HEAD is null, never a fake clean
 * fingerprint — the streak then refuses to claim comparable runs.
 */
export type CodeFingerprint = {
  head: string;
  dirty: boolean;
  dirtyHash: string;
};

// The pure fingerprint helper (and the evidence kind) live in the shared ESM
// module so scripts/e2e-run.mjs writes exactly what this scorer validates.
export { BEHAVIOR_RUN_EVIDENCE_KIND, BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION, codeFingerprintFromGit };

/**
 * Read the fingerprint from git at run time (score-demo writes it into the
 * artifact; the streak command reads the behavior runner's copy). Both read
 * the same repository root so a change anywhere in the repo moves the hash,
 * including a change outside `voni/`. Null when git cannot answer: a missing
 * HEAD must fail the streak, never look clean.
 */
export function readCodeFingerprint(cwd = process.cwd()): CodeFingerprint | null {
  try {
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
    const top = git(["rev-parse", "--show-toplevel"]);
    const head = git(["-C", top, "rev-parse", "HEAD"]);
    const status = git(["-C", top, "status", "--porcelain=v1"]);
    const diff = git(["-C", top, "diff", "HEAD"]);
    return codeFingerprintFromGit({ head, status, diff });
  } catch {
    return null;
  }
}

/**
 * Gates a triple-green streak requires to be PASS. Manual/external rows
 * (accent ballots, real-phone checklist, Talk/Hold pinning) are deliberately
 * absent: they stay informational and can never block the exit claim.
 */
export const STREAK_REQUIRED_GATES = [
  "plumbing",
  "reply-gap",
  "end-of-turn",
  "greeting-cut",
  "barge-in-cut",
  "filler-resume",
  "overheard-recall",
  "email-invite",
  "double-talk",
  "dead-air",
  "end-call-drain",
  "timbre-probes",
] as const;

/**
 * Rows whose only truthful status is INFO when evidence exists: the
 * measurements gate reports provenance, not a measurement. It must be PASS or
 * INFO "measured evidence present"; FAIL (a run with no measurements) blocks.
 */
export const STREAK_PROVENANCE_GATES = ["measurements"] as const;

/** Review-only rows: FAIL/INFO/missing here never fails the streak. */
export const STREAK_INFORMATIONAL_GATES = [
  "accent-human",
  "phone-checklist",
  "talk-hold-pinned",
] as const;

export const STREAK_SIZE = 3;

export type StreakFailureCode =
  | "too-few-runs"
  | "recorded-at-invalid"
  | "recorded-at-not-increasing"
  | "voice-mismatch"
  | "schema-mismatch"
  | "fingerprint-missing"
  | "fingerprint-differs"
  | "gate-not-pass"
  | "unexpected-gate-not-pass"
  | "behavior-missing"
  | "behavior-failed"
  | "behavior-code-missing"
  | "behavior-code-differs"
  | "artifact-unreadable";

export type StreakFailure = {
  code: StreakFailureCode;
  /** Run id the problem belongs to; null for the streak or behavior as a whole. */
  run: string | null;
  /** Gate name when the problem is a gate row; null otherwise. */
  gate: string | null;
  detail: string;
};

/** The artifact fields the streak judges; a full ScoreboardArtifact satisfies it. */
export type StreakArtifact = {
  schemaVersion: number;
  recordedAt: string;
  voice: string;
  runId: string;
  gates: ScoreboardGate[];
  codeFingerprint: CodeFingerprint | null;
};

export type StreakResult = {
  ok: boolean;
  gateVoice: string;
  runs: number;
  requiredGates: readonly string[];
  informationalGates: readonly string[];
  artifacts: StreakArtifact[];
  behavior: BehaviorRunEvidence | null;
  failures: StreakFailure[];
};

/**
 * Ticket 27: the only non-PASS email-invite row a green streak tolerates.
 * Judged by the typed reason, never by the detail prose.
 */
export function isUnmeasuredMemoryEmailInvite(gate: ScoreboardGate): boolean {
  return gate.status === "INFO" && gate.reason === "unmeasured-memory";
}

/** One artifact in the evaluated window that could not be read (a crashed run). */
export type UnreadableArtifact = { name: string; reason: string };

function sameFingerprint(a: CodeFingerprint, b: CodeFingerprint): boolean {
  return a.head === b.head && a.dirtyHash === b.dirtyHash && a.dirty === b.dirty;
}

function describeFingerprint(fingerprint: CodeFingerprint | null): string {
  if (!fingerprint) return "missing";
  return `${fingerprint.head.slice(0, 12)}${fingerprint.dirty ? "+dirty" : ""}`;
}

/**
 * Judge the last three artifacts (oldest first) plus the candidate behavior
 * run. Every required gate PASSes, every artifacts shares one voice, schema
 * and code fingerprint, timestamps strictly increase, and the behavior suite
 * passed on the same code. All problems are collected so the verdict names
 * every differing run and gate, not just the first.
 */
export function evaluateScoreStreak(input: {
  artifacts: StreakArtifact[];
  gateVoice: string;
  requiredGates?: readonly string[];
  provenanceGates?: readonly string[];
  informationalGates?: readonly string[];
  expectedSchemaVersion?: number;
  behavior?: BehaviorRunEvidence | null;
  /**
   * Candidates in the evaluated window that could not be parsed. A crashed
   * newer run must break "three consecutive" instead of being skipped.
   */
  unreadable?: readonly UnreadableArtifact[];
}): StreakResult {
  const requiredGates = input.requiredGates ?? STREAK_REQUIRED_GATES;
  const provenanceGates = input.provenanceGates ?? STREAK_PROVENANCE_GATES;
  const informationalGates = input.informationalGates ?? STREAK_INFORMATIONAL_GATES;
  const expectedSchemaVersion = input.expectedSchemaVersion ?? SCOREBOARD_SCHEMA_VERSION;
  const artifacts = input.artifacts.slice(-STREAK_SIZE);
  const failures: StreakFailure[] = [];
  const fail = (code: StreakFailureCode, run: string | null, gate: string | null, detail: string) =>
    failures.push({ code, run, gate, detail });

  if (artifacts.length < STREAK_SIZE) {
    fail(
      "too-few-runs",
      null,
      null,
      `need ${STREAK_SIZE} consecutive artifacts for ${input.gateVoice}, found ${artifacts.length}`,
    );
  }
  for (const broken of input.unreadable ?? []) {
    fail("artifact-unreadable", broken.name, null, `artifact ${broken.name} is unreadable (${broken.reason})`);
  }

  const known = new Set<string>([...requiredGates, ...provenanceGates, ...informationalGates]);
  let baselineFingerprint: CodeFingerprint | null = null;

  artifacts.forEach((artifact, index) => {
    const run = artifact.runId || `artifact ${index + 1}`;
    if (artifact.voice !== input.gateVoice) {
      fail("voice-mismatch", run, null, `gate voice is ${input.gateVoice}, artifact voice is ${artifact.voice}`);
    }
    if (artifact.schemaVersion !== expectedSchemaVersion) {
      fail(
        "schema-mismatch",
        run,
        null,
        `schemaVersion ${artifact.schemaVersion} is not ${expectedSchemaVersion}`,
      );
    }
    const recorded = Date.parse(artifact.recordedAt);
    if (!Number.isFinite(recorded)) {
      fail("recorded-at-invalid", run, null, `recordedAt is not a timestamp: ${artifact.recordedAt}`);
    } else if (index > 0) {
      const prior = Date.parse(artifacts[index - 1].recordedAt);
      if (!(recorded > prior)) {
        fail(
          "recorded-at-not-increasing",
          run,
          null,
          `recordedAt ${artifact.recordedAt} is not after ${artifacts[index - 1].recordedAt}`,
        );
      }
    }

    if (!artifact.codeFingerprint) {
      fail("fingerprint-missing", run, null, "artifact carries no code fingerprint (git HEAD + dirty hash)");
    } else if (baselineFingerprint === null) {
      baselineFingerprint = artifact.codeFingerprint;
    } else if (!sameFingerprint(baselineFingerprint, artifact.codeFingerprint)) {
      fail(
        "fingerprint-differs",
        run,
        null,
        `code fingerprint ${describeFingerprint(artifact.codeFingerprint)} differs from ${describeFingerprint(baselineFingerprint)}`,
      );
    }

    const gates = new Map(artifact.gates.map((gate) => [gate.name, gate] as const));
    for (const name of requiredGates) {
      const gate = gates.get(name);
      if (!gate) {
        fail("gate-not-pass", run, name, "required gate is missing from the artifact");
        continue;
      }
      if (gate.status === "PASS") continue;
      if (name === "email-invite" && isUnmeasuredMemoryEmailInvite(gate)) continue;
      fail("gate-not-pass", run, name, `${gate.status} — ${gate.detail}`);
    }
    for (const name of provenanceGates) {
      const gate = gates.get(name);
      if (!gate) {
        fail("gate-not-pass", run, name, "provenance gate is missing from the artifact");
        continue;
      }
      if (gate.status === "PASS") continue;
      if (gate.status === "INFO" && gate.reason === "measured-evidence") continue;
      fail("gate-not-pass", run, name, `${gate.status} — ${gate.detail}`);
    }
    for (const gate of artifact.gates) {
      if (known.has(gate.name) || gate.status === "PASS") continue;
      fail(
        "unexpected-gate-not-pass",
        run,
        gate.name,
        `${gate.status} — only PASS or a listed informational row is green`,
      );
    }
  });

  const behavior = input.behavior ?? null;
  if (!behavior) {
    fail(
      "behavior-missing",
      null,
      null,
      "no candidate behavior run evidence; produce one with npm run test:e2e:behavior -- --evidence <path>",
    );
  } else if (!behavior.passed || behavior.exitCode !== 0) {
    fail(
      "behavior-failed",
      null,
      null,
      `candidate behavior run is red (passed=${String(behavior.passed)}, exit ${behavior.exitCode})`,
    );
  } else if (!behavior.codeFingerprint) {
    fail("behavior-code-missing", null, null, "behavior-run evidence carries no code fingerprint");
  } else {
    const artifactFingerprint =
      baselineFingerprint ?? artifacts.find((artifact) => artifact.codeFingerprint)?.codeFingerprint ?? null;
    if (!artifactFingerprint) {
      fail("behavior-code-missing", null, null, "no artifact code fingerprint to compare the behavior run against");
    } else if (!sameFingerprint(artifactFingerprint, behavior.codeFingerprint)) {
      fail(
        "behavior-code-differs",
        null,
        null,
        `behavior code ${describeFingerprint(behavior.codeFingerprint)} differs from the green streak's ${describeFingerprint(artifactFingerprint)}`,
      );
    }
  }

  return {
    ok: failures.length === 0,
    gateVoice: input.gateVoice,
    runs: artifacts.length,
    requiredGates,
    informationalGates,
    artifacts,
    behavior,
    failures,
  };
}

/** Console verdict: the claim, the runs it covers, and every differing run/gate. */
export function formatStreakVerdict(result: StreakResult): string {
  const lines = [
    `demo streak (gate ${result.gateVoice}, ${result.runs} runs, ${result.requiredGates.length} required gates)`,
    ...result.artifacts.map(
      (artifact, index) =>
        `  run ${index + 1}  ${artifact.runId.padEnd(28)} ${artifact.recordedAt}  code ${describeFingerprint(artifact.codeFingerprint)}`,
    ),
  ];
  const behavior = result.behavior;
  lines.push(
    behavior
      ? `  behavior  ${behavior.command}  ${behavior.passed ? "PASS" : "FAIL"} (exit ${behavior.exitCode})  code ${describeFingerprint(behavior.codeFingerprint)}`
      : "  behavior  missing (npm run test:e2e:behavior -- --evidence <path>)",
  );
  if (result.ok) {
    lines.push(
      `streak: PASS — ${result.runs} consecutive all-required-PASS artifacts on ${result.gateVoice} with one code fingerprint; behavior: PASS`,
    );
  } else {
    lines.push(`streak: FAIL — ${result.failures.length} problem(s)`);
    for (const failure of result.failures) {
      const where =
        failure.run !== null
          ? `run ${failure.run}${failure.gate !== null ? ` gate ${failure.gate}` : ""}`
          : "behavior";
      lines.push(`  - ${where}: ${failure.detail}`);
    }
  }
  return lines.join("\n");
}

// ── Candidate behavior-run evidence (ticket 29) ──────────────────────────────
// `npm run test:e2e:behavior` builds and serves an isolated candidate bundle,
// then runs the behavior Playwright specs against it. The runner writes this
// evidence file on both green and red so a streak claim can never silently
// omit the browser run.

export type BehaviorRunEvidence = {
  kind: typeof BEHAVIOR_RUN_EVIDENCE_KIND;
  schemaVersion: typeof BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION;
  mode: "behavior";
  passed: boolean;
  exitCode: number;
  recordedAt: string;
  command: string;
  codeFingerprint: CodeFingerprint | null;
};

function readCodeFingerprintEvidence(raw: unknown, label: string): CodeFingerprint | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw new Error(`${label} codeFingerprint must be an object`);
  const record = raw as Record<string, unknown>;
  if (typeof record.head !== "string" || record.head.trim() === "") {
    throw new Error(`${label} codeFingerprint.head must be a git HEAD string`);
  }
  if (typeof record.dirtyHash !== "string" || record.dirtyHash.trim() === "") {
    throw new Error(`${label} codeFingerprint.dirtyHash must be a sha256 string`);
  }
  if (typeof record.dirty !== "boolean") {
    throw new Error(`${label} codeFingerprint.dirty must be a boolean`);
  }
  return { head: record.head, dirtyHash: record.dirtyHash, dirty: record.dirty };
}

/** Validate a behavior-run evidence file instead of trusting its shape. */
export function parseBehaviorRunEvidence(raw: unknown): BehaviorRunEvidence {
  if (raw === null || typeof raw !== "object") {
    throw new Error("behavior-run evidence is not a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (record.kind !== BEHAVIOR_RUN_EVIDENCE_KIND) {
    throw new Error(`not a behavior-run evidence file (kind "${String(record.kind)}")`);
  }
  if (record.schemaVersion !== BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `behavior-run evidence schemaVersion ${String(record.schemaVersion)} is not ${BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION}`,
    );
  }
  if (record.mode !== "behavior") {
    throw new Error(`behavior-run evidence mode must be "behavior", got "${String(record.mode)}"`);
  }
  if (typeof record.passed !== "boolean" || typeof record.exitCode !== "number" || !Number.isFinite(record.exitCode)) {
    throw new Error("behavior-run evidence needs boolean passed and numeric exitCode");
  }
  if (typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new Error("behavior-run evidence recordedAt must be an ISO timestamp");
  }
  if (typeof record.command !== "string" || record.command.trim() === "") {
    throw new Error("behavior-run evidence command must name the command that ran");
  }
  return {
    kind: BEHAVIOR_RUN_EVIDENCE_KIND,
    schemaVersion: BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION,
    mode: "behavior",
    passed: record.passed,
    exitCode: record.exitCode,
    recordedAt: record.recordedAt,
    command: record.command,
    codeFingerprint: readCodeFingerprintEvidence(record.codeFingerprint, "behavior-run evidence"),
  };
}
