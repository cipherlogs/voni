import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodePcm } from "../audio/format-facts";
import { DEFAULT_DISTORTION_CREST_THRESHOLDS } from "../audio/distortion-crest";
import { LEVEL_TOLERANCE_DB, TRUE_PEAK_TOLERANCE_DB } from "../audio/level-facts";
import {
  END_CALL_AUDIO_GRACE_MS as SESSION_END_CALL_AUDIO_GRACE_MS,
  END_CALL_DRAIN_TIMEOUT_MS as SESSION_END_CALL_DRAIN_TIMEOUT_MS,
  END_CALL_POLL_MS as SESSION_END_CALL_POLL_MS,
  END_CALL_SETTLE_POLLS as SESSION_END_CALL_SETTLE_POLLS,
} from "../voice/session";
import {
  applyGreetingCutGate,
  applyRealCutGate,
  callerClipChanges,
  callerClipDrift,
  callerClipFingerprint,
  callerClipsFromRunnerStdout,
  evaluateGreetingCut,
  extractGreetingCutEvidence,
  greetingCutFailure,
  greetingCutTraceTurn,
  GREETING_CUT_MAX_MS,
  DEAD_AIR_MAX_MS,
  DEFAULT_GATE_VOICE,
  DOUBLE_TALK_MAX_OVERLAP_MS,
  DOUBLE_TALK_FADE_OUT_S,
  END_CALL_AUDIO_GRACE_MS,
  END_CALL_DRAIN_TIMEOUT_MS,
  END_CALL_POLL_MS,
  END_CALL_SETTLE_POLLS,
  GOODBYE_AUDIO_COVERAGE_MIN,
  HANG_UP_AFTER_GOODBYE_MAX_MS,
  hangUpDrainFailure,
  deriveFreeFloorSilence,
  evaluateDeadAir,
  evaluateDoubleTalk,
  evaluateEndCallDrain,
  postFlushOverlapMs,
  cutOverlapMs,
  parseGateRow,
  parseGateRows,
  runBodyServedBody,
  playoutCutWindow,
  parseDoubleTalkOutput,
  parseGoodbyeDrainOutput,
  parseSilenceTimeline,
  parseSilenceTimelineOutput,
  traceSilenceRef,
  evaluateFillerResumeGate,
  evaluateRealCut,
  extractRealCutEvidence,
  fillerEvidenceFromRun,
  parseFillerRunOutput,
  extractTraceSessionId,
  FILLER_RESUME_TAIL_BUDGET_MS,
  GOLDEN_BEATS,
  GOLDEN_SCRIPT,
  GOLDEN_SCRIPT_BUDGET_S,
  REPLY_GAP_P50_BUDGET_MS,
  REPLY_GAP_P95_BUDGET_MS,
  buildSkeletonArtifact,
  HUMAN_RATERS_REQUIRED,
  POP_JUMP_INT16,
  TIMBRE_LUFS_TOLERANCE_DB,
  TIMBRE_REFERENCE_LUFS,
  addHumanRating,
  analyzeTagMentions,
  bindBallotsToSubject,
  checkEvidenceTimbre,
  checkMeasuredLevel,
  checkRegressionVoice,
  type MeasuredLevelFile,
  type MeasuredLevelInput,
  ballotWeightedScore,
  evaluateTimbreBallot,
  TIMBRE_BALLOT_AXIS_WEIGHTS,
  NATURALNESS_NA_REASON,
  naturalnessApplies,
  type HumanRatings,
  checkTimbreProbes,
  codeFingerprintFromGit,
  BEHAVIOR_RUN_EVIDENCE_KIND,
  BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION,
  diffScoreboardArtifact,
  evaluateScoreStreak,
  formatStreakVerdict,
  parseBehaviorRunEvidence,
  STREAK_INFORMATIONAL_GATES,
  STREAK_REQUIRED_GATES,
  emptyHumanRatings,
  evaluateHumanGate,
  evaluateTimbreGate,
  formatHumanReview,
  classifyRunnerOutcome,
  formatArtifactDiff,
  formatEvalRunnerReport,
  formatTraceTurn,
  resolveMatrixVoices,
  classifyOverheard,
  evaluateOverheardRecall,
  formatGateTable,
  formatGoldenScript,
  formatOverheardReport,
  formatReplyGapReport,
  gateVoicePlayback,
  isRealCutExpected,
  isResumeInstructions,
  isSilenceCheckInInstructions,
  judgePostCutAnswer,
  meaningBasedEndOfTurnGate,
  measureCutLatency,
  overheardFromRunEvidence,
  overheardFromTraceExcerpt,
  parseHeardLedgerOutput,
  parseOverheardAsideOutput,
  parseTraceGaps,
  percentile,
  postCutAnswerText,
  REAL_CUT_MAX_MS,
  SILENCE_CHECK_IN_MAX_MS,
  SILENCE_CHECK_IN_TARGET_MS,
  redactTranscript,
  regressionVoices,
  replyGapGate,
  replyGapMs,
  resolveGateVoice,
  sha256Hex,
  attributeFirstTraceGap,
  buildSubScores,
  traceTurnPointers,
  traceTurnForVisitorSpeech,
  traceTurnsForAgentLines,
  namesTeamInbox,
  parseRunnerHangUp,
  runnerHangUpDelayMs,
  TEAM_INBOX_ADDRESS,
  emailInviteGate,
  formatSubScoreTable,
  hasMeasuredEvidence,
  measuredEvidenceSources,
  persistsEmailAcrossMemory,
  validateProbeCounts,
  type OverheardAside,
  EMAIL_INVITE_TAG,
  applyEmailInvite,
  countTagMentions,
  countWorkEmailGate,
  evaluateEmailInvite,
  findInventedTags,
  findStrayAddresses,
  hasDigitSplitTag,
  type BehaviorRunEvidence,
  type CodeFingerprint,
  type RunBody,
  type ScoreboardArtifact,
  type ScoreboardGate,
  type StreakArtifact,
} from "./scoreboard";
import {
  buildRegressionMatrix,
  formatMatrixTable,
  subjectGateVerdict,
  subjectRowKey,
} from "./subject-verdict";
import {
  SCOREBOARD_BUDGETS,
  budgetValues,
  checkBudgetFreeze,
  checkGoldenWindows,
  goldenWindowExpectations,
} from "./scoreboard-budgets";
import { judgeOverlap } from "../voice/barge-in";
import { FLOOR_AXIS_THRESHOLDS } from "../audio/floor-mode";
import { BREAKUP_MATCH_SECONDS } from "./timbre-measurement";
import { formatSubject, resolveSubject, sameSubject, type SubjectRecord } from "./subject";
import { EN_RECOGNITION } from "../voice/recognition";
import { DEMO_VOICE_IDS, SILENCE_CHECK_IN_INSTRUCTIONS, SILENCE_CHECK_IN_MS } from "./voni-agent";
import type { RunnerEvidence } from "./runner-evidence";
import { buildDemoAgentBody, parseServedDemoAgentBody } from "./stored-agents";
import { voiceOutputVolume } from "../agents/voice-levels";

/** The gate voice's measured output level on the stored body (voice-parity 37). */
const SERVED_LEVEL = voiceOutputVolume(DEFAULT_GATE_VOICE);

/**
 * A platform-read run body for gate tests (voice-parity ticket 24): every test
 * goes through the same read result the orchestrator passes, never a naked
 * body object. `volume: undefined` = the platform served no level.
 */
function runBodyOf(
  volume: number | undefined,
  opts: {
    agentId?: string;
    fingerprint?: string | null;
    turnDetection?: unknown;
    hasTurnKey?: boolean;
  } = {},
) {
  const agentId = opts.agentId ?? "agent_stored";
  const fingerprint = opts.fingerprint === undefined ? "fp_stored" : opts.fingerprint;
  const hasTurnKey = opts.hasTurnKey !== false;
  const parsed = parseServedDemoAgentBody(
    agentId,
    {
      input: hasTurnKey ? { turn_detection: opts.turnDetection ?? null } : {},
      ...(volume === undefined ? {} : { output: { volume } }),
    },
    fingerprint,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return { measured: true as const, body: parsed.body, agentId, fingerprint };
}

/**
 * Two independent raters at five out of five on one shared recording
 * (voice-parity ticket 74): the ballot half of the timbre gate.
 */
function passingBallots(recording: string = "c".repeat(64)): HumanRatings {
  const one = addHumanRating(
    emptyHumanRatings(recording),
    { rater: "ana", timbre: 5, accent: 5 },
    recording,
  );
  return addHumanRating(one, { rater: "bob", timbre: 5, accent: 5 }, recording);
}

test("golden script is locked to seven beats in fixed order", () => {
  assert.deepEqual([...GOLDEN_BEATS], [
    "greeting-cut",
    "filler-ignored",
    "real-cut-answered",
    "overheard-aside",
    "silence-check-in",
    "email-invite",
    "goodbye-drain",
  ]);
});

test("gate voice resolves through the registry, unknown voices throw", () => {
  for (const id of DEMO_VOICE_IDS) {
    assert.equal(resolveGateVoice(id), id);
  }
  assert.throws(() => resolveGateVoice("not-a-voice"), /unknown gate voice/);
  // The gate is a registry id, not a near-miss: no case folding, no trimming.
  for (const miss of ["", " Anna", "anna ", "Anna", "ANNA"]) {
    assert.throws(() => resolveGateVoice(miss), /unknown gate voice/, `"${miss}" is not a gate voice`);
  }
});

test("transcripts are redacted before landing in the artifact", () => {
  assert.equal(
    redactTranscript("mail me at andres@casaverde.pt or +351 912 345 678"),
    "mail me at [email] or [phone]",
  );
  assert.equal(redactTranscript("use sk-abcdefghijklmnopqr to call"), "use [credential] to call");
});

test("sha256 helper is deterministic hex with avalanche", () => {
  assert.match(sha256Hex("voni"), /^[0-9a-f]{64}$/);
  assert.equal(sha256Hex("voni"), sha256Hex("voni"));
  assert.notEqual(sha256Hex("voni"), sha256Hex("Voni"));
});

test("skeleton artifact carries every required key with empty human slots", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: 'heard: "Wait, stop."\n',
    exitCode: 0,
    durationMs: 1234,
    runs: 1,
    dryRun: true,
  });
  assert.equal(artifact.schemaVersion, 4);
  assert.equal(artifact.voice, DEFAULT_GATE_VOICE);
  for (const beat of GOLDEN_BEATS) {
    const timing = artifact.beats[beat];
    assert.ok(timing, `missing beat ${beat}`);
    assert.ok("gapMs" in timing && "cutMs" in timing && "drainMs" in timing);
  }
  assert.ok(Array.isArray(artifact.doubleTalk.overlapMs));
  assert.ok(Array.isArray(artifact.deadAir.gapsMs));
  for (const probe of ["jump", "overload", "clip", "underrun", "inputDrop"] as const) {
    assert.equal(typeof artifact.probes[probe], "number");
  }
  assert.match(artifact.transcripts.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(artifact.transcripts.redacted));
  assert.ok(!artifact.transcripts.redacted.join("\n").includes("@casaverde.pt"));
  assert.equal(artifact.humanRatings.timbre, null);
  assert.equal(artifact.humanRatings.accent, null);
  assert.ok(artifact.gates.length > 0);
  assert.ok(artifact.gates.every((g) => g.status === "PASS" || g.status === "INFO"));
});

test("unmeasured beat rows are placeholder INFO, never a false PASS", () => {
  const dry = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "(dry run: eval runner skipped)",
    exitCode: null,
    durationMs: 0,
    runs: 1,
    dryRun: true,
  });
  for (const beat of GOLDEN_BEATS) {
    assert.equal(dry.beats[beat].status, "INFO", `${beat} placeholder must not PASS`);
    assert.match(dry.beats[beat].note, /placeholder/, `${beat} names its placeholder`);
  }
  const measured = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    gaps: { "greeting-cut": [900] },
  });
  assert.equal(measured.beats["greeting-cut"].status, "PASS");
  assert.match(measured.beats["greeting-cut"].note, /reply gap p50 900ms/);
});

test("harness break: non-dry runner crash fails plumbing, dry runs stay clean", () => {
  const broken = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 1,
    durationMs: 10,
    runs: 1,
  });
  const plumbing = broken.gates.find((g) => g.name === "plumbing")!;
  assert.equal(plumbing.status, "FAIL");
  assert.match(plumbing.detail, /harness break/);
  const clean = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "(dry run: eval runner skipped)",
    exitCode: null,
    durationMs: 0,
    runs: 1,
    dryRun: true,
  });
  assert.ok(clean.gates.every((g) => g.status !== "FAIL"));
});

test("console table prints one row per gate", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  const table = formatGateTable(artifact);
  for (const gate of artifact.gates) {
    assert.ok(table.includes(gate.name), `table missing gate ${gate.name}`);
  }
  assert.ok(table.includes("PASS") || table.includes("INFO"));
});

test("golden script locks seven beats in fixed order with wording and timing windows", () => {
  assert.equal(GOLDEN_SCRIPT_BUDGET_S, 90);
  assert.deepEqual(
    GOLDEN_SCRIPT.map((b) => b.beat),
    [...GOLDEN_BEATS],
  );
  for (const beat of GOLDEN_SCRIPT) {
    assert.ok(beat.visitor.length > 0, `${beat.beat} needs fixed visitor wording`);
    assert.ok(beat.expect.length > 0, `${beat.beat} needs a pass predicate`);
    assert.ok(beat.source.length > 0, `${beat.beat} needs its prior-art source`);
    assert.ok(
      Number.isFinite(beat.window.min) && Number.isFinite(beat.window.max),
      `${beat.beat} needs a numeric timing window`,
    );
    assert.ok(beat.window.min <= beat.window.max, `${beat.beat} window is inverted`);
    assert.ok(beat.window.metric.length > 0, `${beat.beat} window needs a metric name`);
  }
});

test("golden script windows match the established cut/gap/drain contracts", () => {
  const windowOf = (beat: string) => GOLDEN_SCRIPT.find((b) => b.beat === beat)!.window;
  assert.ok(windowOf("greeting-cut").max <= 1500, "greeting cut comparable to the stop-over 1.5s bar");
  assert.ok(windowOf("real-cut-answered").max <= 1500, "real cut answered within 1500ms (story 4)");
  assert.ok(windowOf("filler-ignored").max <= 2500, "filler resume tail within 2500ms (story 6)");
  assert.ok(windowOf("silence-check-in").min >= 15000, "check-in only after 15s of silence");
  const invite = GOLDEN_SCRIPT.find((b) => b.beat === "email-invite")!;
  assert.equal(invite.window.min, 1);
  assert.equal(invite.window.max, 1);
  assert.ok(invite.visitor.includes("property agency"), "invite uses the property-inquiry vertical");
  assert.ok(invite.expect.includes("Lime 42"), "invite uses the call Test tag");
  assert.ok(windowOf("goodbye-drain").max <= 1500, "hang-up within 1500ms of goodbye audio end");
  const aside = GOLDEN_SCRIPT.find((b) => b.beat === "overheard-aside")!;
  assert.equal(aside.window.min, 1);
  assert.equal(aside.window.max, 1);
});

test("default gate voice resolves through the registry, never as a literal", () => {
  assert.equal(DEFAULT_GATE_VOICE, DEMO_VOICE_IDS[0]);
  assert.equal(resolveGateVoice(DEFAULT_GATE_VOICE), DEFAULT_GATE_VOICE);
});

test("gate voice playback takes its level from the served body and has no playback gain", () => {
  for (const id of DEMO_VOICE_IDS) {
    const unread = gateVoicePlayback(id);
    assert.equal(unread.id, id);
    assert.equal(unread.outputVolume, null, "no body read means the level is unmeasured");
    assert.equal("playbackGain" in unread, false, "there is no client playback gain");
    const served = gateVoicePlayback(id, runBodyOf(62, { fingerprint: null }));
    assert.equal(served.outputVolume, 62, "the served level reaches playback unchanged");
  }
  assert.throws(() => gateVoicePlayback("not-a-voice"), /unknown gate voice/);
});

test("regression set is every demo voice except the gate", () => {
  for (const gate of DEMO_VOICE_IDS) {
    const rest = regressionVoices(gate);
    assert.ok(!rest.includes(gate), `regression set must exclude gate ${gate}`);
    assert.deepEqual([...rest].sort(), [...DEMO_VOICE_IDS].filter((v) => v !== gate).sort());
  }
  assert.throws(() => regressionVoices("not-a-voice"), /unknown gate voice/);
});

test("dry-run listing names every beat with its window plus gate and regression voices", () => {
  const listing = formatGoldenScript(DEFAULT_GATE_VOICE);
  for (const beat of GOLDEN_BEATS) {
    assert.ok(listing.includes(beat), `listing missing beat ${beat}`);
  }
  assert.ok(listing.includes(DEFAULT_GATE_VOICE), "listing names the gate voice");
  for (const voice of regressionVoices(DEFAULT_GATE_VOICE)) {
    assert.ok(listing.includes(voice), `listing missing regression voice ${voice}`);
  }
});

test("skeleton artifact records the locked script and the regression voice set", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: 'heard: "Wait, stop."\n',
    exitCode: 0,
    durationMs: 1234,
    runs: 1,
  });
  assert.deepEqual(
    artifact.goldenScript.beats.map((b) => b.beat),
    [...GOLDEN_BEATS],
  );
  assert.deepEqual([...artifact.regressionVoices].sort(), [...regressionVoices(DEFAULT_GATE_VOICE)].sort());
  assert.ok(artifact.goldenScript.beats.every((b) => b.window.min <= b.window.max));
  assert.ok(artifact.goldenScript.beats.every((b) => b.visitor.length > 0));
});

test("reply gap budgets match the spec: p50 1500ms, p95 2500ms", () => {
  assert.equal(REPLY_GAP_P50_BUDGET_MS, 1500);
  assert.equal(REPLY_GAP_P95_BUDGET_MS, 2500);
});

test("reply gap is visitor end-of-speech to first agent audio", () => {
  assert.equal(replyGapMs(1000, 1900), 900);
  assert.equal(replyGapMs(null, 1900), null);
  assert.equal(replyGapMs(1000, null), null);
  assert.equal(replyGapMs(null, null), null);
});

test("percentile uses nearest-rank with known literals", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([900], 50), 900);
  assert.equal(percentile([800, 900, 1000, 1100, 3000], 50), 1000);
  assert.equal(percentile([800, 900, 1000, 1100, 3000], 95), 3000);
  assert.equal(percentile([3000, 800, 1100, 900, 1000], 50), 1000);
});

test("trace gaps reuse the call-trace merger gap math and skip cut turns", () => {
  const excerpt = [
    '12.10s  HEARD   "Wait, stop."  (10.20s–11.30s)',
    '12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)',
    '13.00s  VONI    "Cut short"  (reply_create gap 400ms)  CUT at 13.10s',
    '14.50s  VONI    "Back to the tour"  (reply_create ttfa 700ms gap 1200ms)',
  ];
  const gaps = parseTraceGaps(excerpt);
  assert.deepEqual(
    gaps.map((g) => [g.gapMs, g.turnIndex]),
    [
      [900, 1],
      [1200, 3],
    ],
  );
});

test("the runner's trace session line is parsed from its output", () => {
  assert.equal(extractTraceSessionId("greeting-cut: 1/1\n"), null);
  assert.equal(extractTraceSessionId("  · trace session sess_ab12\n"), "sess_ab12");
  // A multi-run eval prints one line per live call; the last call wins.
  assert.equal(
    extractTraceSessionId("  · trace session sess_first\ngreeting-cut: 1/1\n  · trace session sess_last\n"),
    "sess_last",
  );
  // A transcript that merely echoes a session id is not the runner's marker.
  assert.equal(extractTraceSessionId('heard: "sess_nope"\n'), null);
});

test("per-turn reply gap report lists turn indices and the trace session to replay", () => {
  const excerpt = [
    '12.10s  HEARD   "Wait, stop."  (10.20s–11.30s)',
    '12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)',
    '13.00s  VONI    "Cut short"  (reply_create gap 400ms)  CUT at 13.10s',
    '14.50s  VONI    "Back to the tour"  (reply_create ttfa 700ms gap 1200ms)',
  ];
  assert.equal(
    formatReplyGapReport(excerpt, "sess_ab12"),
    [
      "reply gap per turn (sess_ab12; turn = Nth VONI reply in the merged trace)",
      "  turn 1  900ms",
      "  turn 3  1200ms",
      "  replay: npm run call:trace -- sess_ab12",
    ].join("\n"),
  );
  assert.equal(
    formatReplyGapReport([], null),
    ["reply gap per turn (no trace session)", "  no per-turn gaps merged"].join("\n"),
  );
  assert.equal(
    formatReplyGapReport(['12.20s  VONI    "hi"  (reply_create gap 900ms)'], null),
    ["reply gap per turn (no trace session)", "  turn 1  900ms"].join("\n"),
  );
  assert.equal(
    formatReplyGapReport(['12.10s  HEARD   "Hi"  (0.00s-1.00s)'], "sess_ab12"),
    [
      "reply gap per turn (sess_ab12; turn = Nth VONI reply in the merged trace)",
      "  no per-turn gaps merged",
      "  replay: npm run call:trace -- sess_ab12",
    ].join("\n"),
  );
});

test("reply-gap gate stays INFO with no measured gaps", () => {
  const gate = replyGapGate([]);
  assert.equal(gate.name, "reply-gap");
  assert.equal(gate.status, "INFO");
});

test("reply-gap gate passes with gaps inside budget", () => {
  const gate = replyGapGate([
    { beat: "greeting-cut", gapMs: 900, turnIndex: 1 },
    { beat: "real-cut-answered", gapMs: 1200, turnIndex: 2 },
  ]);
  assert.equal(gate.status, "PASS");
  assert.ok(gate.detail.includes("p50"), `detail reports p50: ${gate.detail}`);
  assert.ok(gate.detail.includes("p95"), `detail reports p95: ${gate.detail}`);
});

test("reply-gap gate fails when the p50 of a real distribution exceeds 1500ms", () => {
  const gate = replyGapGate([
    { beat: "real-cut-answered", gapMs: 1600, turnIndex: 2 },
    { beat: "real-cut-answered", gapMs: 1700, turnIndex: 3 },
    { beat: "real-cut-answered", gapMs: 1800, turnIndex: 4 },
    { beat: "real-cut-answered", gapMs: 1900, turnIndex: 5 },
  ]);
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("real-cut-answered"), `detail names the failing beat: ${gate.detail}`);
  assert.ok(gate.detail.includes("p50"), `detail names the breached budget: ${gate.detail}`);
});

test("a lone 2016ms turn does not count as its own p50 breach (live balanced sample)", () => {
  const gate = replyGapGate([
    { beat: "real-cut-answered", gapMs: 1171, turnIndex: 1 },
    { beat: "overheard-aside", gapMs: 1019, turnIndex: 2 },
    { beat: "email-invite", gapMs: 1859, turnIndex: 3 },
    { beat: "overheard-aside", gapMs: 2016, turnIndex: 4 },
  ]);
  assert.equal(gate.status, "PASS", gate.detail);
});

test("reply-gap gate fails when p95 exceeds 2500ms", () => {
  const gate = replyGapGate([
    { beat: "greeting-cut", gapMs: 900, turnIndex: 1 },
    { beat: "real-cut-answered", gapMs: 900, turnIndex: 2 },
    { beat: "email-invite", gapMs: 900, turnIndex: 3 },
    { beat: "email-invite", gapMs: 900, turnIndex: 4 },
    { beat: "goodbye-drain", gapMs: 3100, turnIndex: 5 },
  ]);
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("p95"), `detail names the breached budget: ${gate.detail}`);
  assert.ok(gate.detail.includes("turn 5"), `detail points at the failing trace turn: ${gate.detail}`);
});

test("a FAIL from an ordinary-band turn cites band, turn, call and value", () => {
  const gate = replyGapGate([
    { beat: "email-invite", gapMs: 900, turnIndex: 1, sessionId: "sess_ord", band: "ordinary" },
    { beat: "email-invite", gapMs: 1000, turnIndex: 2, sessionId: "sess_ord", band: "ordinary" },
    { beat: "email-invite", gapMs: 1100, turnIndex: 3, sessionId: "sess_ord", band: "ordinary" },
    { beat: "email-invite", gapMs: 2600, turnIndex: 4, sessionId: "sess_ord", band: "ordinary" },
  ]);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /p95 2600ms > 2500ms budget/, gate.detail);
  assert.match(gate.detail, /band ordinary/, gate.detail);
  assert.match(gate.detail, /call trace turn 4 \(sess_ord\)/, gate.detail);
});

test("a FAIL from a post-cut turn cites band, turn, call and value", () => {
  const gate = replyGapGate([
    { beat: "real-cut-answered", gapMs: 900, turnIndex: 1, sessionId: "sess_cut", band: "ordinary" },
    { beat: "real-cut-answered", gapMs: 1000, turnIndex: 2, sessionId: "sess_cut", band: "post-cut" },
    { beat: "real-cut-answered", gapMs: 2600, turnIndex: 3, sessionId: "sess_cut", band: "post-cut" },
  ]);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /p95 2600ms > 2500ms budget/, gate.detail);
  assert.match(gate.detail, /band post-cut/, gate.detail);
  assert.match(gate.detail, /call trace turn 3 \(sess_cut\)/, gate.detail);
});

test("PASS detail stays the one pooled line even when bands are known", () => {
  const gate = replyGapGate([
    { beat: "email-invite", gapMs: 900, turnIndex: 1, sessionId: "sess_pass", band: "ordinary" },
    { beat: "email-invite", gapMs: 1000, turnIndex: 2, sessionId: "sess_pass", band: "post-cut" },
    { beat: "email-invite", gapMs: 1100, turnIndex: 3, sessionId: "sess_pass", band: "ordinary" },
  ]);
  assert.equal(gate.status, "PASS");
  assert.equal(gate.detail, "p50 1000ms / p95 1100ms within 1500/2500ms budgets (n=3)");
});

test("naming a post-cut band never removes it from the pooled samples", () => {
  const samples = [
    { beat: null, gapMs: 900, turnIndex: 1, sessionId: "sess_pool" },
    { beat: null, gapMs: 1000, turnIndex: 2, sessionId: "sess_pool" },
    { beat: null, gapMs: 1100, turnIndex: 3, sessionId: "sess_pool" },
    { beat: null, gapMs: 2600, turnIndex: 4, sessionId: "sess_pool" },
  ];
  const plain = replyGapGate(samples);
  const banded = replyGapGate([
    { ...samples[0], band: "ordinary" },
    { ...samples[1], band: "ordinary" },
    { ...samples[2], band: "ordinary" },
    { ...samples[3], band: "post-cut" },
  ]);
  const pooled = (detail: string) => /overall p50 \d+ms \/ p95 \d+ms, n=\d+/.exec(detail)?.[0];
  assert.equal(banded.status, plain.status);
  assert.equal(pooled(banded.detail), pooled(plain.detail));
  assert.equal(pooled(banded.detail), "overall p50 1000ms / p95 2600ms, n=4");
  assert.match(banded.detail, /band post-cut/, banded.detail);
});

test("a FAIL with no band evidence says band unmeasured rather than guessing", () => {
  const gate = replyGapGate([
    { beat: null, gapMs: 900, turnIndex: 1, sessionId: "sess_dark" },
    { beat: null, gapMs: 1000, turnIndex: 2, sessionId: "sess_dark" },
    { beat: null, gapMs: 1100, turnIndex: 3, sessionId: "sess_dark" },
    { beat: null, gapMs: 2600, turnIndex: 4, sessionId: "sess_dark" },
  ]);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /band unmeasured/, gate.detail);
  assert.doesNotMatch(gate.detail, /band ordinary|band post-cut/, gate.detail);
});

test("the artifact's reply-gap FAIL names the band measured by the runner's split", () => {
  const excerpt = [
    '10.00s  HEARD   "Yes please"  (9.20s–9.90s)',
    '10.90s  VONI    "Happy to help"  (reply_create gap 900ms)',
    '12.00s  VONI    "Of course"  (reply_create gap 1000ms)',
    '13.10s  VONI    "The team is small"  (reply_create gap 1100ms)',
    '15.70s  VONI    "Wait, stop - here is that answer"  (reply_create gap 2600ms)',
  ];
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceGaps: parseTraceGaps(excerpt),
    traceExcerpt: excerpt,
    traceSessionId: "sess_join",
    runnerEvidence: {
      sessions: [
        {
          id: "sess_join",
          turns: [
            { turnIndex: 4, latency: { turnId: "turn-4", band: "post-cut", endpointingMs: 400, generationMs: 900, deliveryMs: 300, perceivedMs: 2100 } },
          ],
        },
      ],
    } as unknown as RunnerEvidence,
  });
  const gate = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /band post-cut/, gate.detail);
  assert.match(gate.detail, /call trace turn 4 \(sess_join\)/, gate.detail);
  assert.match(gate.detail, /gap 2600ms/, gate.detail);
});

test("every merged turn is judged against the tail budget and cites its Call trace turn", () => {
  // Six fast turns and one 2600ms tail turn. The tail budget is 2500ms, so
  // the per-turn judgment catches the single slow turn and names it.
  const excerpt = [
    '10.00s  HEARD   "Yes please"  (9.20s–9.90s)',
    '10.90s  VONI    "Happy to help"  (reply_create gap 900ms)',
    '12.00s  VONI    "Of course"  (reply_create ttfa 600ms gap 1000ms)',
    '13.10s  VONI    "The team is small"  (reply_create gap 1100ms)',
    '14.20s  VONI    "Two bedrooms"  (reply_create gap 1200ms)',
    '16.40s  VONI    "Here is the tag"  (reply_create gap 2600ms)',
    '17.50s  VONI    "Thanks for calling"  (reply_create gap 1300ms)',
  ];
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceGaps: parseTraceGaps(excerpt),
    traceExcerpt: excerpt,
    traceSessionId: "sess_per_turn",
  });
  const reply = artifact.replyGap;
  assert.equal(reply.p50Ms, 1100, "the call-level distribution is inside budget");
  assert.equal(reply.p95Ms, 2600, "the call-level p95 carries the slow turn");
  const gate = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /call trace turn 5 \(sess_per_turn\)/, `detail points at turn 5: ${gate.detail}`);
  assert.match(gate.detail, /2600ms/);
});

test("all-fast merged turn passes every per-turn budget and keeps meaning-based end-of-turn", () => {
  const excerpt = [
    '10.00s  HEARD   "Yes please"  (9.20s–9.90s)',
    '10.90s  VONI    "Happy to help"  (reply_create gap 900ms)',
    '12.00s  VONI    "Of course"  (reply_create gap 1000ms)',
    '13.10s  VONI    "The team is small"  (reply_create gap 1100ms)',
    '14.20s  VONI    "Two bedrooms"  (reply_create gap 1200ms)',
    '15.40s  VONI    "Here is the tag"  (reply_create gap 1300ms)',
  ];
  const runBody = runBodyOf(100, { agentId: "agent_fast", fingerprint: null });
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceGaps: parseTraceGaps(excerpt),
    traceExcerpt: excerpt,
    traceSessionId: "sess_fast",
    runBody,
  });
  const gate = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /p50 1100ms/, `every turn is inside budget: ${gate.detail}`);
  // Ticket 24 stays intact: per-turn judgment introduces no turn-detection
  // object on the managed path and the merged excerpt carries no CONFIG line.
  assert.equal(runBodyServedBody(runBody)?.input.turn_detection, null);
  assert.ok(!excerpt.some((line) => line.includes("turn_detection")));
  assert.equal(artifact.gates.find((g) => g.name === "end-of-turn")?.status, "PASS");
  assert.equal(artifact.agentBody?.agentId, "agent_fast");
});

test("the suite's per-scenario traces keep their own session and beat attribution", () => {
  // The suite merges one trace per scenario; turn numbers restart at 1 in
  // each call, so the session id is part of the pointer and two turn-1 gaps
  // must both be judged, not deduped into one.
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceGaps: [
      { gapMs: 1900, turnIndex: 2, sessionId: "sess_greeting", beat: "greeting-cut" },
      { gapMs: 2000, turnIndex: 1, sessionId: "sess_stop", beat: "real-cut-answered" },
      { gapMs: 800, turnIndex: 3, sessionId: "sess_stop" },
    ],
    traceExcerpt: ['1.00s  VONI    "Hello"  (greeting)'],
    traceSessionId: "sess_greeting",
  });
  const reply = artifact.replyGap;
  assert.equal(reply.samples, 3);
  assert.equal(artifact.beats["greeting-cut"].gapMs, 1900, "the greeting call's own gap");
  assert.equal(artifact.beats["real-cut-answered"].gapMs, 2000, "the stop-over call's own gap");
  const gate = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /turn 1 \(sess_stop\)/, `cites the stop-over call: ${gate.detail}`);
  assert.match(gate.detail, /2000ms/);
});

test("only the verified first turn is attributed to a beat; later turns stay call-level", () => {
  const excerpt = [
    '0.50s  VONI    "Hi, you have reached Voni"  (reply_create gap 900ms)  greeting-cut',
    '3.00s  VONI    "Of course"  (reply_create gap 2600ms)',
    '5.00s  VONI    "The price is 450"  (reply_create gap 1100ms)',
  ];
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceGaps: parseTraceGaps(excerpt),
    traceExcerpt: excerpt,
    traceSessionId: "sess_round_robin",
  });
  // Round-robin attribution would hand turn 2 to the next beat; only the
  // verified greeting opening is ever attributed.
  assert.deepEqual(artifact.beats["greeting-cut"].gapSamples, [900]);
  for (const beat of GOLDEN_BEATS.filter((b) => b !== "greeting-cut")) {
    assert.deepEqual(artifact.beats[beat].gapSamples, [], `beat ${beat} must not claim a later turn`);
  }
  const gate = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /call trace turn 2 \(sess_round_robin\)/, `detail points at turn 2: ${gate.detail}`);
  assert.match(gate.detail, /overall/, `later turns are judged call-level (overall): ${gate.detail}`);
});

test("greeting-cut breach fails within the same gap budget and names the beat", () => {
  const gate = replyGapGate([
    { beat: "greeting-cut", gapMs: 2600, turnIndex: 1 },
    { beat: "greeting-cut", gapMs: 2700, turnIndex: 2 },
  ]);
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("greeting-cut"), `detail names the greeting-cut beat: ${gate.detail}`);
});

test("meaning-based end-of-turn passes when no turn-detection object is sent", () => {
  const gate = meaningBasedEndOfTurnGate({ turn_detection: null });
  assert.equal(gate.name, "end-of-turn");
  assert.equal(gate.status, "PASS");
});

test("meaning-based end-of-turn fails when a turn-detection object is sent", () => {
  const gate = meaningBasedEndOfTurnGate({ turn_detection: { min_silence: 100 } });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("turn_detection"), `detail names the object: ${gate.detail}`);
});

test("meaning-based end-of-turn fails when the merged trace shows a turn-detection config", () => {
  const gate = meaningBasedEndOfTurnGate({ turn_detection: null }, [
    "12.20s  VONI    \"Sorry about that\"  (reply_create gap 900ms)",
    '13.00s  CONFIG  turn_detection {"min_silence":100}',
  ]);
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("turn_detection"), `detail points at the CONFIG line: ${gate.detail}`);
});

test("a production turn-detection object fails with the existing contract detail", () => {
  const gate = meaningBasedEndOfTurnGate({ turn_detection: { min_silence: 100 } });
  assert.equal(gate.status, "FAIL");
  assert.equal(
    gate.detail,
    'turn_detection object sent ({"min_silence":100}): disables adaptive end-of-turn (ADR-0003); stored demo agents must send turn_detection: null',
  );
});

test("a production Call trace CONFIG line fails with the existing contract detail", () => {
  const line = '13.00s  CONFIG  turn_detection {"min_silence":100}';
  const gate = meaningBasedEndOfTurnGate({ turn_detection: null }, [line]);
  assert.equal(gate.status, "FAIL");
  assert.equal(
    gate.detail,
    `call trace shows a turn_detection CONFIG line (${line.slice(0, 160)}): no turn-detection object may be sent on the managed session path (ADR-0003)`,
  );
});

test("a variant run with no CONFIG evidence is unmeasured, never a PASS", () => {
  const gate = meaningBasedEndOfTurnGate({ turn_detection: null }, [], {
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
    agentId: "agent_exp",
  });
  assert.equal(gate.status, "INFO");
  assert.match(gate.detail, /unmeasured/i);
  assert.doesNotMatch(gate.detail, /meaning-based end-of-turn preserved/);
});

test("a variant run with no recorded windows is unmeasured, never a PASS", () => {
  const gate = meaningBasedEndOfTurnGate({ turn_detection: null }, [], {
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows: null,
    agentId: "agent_exp",
  });
  assert.equal(gate.status, "INFO");
  assert.match(gate.detail, /unmeasured/i);
});

// Rung 1, 2026-10-29: the live variant call's own server CONFIG row echoed the
// variant windows (plus the server's normalized fields) and the production
// CONFIG guard failed the run. The same live-shaped line is used below so the
// experiment's own row is evidence, while a production trace stays a FAIL.
const LIVE_VARIANT_CONFIG_LINE =
  '0.07s  CONFIG  turn_detection {"type":null,"vad_threshold":0.5,"interrupt_response":true,' +
  '"min_silence":400,"max_silence":640,"interruption_delay":0,"uninterruptible_turns":[]}  agent=agent_exp';
const LIVE_VARIANT_CONFIG_PREFIX =
  '0.07s  CONFIG  turn_detection {"type":null,"vad_threshold":0.5,"interrupt_response":true,"min_silence":400,"max_silence":640,"interruption_delay":0,"uninterrupt';

test("a variant artifact whose CONFIG line carries its own windows passes on the production detail", () => {
  const turnWindows = { min_silence: 400, max_silence: 640, interruption_delay: 0 };
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL, { fingerprint: null }),
    traceExcerpt: [LIVE_VARIANT_CONFIG_LINE],
    endOfTurnExperiment: { variant: "turn-window", variantKey: "anna:exp", turnWindows, agentId: "agent_exp" },
  });
  const gate = artifact.gates.find((row) => row.name === "end-of-turn");
  assert.equal(gate?.status, "PASS", gate?.detail);
  assert.equal(
    gate?.detail,
    "meaning-based end-of-turn preserved: no turn_detection object sent (turn_detection null)",
  );
  assert.doesNotMatch(gate?.detail ?? "", /experimental/i);
  assert.equal(artifact.endOfTurn?.experimental, true);
  assert.deepEqual(artifact.endOfTurn?.turnWindows, turnWindows);
});

test("a variant CONFIG line from another agent is production and still fails", () => {
  const turnWindows = { min_silence: 400, max_silence: 640, interruption_delay: 0 };
  const line = LIVE_VARIANT_CONFIG_LINE.replace("agent=agent_exp", "agent=agent_other");
  const gate = meaningBasedEndOfTurnGate({ turn_detection: null }, [line], {
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows,
    agentId: "agent_exp",
  });
  assert.equal(gate.status, "FAIL");
  assert.equal(
    gate.detail,
    `call trace shows a turn_detection CONFIG line (${line.slice(0, 160)}): no turn-detection object may be sent on the managed session path (ADR-0003)`,
  );
});

test("a CONFIG line without an agent attribution is treated as production and still fails", () => {
  const line = '0.07s  CONFIG  turn_detection {"min_silence":400,"max_silence":640,"interruption_delay":0}';
  const gate = meaningBasedEndOfTurnGate({ turn_detection: null }, [line], {
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
    agentId: "agent_exp",
  });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /no turn-detection object may be sent/);
});

test("a variant line with no recorded windows is a stray object and still fails", () => {
  const gate = meaningBasedEndOfTurnGate({ turn_detection: null }, [LIVE_VARIANT_CONFIG_LINE], {
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows: null,
    agentId: "agent_exp",
  });
  assert.equal(gate.status, "FAIL");
  assert.equal(
    gate.detail,
    `call trace shows a turn_detection CONFIG line (${LIVE_VARIANT_CONFIG_PREFIX}): no turn-detection object may be sent on the managed session path (ADR-0003)`,
  );
});

test("a production trace with that same CONFIG line still fails with the existing contract detail", () => {
  const gate = meaningBasedEndOfTurnGate({ turn_detection: null }, [LIVE_VARIANT_CONFIG_LINE]);
  assert.equal(gate.status, "FAIL");
  assert.equal(
    gate.detail,
    `call trace shows a turn_detection CONFIG line (${LIVE_VARIANT_CONFIG_PREFIX}): no turn-detection object may be sent on the managed session path (ADR-0003)`,
  );
});

test("a variant artifact whose CONFIG line reports different windows still fails", () => {
  const turnWindows = { min_silence: 400, max_silence: 640, interruption_delay: 0 };
  const stray = '0.07s  CONFIG  turn_detection {"min_silence":100,"max_silence":640,"interruption_delay":0}  agent=agent_exp';
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL, { fingerprint: null }),
    traceExcerpt: [stray],
    endOfTurnExperiment: { variant: "turn-window", variantKey: "anna:exp", turnWindows, agentId: "agent_exp" },
  });
  const gate = artifact.gates.find((row) => row.name === "end-of-turn");
  assert.equal(gate?.status, "FAIL");
  assert.equal(
    gate?.detail,
    `call trace shows a turn_detection CONFIG line (${stray}): no turn-detection object may be sent on the managed session path (ADR-0003)`,
  );
});

test("a variant run never loosens the production object contract", () => {
  const gate = meaningBasedEndOfTurnGate({ turn_detection: { min_silence: 200 } }, [], {
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
    agentId: "agent_exp",
  });
  assert.equal(gate.status, "FAIL");
  assert.equal(
    gate.detail,
    'turn_detection object sent ({"min_silence":200}): disables adaptive end-of-turn (ADR-0003); stored demo agents must send turn_detection: null',
  );
});

test("one stray variant CONFIG row fails even when another reports the recorded windows", () => {
  const turnWindows = { min_silence: 400, max_silence: 640, interruption_delay: 0 };
  const stray = '9.00s  CONFIG  turn_detection {"min_silence":100}  agent=agent_exp';
  const gate = meaningBasedEndOfTurnGate(
    { turn_detection: null },
    [LIVE_VARIANT_CONFIG_LINE, stray],
    { variant: "turn-window", variantKey: "anna:exp", turnWindows, agentId: "agent_exp" },
  );
  assert.equal(gate.status, "FAIL");
  assert.equal(
    gate.detail,
    `call trace shows a turn_detection CONFIG line (${stray}): no turn-detection object may be sent on the managed session path (ADR-0003)`,
  );
});

test("a variant artifact records its windows in a dedicated experimental evidence field", () => {
  const turnWindows = { min_silence: 200, max_silence: 400, interruption_delay: 0 };
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL, { fingerprint: null }),
    endOfTurnExperiment: { variant: "turn-window", variantKey: "anna:exp", turnWindows, agentId: "agent_exp" },
  });
  const gate = artifact.gates.find((row) => row.name === "end-of-turn");
  assert.equal(gate?.status, "INFO");
  assert.match(gate?.detail ?? "", /unmeasured/i);
  assert.deepEqual(artifact.endOfTurn, {
    experimental: true,
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows,
    productionTurnDetection: null,
  });
});

test("a production artifact with a turn-detection object still fails with the existing contract detail", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL, { fingerprint: null, turnDetection: { min_silence: 100 } }),
  });
  const gate = artifact.gates.find((row) => row.name === "end-of-turn");
  assert.equal(gate?.status, "FAIL");
  assert.equal(
    gate?.detail,
    'turn_detection object sent ({"min_silence":100}): disables adaptive end-of-turn (ADR-0003); stored demo agents must send turn_detection: null',
  );
  assert.equal(artifact.endOfTurn, undefined);
});

test("a production artifact carries no experimental end-of-turn evidence", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL, { fingerprint: null }),
  });
  const gate = artifact.gates.find((row) => row.name === "end-of-turn");
  assert.equal(gate?.status, "PASS");
  assert.match(gate?.detail ?? "", /^meaning-based end-of-turn preserved/);
  assert.equal(artifact.endOfTurn, undefined);
});

test("end-of-turn fails on an explicit object in the served stored body", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL, {
      turnDetection: { min_silence: 100 },
    }),
  });
  const gate = artifact.gates.find((row) => row.name === "end-of-turn");
  assert.equal(gate?.status, "FAIL");
  assert.match(gate?.detail ?? "", /turn_detection object sent/);
});

test("end-of-turn passes on the Turn preset served by the stored body", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL, { fingerprint: null }),
  });
  const gate = artifact.gates.find((row) => row.name === "end-of-turn");
  assert.equal(gate?.status, "PASS", gate?.detail);
});

test("a served body with no turn_detection key is the Turn preset", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL, { fingerprint: null, hasTurnKey: false }),
  });
  const gate = artifact.gates.find((row) => row.name === "end-of-turn");
  assert.equal(gate?.status, "PASS", gate?.detail);
});

test("the artifact records which stored body the end-of-turn gate measured", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL),
  });
  assert.deepEqual(artifact.agentBody, {
    source: "stored-agent",
    measured: true,
    agentId: "agent_stored",
    fingerprint: "fp_stored",
    turnDetection: null,
    reason: null,
  });
});

test("an artifact with no served body records one unmeasured identity and stays INFO", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  const gate = artifact.gates.find((row) => row.name === "end-of-turn");
  assert.equal(gate?.status, "INFO");
  assert.match(gate?.detail ?? "", /unmeasured/i);
  assert.deepEqual(artifact.agentBody, {
    source: "stored-agent",
    measured: false,
    agentId: null,
    fingerprint: null,
    reason: "no stored body read",
  });
});

// ── Ticket 24: one stored-body seam for every gate ─────────────────────────

test("every body gate follows the one served body when it is swapped", () => {
  const artifactFor = (runBody: RunBody) =>
    buildSkeletonArtifact({
      voice: DEFAULT_GATE_VOICE,
      scenario: "suite",
      runnerStdout: "suite",
      exitCode: 0,
      durationMs: 10,
      runs: 1,
      runBody,
      measuredLevel: measuredLevel(-23.1, -23.1),
      humanRatings: passingBallots(),
      agentChannel: CLEAN_CHANNEL,
    });

  const first = artifactFor(
    runBodyOf(SERVED_LEVEL, { agentId: "agent_first", fingerprint: "fp_first" }),
  );
  assert.equal(first.gates.find((g) => g.name === "end-of-turn")?.status, "PASS");
  assert.equal(first.gates.find((g) => g.name === "timbre-probes")?.status, "PASS");
  assert.equal(first.loudness.outputVolume, SERVED_LEVEL);
  assert.equal(first.agentBody?.agentId, "agent_first");
  assert.equal(first.agentBody?.fingerprint, "fp_first");

  const second = artifactFor(
    runBodyOf(62, {
      agentId: "agent_second",
      fingerprint: "fp_second",
      turnDetection: { min_silence: 100 },
    }),
  );
  // End-of-turn, the level legs and the identity all moved with the body.
  assert.equal(second.gates.find((g) => g.name === "end-of-turn")?.status, "FAIL");
  assert.match(
    second.gates.find((g) => g.name === "end-of-turn")?.detail ?? "",
    /turn_detection object sent/,
  );
  assert.equal(second.loudness.outputVolume, 62);
  assert.match(
    second.gates.find((g) => g.name === "timbre-probes")?.detail ?? "",
    /at volume 62/,
  );
  assert.equal(second.agentBody?.agentId, "agent_second");
  assert.equal(second.agentBody?.fingerprint, "fp_second");
  assert.deepEqual(second.agentBody?.turnDetection, { min_silence: 100 });
});

test("a demo-builder reconstruction cannot pass any body gate", () => {
  const reconstruction = buildDemoAgentBody(DEFAULT_GATE_VOICE);
  const smuggled: RunBody = {
    measured: true,
    agentId: "agent_reconstructed",
    fingerprint: "fp_reconstructed",
    // @ts-expect-error a builder body is not a platform-read body
    body: reconstruction,
  };
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: smuggled,
    measuredLevel: measuredLevel(-23.1, -23.1),
  });
  for (const name of ["end-of-turn", "timbre-probes"]) {
    const gate = artifact.gates.find((row) => row.name === name);
    assert.equal(gate?.status, "INFO", `${name} must not PASS on a reconstruction: ${gate?.detail}`);
    assert.match(gate?.detail ?? "", /reconstruction/);
  }
  assert.equal(artifact.loudness.outputVolume, null, "no served level, no registry default");
  assert.equal(artifact.agentBody?.measured, false);
  assert.match(artifact.agentBody?.reason ?? "", /reconstruction/);
});

test("a body read failure is recorded once and every body gate is INFO", () => {
  const failed: RunBody = {
    measured: false,
    agentId: "agent_missing",
    fingerprint: "fp_missing",
    reason: "stored agent agent_missing read failed 404: not found",
  };
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: failed,
    measuredLevel: measuredLevel(-23.1, -23.1),
  });
  for (const name of ["end-of-turn", "timbre-probes"]) {
    const gate = artifact.gates.find((row) => row.name === name);
    assert.equal(gate?.status, "INFO", `${name} must be INFO after a read failure`);
    assert.match(gate?.detail ?? "", /agent_missing read failed 404/);
  }
  assert.equal(artifact.agentBody?.measured, false);
  assert.equal(artifact.agentBody?.agentId, "agent_missing");
  assert.equal(artifact.agentBody?.reason, failed.reason);
  assert.equal(artifact.loudness.ok, false);
  assert.equal("body" in artifact.loudness, false, "one identity record per run");
});

test("artifact with measured gaps fills per-beat gaps and enforces the reply-gap gate", () => {
  const passing = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 2,
    gaps: { "greeting-cut": [800, 900], "real-cut-answered": [1100, 1200] },
    traceSessionId: "sess_abc",
  });
  assert.deepEqual(passing.beats["greeting-cut"].gapSamples, [800, 900]);
  assert.equal(passing.beats["greeting-cut"].gapMs, 800);
  assert.equal(passing.replyGap.p50Ms, 900);
  assert.equal(passing.replyGap.p95Ms, 1200);
  const passingGate = passing.gates.find((g) => g.name === "reply-gap");
  assert.equal(passingGate?.status, "PASS");

  const failing = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 2,
    gaps: { "greeting-cut": [2600, 2700] },
    traceSessionId: "sess_abc",
  });
  assert.equal(failing.gates.find((g) => g.name === "reply-gap")?.status, "FAIL");
  assert.ok(
    (failing.gates.find((g) => g.name === "reply-gap")?.detail ?? "").includes("sess_abc"),
    "failing gate points at the call trace session",
  );
});

// ── Ticket 04: filler-ignored + resume-tail gate ─────────────────────────────

test("overlap judge ignores filler, back-channels and agent echo but yields commands", () => {
  for (const filler of ["mm-hmm", "yeah", "Okaay so"]) {
    assert.equal(judgeOverlap(filler, "We help dental clinics answer every call", EN_RECOGNITION), "ignore", `${filler} must never steal the floor`);
  }
  assert.equal(
    judgeOverlap("help dental clinics", "We help dental clinics answer every call", EN_RECOGNITION),
    "ignore",
    "agent echo must never steal the floor",
  );
  assert.equal(judgeOverlap("Wait, stop.", "We help dental clinics answer every call", EN_RECOGNITION), "yield", "steering always yields");
  assert.equal(judgeOverlap("I want you to hang up.", "Thanks for calling", EN_RECOGNITION), "yield", "end-call always yields");
});

test("the runner's filler-over line is parsed into a passing never-cut gate", () => {
  // The live runner prints one observed line per filler-over run; the
  // scoreboard consumes it instead of waiting for a human to retype flags.
  const observation = parseFillerRunOutput(
    '    filler never cut; events [["ignore","Okaay so"]]; answer continued\nfiller-over: 1/1\n',
  );
  assert.ok(observation, "the never-cut line parses");
  assert.equal(observation.visitorText, "Okaay so");
  assert.equal(observation.verdict, "ignore");
  assert.equal(observation.cut, false);
  assert.equal(observation.cutMs, null);
  assert.equal(observation.resumed, false);
  assert.equal(observation.answerContinued, true);

  const evidence = fillerEvidenceFromRun(observation);
  assert.ok(evidence, "never-cut evidence is scoreable");
  const gate = evaluateFillerResumeGate({ ...evidence, traceTurn: "call trace turn 2 (sess_abc)" });
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /never cut/);
  assert.match(gate.detail, /call trace turn 2 \(sess_abc\)/);
});

test("a cut that resumed is not blessed on a boolean: exact-tail scoring is ticket 13", () => {
  const observation = parseFillerRunOutput(
    '    filler cut at 318ms; events [["ignore","mm-hmm"]]; answer resumed\nfiller-over: 1/1\n',
  );
  assert.ok(observation);
  assert.equal(observation.cut, true);
  assert.equal(observation.cutMs, 318);
  assert.equal(observation.resumed, true);
  assert.equal(observation.answerContinued, true);
  assert.equal(fillerEvidenceFromRun(observation), null);
});

test("a filler that stole the turn fails and cites the merged Call trace turn", () => {
  const observation = parseFillerRunOutput(
    '    filler cut at 318ms; events [["yield","Okaay so"]]; answer derailed\nfiller-over: 0/1\n',
  );
  assert.ok(observation);
  const evidence = fillerEvidenceFromRun(observation);
  assert.ok(evidence, "a cut that did not resume is scoreable now");
  const gate = evaluateFillerResumeGate({ ...evidence, traceTurn: "call trace turn 3 (sess_abc)" });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /floor stolen/);
  assert.match(gate.detail, /call trace turn 3 \(sess_abc\)/);
});

test("a never-cut run that dropped the answer fails instead of passing on silence", () => {
  const observation = parseFillerRunOutput(
    '    filler never cut; events [["ignore","Okaay so"]]; answer dropped\n',
  );
  assert.ok(observation);
  const evidence = fillerEvidenceFromRun(observation);
  assert.ok(evidence);
  const gate = evaluateFillerResumeGate({ ...evidence, traceTurn: "call trace turn 2 (sess_abc)" });
  assert.equal(gate.status, "FAIL", gate.detail);
  assert.match(gate.detail, /answer dropped/);
  assert.match(gate.detail, /call trace turn 2 \(sess_abc\)/);
});

test("a cut with no measured ms is never scored as a never-cut pass", () => {
  const resumedWithoutMs = parseFillerRunOutput(
    '    filler cut; events [["ignore","Okaay so"]]; answer resumed',
  );
  assert.ok(resumedWithoutMs);
  assert.equal(resumedWithoutMs.cut, true);
  assert.equal(resumedWithoutMs.cutMs, null);
  assert.equal(fillerEvidenceFromRun(resumedWithoutMs), null, "an unmeasured cut stays unmeasured");

  const derailedWithoutMs = parseFillerRunOutput(
    '    filler cut; events [["ignore","Okaay so"]]; answer derailed',
  );
  assert.ok(derailedWithoutMs);
  assert.equal(fillerEvidenceFromRun(derailedWithoutMs)?.cutMs, null);
  const gate = evaluateFillerResumeGate(fillerEvidenceFromRun(derailedWithoutMs)!);
  assert.equal(gate.status, "FAIL", "a cut that dropped the answer is still a failure");
});

test("a missing or malformed filler line stays unmeasured, never an assumed verdict", () => {
  assert.equal(parseFillerRunOutput("filler-over: 1/1\n"), null);
  assert.equal(parseFillerRunOutput('    filler never cut; events not-json; answer continued'), null);
  assert.equal(parseFillerRunOutput('    filler never cut; events []; answer continued'), null);
  assert.equal(parseFillerRunOutput('    filler never cut; events [["maybe","Okaay so"]]; answer continued'), null);
  // A cut without a measured ms is not a never-cut pass.
  const unmeasured = parseFillerRunOutput('    filler cut; events [["yield","Okaay so"]]; answer derailed');
  assert.ok(unmeasured);
  assert.equal(unmeasured.cutMs, null);
  const gate = evaluateFillerResumeGate(fillerEvidenceFromRun(unmeasured)!);
  assert.equal(gate.status, "FAIL", "a bare cut stays on the yield/derail path, never a PASS");
});

test("the runner's cut line carries the agent line, heard words and resumed tail verbatim", () => {
  // The live runner prints what it observed: the cut line, the words that had
  // played before the server cut, and the words it said as the resume. The
  // scoreboard compares the resume with `unheardRest` itself, never a boolean.
  const observation = parseFillerRunOutput(
    '    filler cut at 318ms; events [["ignore","Okaay so"]]; handling resumed-from; ' +
      'tail {"agent":"We help dental clinics answer every call","heard":"We help dental","resumed":"dental clinics answer every call","resumeMs":412}\n' +
      "filler-over: 1/1\n",
  );
  assert.ok(observation, "the cut line with tail evidence parses");
  assert.equal(observation.cut, true);
  assert.equal(observation.cutMs, 318);
  assert.equal(observation.resumed, true);
  assert.equal(observation.handling, "resumed-from");
  assert.deepEqual(observation.tail, {
    agentText: "We help dental clinics answer every call",
    heardText: "We help dental",
    resumedText: "dental clinics answer every call",
    resumeMs: 412,
  });
  assert.equal(observation.answerContinued, true);

  const evidence = fillerEvidenceFromRun(observation);
  assert.ok(evidence, "a measured tail is scoreable");
  assert.equal(evidence.agentText, "We help dental clinics answer every call");
  assert.equal(evidence.heardText, "We help dental");
  assert.equal(evidence.resumedText, "dental clinics answer every call");
  assert.equal(evidence.resumeMs, 412);
  assert.equal(evidence.handling, "resumed-from", "the filler verdict is resume-from, never answered");

  const gate = evaluateFillerResumeGate({ ...evidence, traceTurn: "call trace turn 2 (sess_abc)" });
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /resumed the exact tail/);
  assert.match(gate.detail, /handling: resumed-from/);
  assert.match(gate.detail, /call trace turn 2 \(sess_abc\)/);
});

test("a paraphrased filler resume fails and cites the Call trace turn that said it", () => {
  const observation = parseFillerRunOutput(
    '    filler cut at 300ms; events [["ignore","Okaay so"]]; handling resumed-from; ' +
      'tail {"agent":"We help dental clinics answer every call","heard":"We help dental","resumed":"clinics answer calls","resumeMs":900}',
  );
  assert.ok(observation);
  const evidence = fillerEvidenceFromRun(observation);
  assert.ok(evidence);
  const gate = evaluateFillerResumeGate({ ...evidence, traceTurn: "call trace turn 2 (sess_abc)" });
  assert.equal(gate.status, "FAIL", "a paraphrase is not the unheard tail");
  assert.match(gate.detail, /resume tail inexact/);
  assert.match(gate.detail, /call trace turn 2 \(sess_abc\)/);
});

test("a cut that dropped the tail fails instead of passing on a resume create", () => {
  const observation = parseFillerRunOutput(
    '    filler cut at 300ms; events [["ignore","Okaay so"]]; handling lost; ' +
      'tail {"agent":"We help dental clinics answer every call","heard":"We help dental","resumed":"","resumeMs":null}',
  );
  assert.ok(observation);
  const evidence = fillerEvidenceFromRun(observation);
  assert.ok(evidence);
  assert.equal(evidence.handling, "lost");
  const gate = evaluateFillerResumeGate({ ...evidence, traceTurn: "call trace turn 1 (sess_abc)" });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /never resumed/);
  assert.match(gate.detail, /call trace turn 1 \(sess_abc\)/);
});

test("a cut after the last word has nothing left unheard and passes", () => {
  // Live filler-over (sess_a1ef25b2f84d426d8567f253c9a13dc7): the cut landed
  // at the end of the reply, so every word had played and no resume followed.
  // That is correct behavior, not a dropped tail. The runner reported the
  // answer as a fresh turn because no resume create was needed.
  const observation = parseFillerRunOutput(
    '    filler cut at 2213ms; events [["ignore","Okay, so"]]; handling answered; ' +
      'tail {"agent":"I can answer that after we do the test. Ready to see how",' +
      '"heard":"I can answer that after we do the test. Ready to see how","resumed":"","resumeMs":null}',
  );
  assert.ok(observation, "the live line parses");
  assert.equal(observation.cut, true);
  const evidence = fillerEvidenceFromRun(observation);
  assert.ok(evidence);
  const gate = evaluateFillerResumeGate({ ...evidence, traceTurn: "call trace turn 2 (sess_live)" });
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /nothing left unheard/);
  assert.match(gate.detail, /call trace turn 2 \(sess_live\)/);

  // An explicitly empty unheard rest (agent line just finished) is the same.
  const empty = evaluateFillerResumeGate({
    visitorText: "Okaay so",
    agentText: "Ready to see how.",
    verdict: "ignore",
    cutMs: 900,
    resumeMs: null,
    resumedText: "",
    heardText: "Ready to see how. extra",
    answeredOver: false,
    traceTurn: "call trace turn 2 (sess_live2)",
  });
  assert.equal(empty.status, "PASS", empty.detail);
});

test("a cut with a non-empty tail that was dropped or paraphrased still fails", () => {
  const dropped = evaluateFillerResumeGate({
    visitorText: "Okaay so",
    agentText: "We help dental clinics answer every call",
    verdict: "ignore",
    cutMs: 300,
    resumeMs: null,
    resumedText: "",
    heardText: "We help dental",
    answeredOver: false,
    handling: "lost",
    traceTurn: "call trace turn 2 (sess_tail)",
  });
  assert.equal(dropped.status, "FAIL", dropped.detail);
  assert.match(dropped.detail, /never resumed/);

  const paraphrased = evaluateFillerResumeGate({
    visitorText: "Okaay so",
    agentText: "We help dental clinics answer every call",
    verdict: "ignore",
    cutMs: 300,
    resumeMs: 800,
    resumedText: "clinics answer calls",
    heardText: "We help dental",
    answeredOver: false,
    traceTurn: "call trace turn 2 (sess_tail)",
  });
  assert.equal(paraphrased.status, "FAIL", paraphrased.detail);
  assert.match(paraphrased.detail, /resume tail inexact/);
});

test("a filler run with no overlap still scores the floor held from the said text", () => {
  const observation = parseFillerRunOutput(
    '    filler never cut; events []; handling heard-only; said "Okaay so"',
  );
  assert.ok(observation, "the no-overlap observation parses");
  assert.equal(observation.visitorText, "Okaay so");
  assert.equal(observation.cut, false);
  const gate = evaluateFillerResumeGate(fillerEvidenceFromRun(observation)!);
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /floor held, never cut/);

  const ended = parseFillerRunOutput(
    '    filler never cut; events []; handling lost; said "Okaay so"',
  );
  assert.ok(ended);
  const lostGate = evaluateFillerResumeGate(fillerEvidenceFromRun(ended)!);
  assert.equal(lostGate.status, "FAIL", "the answer ended before the filler landed");
  assert.match(lostGate.detail, /answer dropped/);
});

test("live cut lines with fractional milliseconds still parse", () => {
  // The runner measured a float (Date.now minus a fractional clip onset), so
  // the suite's number arrived as `1176.0988ms` before the print was rounded.
  const greeting = extractGreetingCutEvidence(
    "greeting cut 1176.0988000001ms after the caller started (budget 1500ms)\ngreeting-cut: 1/1",
  );
  assert.equal(greeting?.cutMs, 1176.0988000001);
  const realCut = extractRealCutEvidence(
    "cut 1171.42ms after the caller started (budget 1500ms)\nanswered the point after the cut: \"price\"\nstop-over: 1/1",
  );
  assert.equal(realCut?.cutMs, 1171.42);
  const filler = parseFillerRunOutput(
    '    filler cut at 2213.77ms; events [["ignore","Okay, so"]]; handling answered',
  );
  assert.equal(filler?.cutMs, 2213.77);
});

test("a filler answered instead of resumed-from fails even when the words match", () => {
  const gate = evaluateFillerResumeGate({
    visitorText: "Okaay so",
    agentText: "We help dental clinics answer every call",
    verdict: "ignore",
    cutMs: 300,
    resumeMs: 400,
    resumedText: "dental clinics answer every call",
    heardText: "We help dental",
    answeredOver: false,
    handling: "answered",
    traceTurn: "call trace turn 2 (sess_abc)",
  });
  assert.equal(gate.status, "FAIL", "a filler verdict must resume-from, never answer");
  assert.match(gate.detail, /answered instead of resumed-from/);
  assert.match(gate.detail, /call trace turn 2 \(sess_abc\)/);
});

test("filler that never cuts passes with the floor held", () => {
  for (const filler of ["mm-hmm", "yeah", "Okaay so"]) {
    const gate = evaluateFillerResumeGate({
      visitorText: filler,
      agentText: "We help dental clinics answer every call",
      verdict: "ignore",
      cutMs: null,
      resumeMs: null,
      resumedText: "",
      heardText: "",
      answeredOver: false,
      traceTurn: "sess_abc#turn 2",
    });
    assert.equal(gate.name, "filler-resume");
    assert.equal(gate.status, "PASS", `${filler}: ${gate.detail}`);
  }
});

test("a brief filler cut resumes the exact unheard tail within 2500ms", () => {
  const line = "We help dental clinics answer every call";
  const gate = evaluateFillerResumeGate({
    visitorText: "Okaay so",
    agentText: line,
    verdict: "ignore",
    cutMs: 320,
    resumeMs: 1200,
    resumedText: "dental clinics answer every call",
    heardText: "We help dental",
    answeredOver: false,
    traceTurn: "sess_abc#turn 2",
  });
  assert.equal(gate.status, "PASS", gate.detail);

  const boundary = evaluateFillerResumeGate({
    visitorText: "mm-hmm",
    agentText: line,
    verdict: "keep",
    cutMs: 200,
    resumeMs: 2500,
    resumedText: "dental clinics answer every call",
    heardText: "We help dental",
    answeredOver: false,
  });
  assert.equal(boundary.status, "PASS", `2500ms is inside the budget: ${boundary.detail}`);
});

test("filler failures report cut ms, the judge verdict and the Call trace turn", () => {
  const line = "We help dental clinics answer every call";
  const base = {
    agentText: line,
    heardText: "We help dental",
    resumedText: "dental clinics answer every call",
    traceTurn: "sess_abc#turn 2",
  };
  const cases: { label: string; evidence: Parameters<typeof evaluateFillerResumeGate>[0] }[] = [
    {
      label: "floor stolen",
      evidence: { ...base, visitorText: "Okaay so", verdict: "yield", cutMs: 320, resumeMs: null, resumedText: "", answeredOver: false },
    },
    {
      label: "cut never resumed",
      evidence: { ...base, visitorText: "yeah", verdict: "ignore", cutMs: 410, resumeMs: null, resumedText: "", answeredOver: false },
    },
    {
      label: "resume too slow",
      evidence: { ...base, visitorText: "mm-hmm", verdict: "ignore", cutMs: 300, resumeMs: 2501, answeredOver: false },
    },
    {
      label: "resume tail inexact",
      evidence: { ...base, visitorText: "Okaay so", verdict: "ignore", cutMs: 300, resumeMs: 900, resumedText: "something new about pricing", answeredOver: false },
    },
    {
      label: "answered over the resumption",
      evidence: { ...base, visitorText: "yeah", verdict: "ignore", cutMs: 300, resumeMs: 900, answeredOver: true },
    },
    {
      label: "ambiguous overlap fails closed",
      evidence: { ...base, visitorText: "price?", verdict: "judge", cutMs: 500, resumeMs: null, resumedText: "", answeredOver: false },
    },
  ];
  for (const { label, evidence } of cases) {
    const gate = evaluateFillerResumeGate(evidence);
    assert.equal(gate.status, "FAIL", `${label} must fail`);
    assert.match(gate.detail, /cut: (never cut|\d+ms)/, `${label} reports cut ms`);
    assert.match(gate.detail, new RegExp(`verdict:? ${evidence.verdict}`), `${label} reports the judge verdict`);
    assert.ok(gate.detail.includes("sess_abc#turn 2"), `${label} points at the Call trace turn`);
  }
});

test("real steering is not filler: the gate fails instead of blessing a yield", () => {
  const gate = evaluateFillerResumeGate({
    visitorText: "Wait, stop.",
    agentText: "We help dental clinics answer every call",
    verdict: "ignore",
    cutMs: null,
    resumeMs: null,
    resumedText: "",
    heardText: "",
    answeredOver: false,
    traceTurn: "sess_abc#turn 3",
  });
  assert.equal(gate.status, "FAIL", gate.detail);
});

test("artifact carries the filler-resume gate and timing; console table names it", () => {
  const line = "We help dental clinics answer every call";
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "filler-over",
    runnerStdout: "filler never cut",
    exitCode: 0,
    durationMs: 4000,
    runs: 1,
    fillerResume: {
      visitorText: "Okaay so",
      agentText: line,
      verdict: "ignore",
      cutMs: 320,
      resumeMs: 1200,
      resumedText: "dental clinics answer every call",
      heardText: "We help dental",
      answeredOver: false,
      traceTurn: "sess_abc#turn 2",
    },
  });
  const gate = artifact.gates.find((g) => g.name === "filler-resume");
  assert.ok(gate, "artifact carries the filler-resume gate");
  assert.equal(gate.status, "PASS");
  assert.equal(artifact.beats["filler-ignored"].cutMs, 320);
  assert.equal(artifact.beats["filler-ignored"].resumeMs, 1200);
  assert.equal(artifact.beats["filler-ignored"].status, "PASS");
  assert.ok(formatGateTable(artifact).includes("filler-resume"));

  const failing = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "filler-over",
    runnerStdout: "cut and not resumed",
    exitCode: 0,
    durationMs: 4000,
    runs: 1,
    fillerResume: {
      visitorText: "Okaay so",
      agentText: line,
      verdict: "yield",
      cutMs: 320,
      resumeMs: null,
      resumedText: "",
      heardText: "We help dental",
      answeredOver: false,
      traceTurn: "sess_abc#turn 2",
    },
  });
  assert.equal(failing.gates.find((g) => g.name === "filler-resume")?.status, "FAIL");
  assert.equal(failing.beats["filler-ignored"].status, "FAIL");
});

// --- Ticket 05: real-cut answered gate (spec story 4) ---

test("real-cut bar matches the stop-over contract: cut within 1500ms", () => {
  assert.equal(REAL_CUT_MAX_MS, 1500);
});

test("real steering, command, and end-call speech is expected to yield; filler never is", () => {
  // Steering, command, and end-call requests always yield (shared overlap judge).
  assert.equal(isRealCutExpected("Wait, stop."), true);
  assert.equal(isRealCutExpected("Hold on, repeat that."), true);
  assert.equal(isRealCutExpected("I want you to hang up."), true);
  // A real multi-word point over the answer yields too.
  assert.equal(isRealCutExpected("tell me the price please"), true);
  // Filler never steals the floor.
  assert.equal(isRealCutExpected("mm-hmm"), false);
  assert.equal(isRealCutExpected("Okaay so"), false);
});

const ANSWERED_FAST = {
  cutMs: 900,
  verdict: "yield",
  verdictSource: "jev",
  answered: true,
  resumed: false,
  ended: false,
  traceTurn: "input.speech.started → reply.interrupted → transcript.user: tell me the price",
};

test("real cut answered fast passes and names the cut latency", () => {
  const gate = evaluateRealCut(ANSWERED_FAST);
  assert.equal(gate.name, "barge-in-cut");
  assert.equal(gate.status, "PASS");
  assert.ok(gate.detail.includes("900ms"), `detail should name cut ms: ${gate.detail}`);
});

test("late cut fails and reports cut ms plus judge verdict with the Call trace turn", () => {
  const gate = evaluateRealCut({ ...ANSWERED_FAST, cutMs: 1601 });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("1601ms"), `detail should name cut ms: ${gate.detail}`);
  assert.ok(gate.detail.includes("yield"), `detail should name the verdict: ${gate.detail}`);
  assert.ok(
    gate.detail.includes("tell me the price"),
    `detail should carry the trace turn: ${gate.detail}`,
  );
});

test("a cut that never lands fails as never cut", () => {
  const gate = evaluateRealCut({ ...ANSWERED_FAST, cutMs: null });
  assert.equal(gate.status, "FAIL");
  assert.ok(/never cut/i.test(gate.detail), `detail should say never cut: ${gate.detail}`);
});

test("a yielded cut resumed with old material fails", () => {
  const gate = evaluateRealCut({ ...ANSWERED_FAST, resumed: true });
  assert.equal(gate.status, "FAIL");
  assert.ok(/resum/i.test(gate.detail), `detail should name the resume: ${gate.detail}`);
});

test("a yielded cut left unanswered fails", () => {
  const gate = evaluateRealCut({ ...ANSWERED_FAST, answered: false });
  assert.equal(gate.status, "FAIL");
  assert.ok(/answer/i.test(gate.detail), `detail should name the missing answer: ${gate.detail}`);
});

test("every real-cut failure reports cut ms plus verdict with the trace turn", () => {
  const failures = [
    { ...ANSWERED_FAST, cutMs: 2000 },
    { ...ANSWERED_FAST, cutMs: null, verdict: "judge" },
    { ...ANSWERED_FAST, resumed: true },
    { ...ANSWERED_FAST, answered: false, verdict: "keep" },
  ];
  for (const evidence of failures) {
    const gate = evaluateRealCut(evidence);
    assert.equal(gate.status, "FAIL");
    assert.ok(
      gate.detail.includes(evidence.cutMs === null ? "never cut" : `${evidence.cutMs}ms`),
      `detail should report cut ms: ${gate.detail}`,
    );
    assert.ok(
      gate.detail.includes(evidence.verdict ?? "unreported"),
      `detail should report the verdict: ${gate.detail}`,
    );
    assert.ok(
      gate.detail.includes(evidence.traceTurn ?? "no Call trace turn merged"),
      `detail should report the trace turn: ${gate.detail}`,
    );
  }
});

test("a late cut with no merged Call trace says no turn merged, never a guessed turn", () => {
  const gate = evaluateRealCut({ ...ANSWERED_FAST, cutMs: 1841, traceTurn: null });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /1841ms/);
  assert.match(gate.detail, /no Call trace turn merged/);
  assert.doesNotMatch(gate.detail, /call trace turn \d/i);
});

test("a real cut measured on a changed caller clip is not comparable and fails", () => {
  const drift = "audio duration differs: 1200ms → 700ms";
  const gate = evaluateRealCut(ANSWERED_FAST, drift);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /caller clip/);
  assert.match(gate.detail, /1200ms → 700ms/);
  assert.match(gate.detail, /not comparable/);
  assert.match(gate.detail, /tell me the price/);
  assert.equal(evaluateRealCut(ANSWERED_FAST, null).status, "PASS");
});

test("applying real-cut evidence updates the beat and replaces the skeleton gate", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  const gated = applyRealCutGate(artifact, { ...ANSWERED_FAST, cutMs: 2100 });
  assert.equal(gated.beats["real-cut-answered"].cutMs, 2100);
  assert.equal(gated.beats["real-cut-answered"].status, "FAIL");
  const gate = gated.gates.find((g) => g.name === "barge-in-cut")!;
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("2100ms"));
  const table = formatGateTable(gated);
  assert.ok(table.includes("FAIL"));
  assert.ok(table.includes("2100ms"));
});

test("real-cut evidence parses from the eval runner's stop-over output", () => {
  const passed = extractRealCutEvidence(
    [
      '    cut 912ms after the caller started',
      '    answered the point after the cut: "Pricing depends on call volume."',
      "stop-over: 1/1",
    ].join("\n"),
  );
  assert.deepEqual(passed, {
    cutMs: 912,
    verdict: null,
    verdictSource: null,
    answered: true,
    resumed: false,
    ended: false,
    traceTurn: null,
  });
  const late = extractRealCutEvidence('    cut 1601ms after the caller started\n  ✗ stop-over #1: cut too late: 1601ms\nstop-over: 0/1\n');
  assert.equal(late?.cutMs, 1601);
  assert.equal(late?.answered, false);
  const never = extractRealCutEvidence('  ✗ stop-over #1: never cut (events: ["judge"])\nstop-over: 0/1\n');
  assert.equal(never?.cutMs, null);
  assert.equal(never?.verdict, "judge");
  const resumed = extractRealCutEvidence('  ✗ hang-up-over #1: resumed instead of ending\nhang-up-over: 0/1\n');
  assert.equal(resumed?.resumed, true);
  assert.equal(resumed?.answered, false);
  const ended = extractRealCutEvidence('    hung up 800ms after the goodbye finished playing\nhang-up-over: 1/1\n');
  assert.deepEqual(ended, {
    cutMs: null,
    verdict: null,
    verdictSource: null,
    answered: true,
    resumed: false,
    ended: true,
    traceTurn: null,
  });
  assert.equal(evaluateRealCut(ended!)?.status, "PASS");
  assert.equal(extractRealCutEvidence("greeting-cut: 1/1\n"), null);
});

test("a stop-over that resumed the abandoned tail fails and cites the answer turn", () => {
  const excerpt = [
    '12.20s  VONI    "We answer every call and triage the urgent ones"  (reply_create gap 900ms)  CUT at 12.90s',
    '13.20s  HEARD   "Wait, stop. What is the price?"  (12.90s-13.90s)',
    '14.30s  VONI    "and triage the urgent ones"  (reply_create [Finish your sentence, word for word])',
  ];
  const resume = 'Finish your sentence: say exactly this and nothing else, word for word: "and triage the urgent ones"';
  const evidence = extractRealCutEvidence(
    [
      '    cut 980ms after the caller started (budget 1500ms)',
      `    resumed instead of answering: "${resume}"`,
      `  ✗ stop-over #1: resumed instead of answering: "${resume}"`,
      "stop-over: 0/1",
    ].join("\n"),
    excerpt,
  );
  assert.equal(evidence?.resumed, true);
  assert.equal(evidence?.answered, false);
  assert.equal(evidence?.traceTurn, "call trace turn 2", "the resume turn, not the cut turn");
  const gate = evaluateRealCut(evidence!);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /call trace turn 2/, gate.detail);
  assert.match(gate.detail, /resum/i, gate.detail);
  assert.doesNotMatch(gate.detail, /call trace turn 1\b/, gate.detail);
});

test("a fast cut alone never proves the point was answered", () => {
  const cutOnly = extractRealCutEvidence('    cut 912ms after the caller started\nstop-over: 1/1\n');
  assert.equal(cutOnly?.answered, false, "a cut ms alone is not answer evidence");
  const gate = evaluateRealCut(cutOnly!);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /point was never answered/);

  const answered = extractRealCutEvidence(
    [
      '    cut 912ms after the caller started',
      '    answered the point after the cut: "Pricing depends on call volume."',
      "stop-over: 1/1",
    ].join("\n"),
  );
  assert.equal(answered?.answered, true);
  assert.equal(answered?.resumed, false);
  assert.equal(evaluateRealCut(answered!).status, "PASS");
});

test("post-cut answer evidence: a fresh answer after the heard point, never a resume", () => {
  const point = "price";
  assert.deepEqual(
    judgePostCutAnswer({
      point,
      heard: ["Wait, stop. What's the price?"],
      answer: "Pricing depends on call volume.",
      creates: [],
    }),
    {
      answered: true,
      answer: "Pricing depends on call volume.",
      resumed: null,
      pointHeard: true,
      reason: null,
    },
  );
  // Structural proof only: the point reached the session and a fresh reply
  // followed. Whether the words answer it stays reviewable in the transcript.
  assert.deepEqual(
    judgePostCutAnswer({ point, heard: ["Wait, stop."], answer: "Sure, what is it?", creates: [] }),
    {
      answered: false,
      answer: "Sure, what is it?",
      resumed: null,
      pointHeard: false,
      reason: "the caller's point was never heard",
    },
  );
  assert.equal(
    judgePostCutAnswer({ point, heard: ["What's the price?"], answer: null, creates: [] }).reason,
    "no agent answer after the cut",
  );
  const tail = 'Finish your sentence: say exactly this and nothing else, word for word: "and triage the urgent ones"';
  const resumed = judgePostCutAnswer({
    point,
    heard: ["What's the price?"],
    answer: "and triage the urgent ones",
    creates: [tail],
  });
  assert.equal(resumed.answered, false);
  assert.equal(resumed.resumed, tail);
  assert.match(resumed.reason ?? "", /resumed the abandoned tail/);
});

test("the post-cut answer is the fresh turn after the point, never the abandoned tail", () => {
  const agentTurns = [
    { replyId: "r1", text: "We answer every call and triage the urgent ones", at: 1050 },
    { replyId: "r2", text: "Sure, what would you like?", at: 1300 },
    { replyId: "r3", text: "Pricing depends on call volume.", at: 1800 },
  ];
  const heardTurns = [
    { text: "Wait, stop.", at: 1100 },
    { text: "What is the price?", at: 1500 },
  ];
  // The ack that landed before the point is not the answer to the point.
  assert.equal(
    postCutAnswerText({ cutAt: 1000, cutReplyId: "r1", point: "price", heardTurns, agentTurns }),
    "Pricing depends on call volume.",
  );
  // Without a cut there is no post-cut answer to point at.
  assert.equal(
    postCutAnswerText({ cutAt: null, cutReplyId: null, point: "price", heardTurns, agentTurns }),
    null,
  );
});

test("resume instructions are recognized by what the session actually sends", () => {
  assert.equal(
    isResumeInstructions('Finish your sentence: say exactly this and nothing else, word for word: "answer every call"'),
    true,
  );
  assert.equal(isResumeInstructions("Pick up where you left off"), true);
  assert.equal(isResumeInstructions("The price depends on call volume."), false);
});

test("real-cut evidence derives the Call trace turn from the merged excerpt", () => {
  const excerpt = [
    '12.10s  HEARD   "Tell me about the price."  (10.20s-11.30s)',
    '12.20s  VONI    "Sure, first the tour"  (reply_create gap 900ms)  CUT at 12.90s',
    '15.00s  VONI    "The price is"  (reply_create gap 800ms)',
  ];
  const pointers = traceTurnPointers(excerpt);
  assert.deepEqual(pointers, { cutTurn: 1, answerTurn: 2, goodbyeTurn: null, narrationTurn: null });
  assert.equal(formatTraceTurn(1, "sess_abc"), "call trace turn 1 (sess_abc)");

  const late = extractRealCutEvidence(
    '    cut 1601ms after the caller started\n  ✗ stop-over #1: cut too late: 1601ms\nstop-over: 0/1\n',
    excerpt,
  );
  // The cut turn is followed by the answer turn; the evidence points at the
  // answer turn, where a resume would be visible.
  assert.equal(late?.traceTurn, "call trace turn 2");
  const gate = evaluateRealCut(late!);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /call trace turn 2/, `detail should name the answer turn: ${gate.detail}`);
  // Without a merged excerpt there is no turn to cite; absent evidence stays absent.
  assert.equal(
    extractRealCutEvidence('    cut 1601ms after the caller started\nstop-over: 0/1\n')?.traceTurn,
    null,
  );
});

test("double-talk and end-call drain failures point at their Call trace turn", () => {
  const excerpt = [
    '12.10s  HEARD   "Tell me about the price."  (10.20s-11.30s)',
    '12.20s  VONI    "Sure, first the tour"  (reply_create gap 900ms)  CUT at 12.90s',
    '15.00s  HEARD   "I want you to hang up."  (14.00s-14.50s)',
    '15.10s  TOOL    end_call {"reason":"caller asked"} 300ms',
    '16.00s  VONI    "Thanks for calling"  (reply_create gap 700ms)',
  ];
  assert.deepEqual(traceTurnPointers(excerpt), { cutTurn: 1, answerTurn: 2, goodbyeTurn: 2, narrationTurn: null });
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "hang-up-over",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceExcerpt: excerpt,
    traceSessionId: "sess_abc",
    doubleTalkOverlapMs: [650],
    endCallDrain: { goodbyeCoverage: 0.5, hangUpDelayMs: 4200, narratedEnding: false },
  });
  const byName = Object.fromEntries(artifact.gates.map((gate) => [gate.name, gate]));
  assert.equal(byName["double-talk"].status, "FAIL");
  assert.match(byName["double-talk"].detail, /call trace turn 1 \(sess_abc\)/);
  assert.equal(byName["end-call-drain"].status, "FAIL");
  assert.match(byName["end-call-drain"].detail, /call trace turn 2 \(sess_abc\)/);
});

test("a narrated ending in the merged trace fails at the post-End call turn", () => {
  // The goodbye is the reply after end_call; anything VONI says after that
  // reply is the ending being narrated. The FAIL must cite that post-End
  // turn, never the goodbye's.
  const excerpt = [
    '12.20s  VONI    "Sure, first the tour"  (reply_create gap 900ms)',
    '15.10s  TOOL    end_call {"reason":"caller asked"} 300ms',
    '16.00s  VONI    "Thanks for calling, the team is at hi at voni dot c c"  (reply_create gap 700ms)',
    '17.20s  VONI    "The call has ended. Have a nice day."  (reply_create gap 600ms)',
  ];
  assert.equal(traceTurnPointers(excerpt).goodbyeTurn, 2);
  assert.equal(traceTurnPointers(excerpt).narrationTurn, 3);
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "bye-audio",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceExcerpt: excerpt,
    traceSessionId: "sess_abc",
    endCallDrain: { goodbyeCoverage: 0.97, hangUpDelayMs: 700, narratedEnding: false, inboxNamed: true },
  });
  assert.equal(artifact.endCallDrain.narratedEnding, true, "the trace proves the narration");
  const gate = artifact.gates.find((candidate) => candidate.name === "end-call-drain")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /narrat/i);
  assert.match(gate.detail, /call trace turn 3 \(sess_abc\)/, `cites the post-End turn: ${gate.detail}`);
  assert.doesNotMatch(gate.detail, /call trace turn 2 \(sess_abc\)/, "never cites the goodbye turn");
});

test("a narrated ending with no merged turn states that explicitly", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "bye-audio",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceSessionId: "sess_solo",
    endCallDrain: { goodbyeCoverage: 0.97, hangUpDelayMs: 700, narratedEnding: true, inboxNamed: true },
  });
  const gate = artifact.gates.find((candidate) => candidate.name === "end-call-drain")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /no turn merged \(sess_solo\)/, `explicit no-turn: ${gate.detail}`);
});

test("filler trace turn derives from the HEARD row the visitor's words matched", () => {
  const excerpt = [
    '12.10s  HEARD   "Tell me about the price."  (10.20s-11.30s)',
    '12.20s  VONI    "Sure, first the tour"  (reply_create gap 900ms)',
    '15.00s  HEARD   "Okaay so"  (14.90s-15.10s)',
    '16.00s  VONI    "The price is"  (reply_create gap 800ms)',
  ];
  assert.equal(traceTurnForVisitorSpeech(excerpt, "Okaay so"), 1);
  assert.equal(traceTurnForVisitorSpeech(excerpt, "okaay SO"), 1);
  assert.equal(traceTurnForVisitorSpeech(excerpt, "never said"), null);
  assert.equal(
    traceTurnForVisitorSpeech(['1.00s  HEARD   "Okaay so"  (0.90s-1.10s)'], "Okaay so"),
    null,
    "no VONI reply under way yet",
  );
});

test("a reply-gap failure from an attributed trace turn names that turn", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceGaps: [{ gapMs: 2600, turnIndex: 1 }],
    traceExcerpt: ['12.20s  VONI    "Hi"  (reply_create gap 2600ms)  greeting-cut marker'],
    traceSessionId: "sess_abc",
  });
  const reply = artifact.gates.find((gate) => gate.name === "reply-gap")!;
  assert.equal(reply.status, "FAIL");
  assert.match(reply.detail, /call trace turn 1 \(sess_abc\)/, `detail should cite the turn: ${reply.detail}`);
});

test("artifact diff reports gate transitions, beat deltas, reply gap and drain changes", () => {
  const base = {
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
  };
  const prevBase = buildSkeletonArtifact(base);
  const nextBase = buildSkeletonArtifact(base);
  const prev = {
    ...prevBase,
    runId: "run-prev",
    gates: prevBase.gates.map((gate) =>
      gate.name === "reply-gap" ? { ...gate, status: "PASS" as const, detail: "prev" } : gate,
    ),
    beats: {
      ...prevBase.beats,
      "real-cut-answered": {
        ...prevBase.beats["real-cut-answered"],
        cutMs: 1900,
        status: "FAIL" as const,
      },
    },
    replyGap: { p50Ms: 900, p95Ms: 1200, samples: 2 },
    endCallDrain: { goodbyeCoverage: 0.95, hangUpDelayMs: 900, narratedEnding: false, inboxNamed: true },
  };
  const next = {
    ...nextBase,
    runId: "run-next",
    gates: nextBase.gates.map((gate) =>
      gate.name === "reply-gap" ? { ...gate, status: "FAIL" as const, detail: "next" } : gate,
    ),
    beats: {
      ...nextBase.beats,
      "real-cut-answered": {
        ...nextBase.beats["real-cut-answered"],
        cutMs: 1500,
        status: "PASS" as const,
      },
    },
    replyGap: { p50Ms: 1600, p95Ms: 3100, samples: 3 },
    endCallDrain: { goodbyeCoverage: 0.7, hangUpDelayMs: 4200, narratedEnding: true, inboxNamed: false },
  };
  const diff = diffScoreboardArtifact(prev, next);
  assert.equal(diff.changed, true);
  const replyGate = diff.gates.find((gate) => gate.name === "reply-gap")!;
  assert.deepEqual(
    [replyGate.prior, replyGate.next, replyGate.changed],
    ["PASS", "FAIL", true],
  );
  assert.equal(diff.gates.find((gate) => gate.name === "plumbing")?.changed, false);

  const cutBeat = diff.beats.find((beat) => beat.beat === "real-cut-answered")!;
  assert.equal(cutBeat.cutMs.prior, 1900);
  assert.equal(cutBeat.cutMs.next, 1500);
  assert.equal(cutBeat.cutMs.deltaMs, -400);
  assert.equal(cutBeat.status.changed, true);

  assert.equal(diff.replyGap.p50DeltaMs, 700);
  assert.equal(diff.replyGap.p95DeltaMs, 1900);
  assert.equal(diff.replyGap.samplesDelta, 1);
  assert.equal(diff.endCallDrain.hangUpDelayDeltaMs, 3300);
  assert.equal(diff.endCallDrain.narratedEndingChanged, true);
  assert.equal(Math.round((diff.endCallDrain.goodbyeCoverageDelta ?? 0) * 100), -25);

  const text = formatArtifactDiff(diff);
  assert.match(text, /PASS → FAIL/);
  assert.match(text, /real-cut-answered/);
  assert.match(text, /-400ms/);
  assert.match(text, /reply gap/);
  assert.match(text, /goodbye/);
});

test("artifact diff names a changed caller clip so cut deltas stay comparable", () => {
  const base = {
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
  };
  const clip = {
    text: "Wait, stop.",
    bytes: 48_000,
    durationMs: 1000,
    sha256: "a".repeat(64),
    onsetMs: 40,
  };
  const shorter = { ...clip, bytes: 24_000, durationMs: 500, sha256: "b".repeat(64) };
  const prev = buildSkeletonArtifact({ ...base, callerClips: [clip] });
  const changed = diffScoreboardArtifact(prev, buildSkeletonArtifact({ ...base, callerClips: [shorter] }));
  assert.equal(changed.callerClips.changed, true);
  assert.match(changed.callerClips.drift ?? "", /audio bytes differ/);
  assert.match(formatArtifactDiff(changed), /caller clip.*audio bytes differ/);
  const same = diffScoreboardArtifact(prev, buildSkeletonArtifact({ ...base, callerClips: [clip] }));
  assert.equal(same.callerClips.changed, false);
  assert.equal(same.changed, false, "the same clip and the same skeleton is no change");
});

test("an unchanged artifact diff says so instead of printing empty transitions", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
  });
  const diff = diffScoreboardArtifact(artifact, artifact);
  assert.equal(diff.changed, false);
  assert.equal(diff.changedGates.length, 0);
  assert.equal(diff.changedBeats.length, 0);
  assert.match(formatArtifactDiff(diff), /no changes since the prior artifact/);
});

test("artifact diff reads an older artifact without runner fields and shows the runner transition", () => {
  const older = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
  });
  // Artifacts written before ticket 06 carry neither breakReason nor timings.
  const prior = { ...older, evalRunner: { ...older.evalRunner, breakReason: undefined, timings: undefined } } as
    unknown as ScoreboardArtifact;
  const next = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout:
      'EVAL SUMMARY {"scenario":"greeting-cut","runs":1,"failures":0,"scenarios":[{"name":"greeting-cut","passed":1,"runs":1}],' +
      '"traceSessions":["sess_abc"],"playout":[{"scenario":"greeting-cut","run":1,"wallClockMs":4200}],"audioChunks":12,"live":true}\n',
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  const diff = diffScoreboardArtifact(prior, next);
  assert.equal(diff.evalRunner.breakReason.prior, null);
  assert.equal(diff.evalRunner.breakReason.next, null);
  assert.deepEqual(diff.evalRunner.playout.prior, []);
  assert.equal(diff.evalRunner.playout.next.length, 1);
  assert.equal(diff.evalRunner.playout.wallClockDeltaMs, null, "unmeasured playout never becomes a zero delta");
  assert.equal(diff.evalRunner.changed, true);
  assert.match(formatArtifactDiff(diff), /eval runner .*playout 0 → 1 runs/);
});

// --- Ticket 05: fixed-clip cut latency ---

/** PCM16 mono at 24kHz: leading silence, then a voiced tone. */
function pcmClip(silenceMs: number, toneMs: number, rate = 24_000): Uint8Array {
  const silence = Math.round((silenceMs / 1000) * rate);
  const samples = silence + Math.round((toneMs / 1000) * rate);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = silence; i < samples; i += 1) buffer.writeInt16LE(3000, i * 2);
  return buffer;
}

test("cut latency counts from the transmitted caller speech start, not the enqueue tick", () => {
  const measured = measureCutLatency(
    { enqueuedAt: 1000, firstFrameAt: 1235, onsetMs: 210, frameOffsetMs: 200 },
    1900,
  );
  assert.equal(measured.speechStartedAt, 1245);
  assert.equal(measured.cutMs, 655, "the old metric would report 900ms from the enqueue tick");
  assert.equal(measured.reason, null);
});

test("a clip still queued behind the pump cannot report a cut", () => {
  const measured = measureCutLatency({ enqueuedAt: 1000, firstFrameAt: null, onsetMs: 0 }, 1500);
  assert.equal(measured.cutMs, null);
  assert.equal(measured.speechStartedAt, null);
  assert.equal(measured.reason, "caller speech never transmitted");
});

test("a cut that lands before the caller's onset is not credited as a caller cut", () => {
  const measured = measureCutLatency(
    { enqueuedAt: 1000, firstFrameAt: 1235, onsetMs: 200, frameOffsetMs: 0 },
    1200,
  );
  assert.equal(measured.cutMs, null);
  assert.equal(measured.reason, "cut before caller speech start");
});

test("no cut and an impossible frame time produce no latency, with a reason", () => {
  assert.equal(measureCutLatency({ enqueuedAt: 1000, firstFrameAt: 1020, onsetMs: 0 }, null).reason, "no cut");
  assert.equal(
    measureCutLatency({ enqueuedAt: 1000, firstFrameAt: 990, onsetMs: 0 }, 1500).reason,
    "frame before enqueue",
  );
});

test("the caller clip fingerprint pins the words, audio bytes, duration, and onset", () => {
  const pcm = pcmClip(120, 380);
  const fingerprint = callerClipFingerprint("Wait, stop.", pcm);
  assert.equal(fingerprint.text, "Wait, stop.");
  assert.equal(fingerprint.bytes, pcm.byteLength);
  assert.equal(fingerprint.durationMs, 500);
  assert.equal(fingerprint.onsetMs, 120);
  assert.match(fingerprint.sha256, /^[0-9a-f]{64}$/);
  assert.equal(callerClipFingerprint("Wait, stop.", pcm).sha256, fingerprint.sha256);
  assert.equal(callerClipDrift(fingerprint, callerClipFingerprint("Wait, stop.", pcm)), null);
});

test("a changed clip is detectable by words, duration, or audio samples", () => {
  const pcm = pcmClip(120, 380);
  const base = callerClipFingerprint("Wait, stop.", pcm);
  assert.match(callerClipDrift(base, callerClipFingerprint("Wait, stop now.", pcm)) ?? "", /words/);
  assert.match(
    callerClipDrift(base, callerClipFingerprint("Wait, stop.", pcmClip(120, 400))) ?? "",
    /bytes|duration/,
  );
  // Same word count and length, different synthesized take: still detectable.
  assert.match(
    callerClipDrift(base, callerClipFingerprint("Wait, stop.", pcmClip(100, 400))) ?? "",
    /audio/,
  );
});

test("the runner summary's caller clips are parsed and compared by their fixed words", () => {
  const clip = { text: "Wait, stop.", bytes: 24000, durationMs: 500, sha256: "a".repeat(64), onsetMs: 40 };
  const summary = `EVAL SUMMARY ${JSON.stringify({
    scenario: "stop-over",
    runs: 1,
    failures: 0,
    scenarios: [{ name: "stop-over", passed: 1, runs: 1 }],
    traceSessions: [],
    playout: [],
    audioChunks: 3,
    live: true,
    clips: [clip, { text: "broken" }],
  })}`;
  assert.deepEqual(callerClipsFromRunnerStdout(`${summary}\n`), [clip]);
  assert.deepEqual(callerClipsFromRunnerStdout("stop-over: 1/1\n"), [], "no summary is no clip evidence");
  assert.equal(callerClipChanges([clip], [{ ...clip, sha256: "b".repeat(64) }]), `"Wait, stop." audio samples differ at the same length (sha256 aaaaaaaaaaaa → bbbbbbbbbbbb)`);
  assert.equal(callerClipChanges([clip], [{ ...clip, text: "Okaay so" }]), null, "a new line is not clip drift");
});

// --- Ticket 08: greeting cut on "Wait, stop" ---

test("the greeting-cut bar is the locked greeting window, never a retune", () => {
  const window = GOLDEN_SCRIPT.find((beat) => beat.beat === "greeting-cut")!.window;
  assert.equal(GREETING_CUT_MAX_MS, window.max);
  assert.equal(GREETING_CUT_MAX_MS, 1500);
});

test("the greeting-cut scenario fails only beyond the greeting budget", () => {
  assert.equal(greetingCutFailure(640, null), null);
  assert.equal(greetingCutFailure(GREETING_CUT_MAX_MS, null), null, "the budget is inclusive, like stop-over");
  assert.match(greetingCutFailure(GREETING_CUT_MAX_MS + 1, null) ?? "", /greeting cut too late: 1501ms/);
  assert.match(greetingCutFailure(null, "no cut") ?? "", /greeting never cut \(no cut\)/);
});

test("the greeting-cut gate passes a fast cut and names the latency and trace turn", () => {
  const gate = evaluateGreetingCut({ cutMs: 640, traceTurn: "call trace turn 1 (sess_abc)" });
  assert.equal(gate.name, "greeting-cut");
  assert.equal(gate.status, "PASS");
  assert.match(gate.detail, /640ms/);
  assert.match(gate.detail, /call trace turn 1 \(sess_abc\)/);
});

test("the greeting-cut gate fails a cut beyond the budget and names the turn that held too long", () => {
  const gate = evaluateGreetingCut({ cutMs: 1841, traceTurn: "call trace turn 1 (sess_abc)" });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /1841ms exceeds 1500ms/);
  assert.match(gate.detail, /call trace turn 1 \(sess_abc\)/);
});

test("a greeting that never cuts fails, and says so when no trace turn was merged", () => {
  const gate = evaluateGreetingCut({ cutMs: null, traceTurn: null });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /never cut/);
  assert.match(gate.detail, /no Call trace turn merged/);
});

test("greeting-cut evidence parses the measured ms from the runner's stdout", () => {
  const evidence = extractGreetingCutEvidence(
    "    greeting cut 640ms after the caller started (budget 1500ms)\ngreeting-cut: 1/1\n",
  );
  assert.deepEqual(evidence, { cutMs: 640, traceTurn: null });
  const late = extractGreetingCutEvidence(
    '    greeting cut 1601ms after the caller started\n  ✗ greeting-cut #1: greeting cut too late: 1601ms\ngreeting-cut: 0/1\n',
  );
  assert.equal(late?.cutMs, 1601);
  assert.equal(
    extractGreetingCutEvidence("stop-over: 1/1\n    cut 912ms after the caller started\n"),
    null,
    "another scenario's cut is never greeting evidence",
  );
});

test("a passed greeting run without a measured line stays unmeasured instead of a false PASS", () => {
  assert.equal(extractGreetingCutEvidence("greeting-cut: 1/1\n"), null);
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "greeting-cut: 1/1\n",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  const gate = artifact.gates.find((g) => g.name === "greeting-cut")!;
  assert.equal(gate.status, "INFO");
  assert.match(gate.detail, /unmeasured/);
});

test("a failed greeting run with no latency line is evidence the greeting never cut", () => {
  const evidence = extractGreetingCutEvidence(
    '  ✗ greeting-cut #1: greeting never cut (no cut)\ngreeting-cut: 0/1\n',
  );
  assert.deepEqual(evidence, { cutMs: null, traceTurn: null });
  assert.equal(evaluateGreetingCut(evidence!).status, "FAIL");
});

test("greeting-cut evidence cites the interrupted greeting turn from the merged trace", () => {
  const cutTrace = [
    ' 9.80s  HEARD   "Wait, stop."  (9.20s-10.10s)',
    ' 9.90s  VONI    "Hi, this is Anna..."  (greeting)  CUT at 10.60s',
    '11.20s  VONI    "Sorry about that."  (reply_create gap 700ms)',
  ];
  assert.equal(greetingCutTraceTurn(cutTrace), 1);
  const heldTrace = [
    ' 9.90s  VONI    "Hi, this is Anna..."  (greeting)',
    '11.20s  VONI    "Still here?"  (reply_create gap 900ms)',
  ];
  assert.equal(
    greetingCutTraceTurn(heldTrace),
    1,
    "with no CUT row the call's first reply is the greeting that held",
  );
  assert.equal(greetingCutTraceTurn([]), null);
});

test("applying greeting-cut evidence fills the beat cut and replaces the skeleton gate", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "    greeting cut 640ms after the caller started\ngreeting-cut: 1/1\n",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    greetingCutEvidencePresent: true,
  });
  assert.equal(artifact.gates.find((g) => g.name === "greeting-cut")?.status, "INFO");
  const gated = applyGreetingCutGate(artifact, { cutMs: 1841, traceTurn: "call trace turn 1" });
  assert.equal(gated.beats["greeting-cut"].cutMs, 1841);
  assert.equal(gated.beats["greeting-cut"].status, "FAIL");
  const gate = gated.gates.find((g) => g.name === "greeting-cut")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /1841ms/);
  assert.match(formatGateTable(gated), /1841ms/);
});

test("the greeting clip is fixed: identical audio measures the same cut, a fresh take drifts", () => {
  const pcm = pcmClip(180, 620);
  const first = callerClipFingerprint("Wait, stop.", pcm);
  const replay = callerClipFingerprint("Wait, stop.", Buffer.from(pcm));
  assert.equal(callerClipDrift(first, replay), null, "the same clip is the same fingerprint");
  const onset = { enqueuedAt: 1000, firstFrameAt: 1050, onsetMs: replay.onsetMs, frameOffsetMs: 0 };
  assert.equal(measureCutLatency(onset, 1700).cutMs, measureCutLatency(onset, 1700).cutMs);
  assert.equal(measureCutLatency(onset, 1700).cutMs, 470);
  // Same words and length, re-synthesized take: flagged, and its onset moves.
  const fresh = callerClipFingerprint("Wait, stop.", pcmClip(160, 640));
  assert.match(callerClipDrift(first, fresh) ?? "", /audio/);
  assert.notEqual(fresh.onsetMs, first.onsetMs);
});

test("a measured greeting cut counts as evidence for the measurements gate", () => {
  assert.deepEqual(measuredEvidenceSources({ greetingCutEvidencePresent: true }), ["greeting-cut"]);
});

// ── Ticket 06: overheard-aside recall gate ────────────────────────────────

const AGENT_LINE = "I'd handle booking, reminders, and after-hours calls for your clinic.";

function aside(overrides: Partial<OverheardAside> = {}): OverheardAside {
  return {
    beat: "overheard-aside",
    text: "We're a bakery, actually.",
    agentText: AGENT_LINE,
    markedOverheard: true,
    inLedger: true,
    handling: "heard-only",
    tracePointer: "sess_abc :: 12.34s HEARD \"We're a bakery, actually.\"",
    ...overrides,
  };
}

test("overheard kinds reuse the overlap judge: steering yields, filler ignored, content judged", () => {
  assert.equal(classifyOverheard("Wait, stop.", AGENT_LINE), "steering");
  assert.equal(classifyOverheard("No.", AGENT_LINE), "steering");
  assert.equal(classifyOverheard("Okaay so", AGENT_LINE), "filler");
  assert.equal(classifyOverheard("mm-hmm", AGENT_LINE), "filler");
  assert.equal(classifyOverheard("We're a bakery, actually.", AGENT_LINE), "content");
  assert.equal(classifyOverheard("What about pricing?", AGENT_LINE), "content");
});

test("every aside is marked Overheard and counted even when not answered", () => {
  const heardOnly = evaluateOverheardRecall([aside()]);
  assert.equal(heardOnly.recalled, 1);
  assert.equal(heardOnly.total, 1);
  assert.equal(heardOnly.failures.length, 0);
  assert.equal(heardOnly.gate.status, "PASS");

  const unmarked = evaluateOverheardRecall([aside({ markedOverheard: false })]);
  assert.equal(unmarked.recalled, 0);
  assert.equal(unmarked.gate.status, "FAIL");
  assert.match(unmarked.gate.detail, /not marked Overheard/);

  const missing = evaluateOverheardRecall([aside({ inLedger: false })]);
  assert.equal(missing.recalled, 0);
  assert.equal(missing.gate.status, "FAIL");
  assert.match(missing.gate.detail, /ledger/);

  const lost = evaluateOverheardRecall([aside({ handling: "lost" })]);
  assert.equal(lost.recalled, 0);
  assert.equal(lost.gate.status, "FAIL");
  assert.match(lost.gate.detail, /lost/);
});

test("steering is answered; filler is resumed-from without derailing the turn", () => {
  const steeringAnswered = evaluateOverheardRecall([
    aside({ text: "Wait, stop.", handling: "answered" }),
  ]);
  assert.equal(steeringAnswered.gate.status, "PASS");

  const steeringHeardOnly = evaluateOverheardRecall([
    aside({ text: "Wait, stop.", handling: "heard-only" }),
  ]);
  assert.equal(steeringHeardOnly.gate.status, "FAIL");
  assert.match(steeringHeardOnly.gate.detail, /not answered/);

  const steeringResumed = evaluateOverheardRecall([
    aside({ text: "Wait, stop.", handling: "resumed-from" }),
  ]);
  assert.equal(steeringResumed.gate.status, "FAIL");

  const fillerResumed = evaluateOverheardRecall([
    aside({ text: "mm-hmm", handling: "resumed-from" }),
  ]);
  assert.equal(fillerResumed.gate.status, "PASS");

  const fillerHeardOnly = evaluateOverheardRecall([
    aside({ text: "mm-hmm", handling: "heard-only" }),
  ]);
  assert.equal(fillerHeardOnly.gate.status, "PASS");

  const fillerAnswered = evaluateOverheardRecall([
    aside({ text: "mm-hmm", handling: "answered" }),
  ]);
  assert.equal(fillerAnswered.gate.status, "FAIL");
  assert.match(fillerAnswered.gate.detail, /derail/);
});

test("overheard recall counts per beat with trace pointers", () => {
  const evaluation = evaluateOverheardRecall([
    aside({ beat: "overheard-aside", handling: "heard-only" }),
    aside({
      beat: "greeting-cut",
      text: "Wait, stop.",
      handling: "answered",
      tracePointer: "sess_abc :: 03.10s HEARD \"Wait, stop.\"",
    }),
  ]);
  assert.equal(evaluation.total, 2);
  assert.equal(evaluation.recalled, 2);
  assert.deepEqual(evaluation.byBeat["overheard-aside"], { recalled: 1, total: 1 });
  assert.deepEqual(evaluation.byBeat["greeting-cut"], { recalled: 1, total: 1 });
  assert.deepEqual(evaluation.byBeat["filler-ignored"], { recalled: 0, total: 0 });

  const failing = evaluateOverheardRecall([
    aside({ beat: "overheard-aside", handling: "lost" }),
  ]);
  assert.equal(failing.gate.status, "FAIL");
  assert.ok(failing.gate.detail.includes("sess_abc"), "failing gate points at the trace turn");

  const empty = evaluateOverheardRecall([]);
  assert.equal(empty.gate.status, "FAIL");
  assert.match(empty.gate.detail, /no overheard asides/);
});

test("artifact carries overheard counts per beat plus asides with trace pointers", () => {
  const asides = [aside()];
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: 'heard: "bakery"\n',
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    overheardAsides: asides,
  });
  assert.equal(artifact.overheard.recalled, 1);
  assert.equal(artifact.overheard.total, 1);
  assert.deepEqual(artifact.overheard.byBeat["overheard-aside"], { recalled: 1, total: 1 });
  assert.deepEqual(artifact.overheard.asides, asides);
  assert.ok(artifact.overheard.asides[0].tracePointer.includes("sess_abc"));
  const gate = artifact.gates.find((g) => g.name === "overheard-recall")!;
  assert.equal(gate.status, "PASS");

  const failing = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    overheardAsides: [aside({ handling: "lost" })],
  });
  assert.equal(failing.gates.find((g) => g.name === "overheard-recall")!.status, "FAIL");
});

test("skeleton without overheard input stays INFO for backward compatibility", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  assert.equal(artifact.gates.find((g) => g.name === "overheard-recall")!.status, "INFO");
});

test("overheard report lists per-beat counts with trace pointers", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    overheardAsides: [aside()],
  });
  const report = formatOverheardReport(artifact);
  assert.match(report, /overheard-aside: 1\/1/);
  assert.ok(report.includes("sess_abc"), "report carries the trace pointer");
  assert.ok(report.includes("bakery"), "report carries the aside text");
});

test("trace asides are marked from agent-floor overlap, never assumed", () => {
  const excerpt = [
    '10.20s  VONI    "handling booking and reminders"  (reply.create ttfa 400ms)  CUT at 11.30s',
    '11.05s  HEARD   "We\'re a bakery, actually."  (11.05s–12.10s)',
    "11.40s  CLIENT  barge-in keep jev We're a bakery, actually.",
  ];
  const asides = overheardFromTraceExcerpt(excerpt, "sess_abc");
  assert.equal(asides.length, 1);
  assert.equal(asides[0].inLedger, true);
  assert.equal(asides[0].markedOverheard, true);
  assert.equal(asides[0].handling, "resumed-from");
  assert.ok(asides[0].tracePointer.includes("sess_abc"));
  assert.ok(asides[0].tracePointer.includes("bakery"));
  assert.match(asides[0].tracePointer, /call trace turn 1/, "the pointer cites the reply it overlapped");

  const steeringExcerpt = [
    '10.20s  VONI    "handling booking"  (reply.create)',
    '11.05s  HEARD   "Wait, stop."  (11.05s–11.60s)',
    "11.40s  CLIENT  barge-in yield rule Wait, stop.",
  ];
  const steering = overheardFromTraceExcerpt(steeringExcerpt, "sess_abc");
  assert.equal(steering[0].handling, "answered");

  // A HEARD row in a gap between replies is ordinary caller speech: the
  // transcript ledger counted it, but nothing marks it Overheard, so it is
  // never invented as an aside.
  const inGap = overheardFromTraceExcerpt(
    [
      '10.20s  VONI    "handling booking"  (reply.create gap 900ms)',
      '12.00s  HEARD   "What does it cost?"  (11.80s–12.10s)',
    ],
    "sess_xyz",
  );
  assert.deepEqual(inGap, []);

  // No HEARD row at all: the explicit caption mark is still a marked aside,
  // but the ledger never counted it — the gate FAILs on that asymmetry.
  const orphan = overheardFromTraceExcerpt([], "sess_abc", "overheard-aside", {
    captionMarks: ["We're a bakery, actually."],
  });
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].markedOverheard, true);
  assert.equal(orphan[0].inLedger, false);
  const orphanGate = evaluateOverheardRecall(orphan).gate;
  assert.equal(orphanGate.status, "FAIL");
  assert.match(orphanGate.detail, /ledger/);
  assert.match(orphanGate.detail, /no Call trace turn merged/);
});

test("a trace aside carries what Voni was saying, so its own echo is filler, not content", () => {
  const excerpt = [
    '10.20s  VONI    "handling booking and reminders"  (reply.create)  CUT at 11.30s',
    '11.05s  HEARD   "booking and reminders"  (11.05s–11.60s)',
    "11.40s  CLIENT  barge-in yield rule booking and reminders",
  ];
  const asides = overheardFromTraceExcerpt(excerpt, "sess_abc");
  assert.equal(asides.length, 1);
  assert.equal(asides[0].agentText, "handling booking and reminders");
  assert.equal(classifyOverheard(asides[0].text, asides[0].agentText), "filler");
  // The server answered what was only Voni's own echo: the turn went sideways,
  // and the FAIL must name the reply the aside landed on.
  const evaluation = evaluateOverheardRecall(asides);
  assert.equal(evaluation.gate.status, "FAIL");
  assert.match(evaluation.gate.detail, /filler derailed the turn/);
  assert.match(evaluation.gate.detail, /call trace turn 1 \(sess_abc\)/);
});

test("steering ignored in the merged trace FAILs and points at the turn it landed on", () => {
  const excerpt = [
    '10.20s  VONI    "handling booking and reminders"  (reply.create)  CUT at 11.30s',
    '11.05s  HEARD   "Wait, stop."  (11.05s–11.60s)',
    "11.40s  CLIENT  barge-in keep jev Wait, stop.",
  ];
  const asides = overheardFromTraceExcerpt(excerpt, "sess_abc");
  assert.equal(classifyOverheard(asides[0].text, asides[0].agentText), "steering");
  assert.equal(asides[0].handling, "resumed-from");
  const evaluation = evaluateOverheardRecall(asides);
  assert.equal(evaluation.gate.status, "FAIL");
  assert.match(evaluation.gate.detail, /steering not answered \(handling=resumed-from\)/);
  assert.match(evaluation.gate.detail, /call trace turn 1 \(sess_abc\)/);

  // The same aside answered is the expected course change.
  const answered = overheardFromTraceExcerpt(
    [
      '10.20s  VONI    "handling booking and reminders"  (reply.create)  CUT at 11.30s',
      '11.05s  HEARD   "Wait, stop."  (11.05s–11.60s)',
      "11.40s  CLIENT  barge-in yield rule Wait, stop.",
    ],
    "sess_abc",
  );
  assert.equal(answered[0].handling, "answered");
  assert.equal(evaluateOverheardRecall(answered).gate.status, "PASS");
});

test("filler answered in the merged trace FAILs and points at the turn it landed on", () => {
  const excerpt = [
    '10.20s  VONI    "handling booking and reminders"  (reply.create)  CUT at 11.30s',
    '11.05s  HEARD   "Okaay so"  (11.05s–11.60s)',
    "11.40s  CLIENT  barge-in yield rule Okaay so",
  ];
  const asides = overheardFromTraceExcerpt(excerpt, "sess_abc");
  assert.equal(classifyOverheard(asides[0].text, asides[0].agentText), "filler");
  assert.equal(asides[0].handling, "answered");
  const evaluation = evaluateOverheardRecall(asides);
  assert.equal(evaluation.gate.status, "FAIL");
  assert.match(evaluation.gate.detail, /filler derailed the turn/);
  assert.match(evaluation.gate.detail, /call trace turn 1 \(sess_abc\)/);

  // Resumed from is the expected recovery: the back-channel never derails.
  const resumed = overheardFromTraceExcerpt(
    [
      '10.20s  VONI    "handling booking and reminders"  (reply.create)  CUT at 11.30s',
      '11.05s  HEARD   "Okaay so"  (11.05s–11.60s)',
      "11.40s  CLIENT  barge-in ignore rule Okaay so",
    ],
    "sess_abc",
  );
  assert.equal(resumed[0].handling, "resumed-from");
  assert.equal(evaluateOverheardRecall(resumed).gate.status, "PASS");
});

test("the session ledger proves the same aside counted, and a mismatch FAILs", () => {
  const excerpt = [
    '10.20s  VONI    "handling booking"  (reply.create)  CUT at 11.30s',
    '11.05s  HEARD   "We\'re a bakery, actually."  (11.05s–12.10s)',
    "11.40s  CLIENT  barge-in keep jev We're a bakery, actually.",
  ];
  const counted = overheardFromTraceExcerpt(excerpt, "sess_abc", "overheard-aside", {
    ledger: ["We run a dental clinic.", "We're a bakery, actually."],
  });
  assert.equal(counted[0].markedOverheard, true);
  assert.equal(counted[0].inLedger, true);
  assert.equal(evaluateOverheardRecall(counted).gate.status, "PASS");

  // Marked over Voni's reply but missing from the session transcript: the
  // aside vanished from the ledger, and the FAIL cites the turn it landed on.
  const uncounted = overheardFromTraceExcerpt(excerpt, "sess_abc", "overheard-aside", {
    ledger: ["We run a dental clinic."],
  });
  assert.equal(uncounted[0].markedOverheard, true);
  assert.equal(uncounted[0].inLedger, false);
  const uncountedGate = evaluateOverheardRecall(uncounted).gate;
  assert.equal(uncountedGate.status, "FAIL");
  assert.match(uncountedGate.detail, /ledger/);
  assert.match(uncountedGate.detail, /call trace turn 1/);

  // Caption evidence measured it as unmarked: ledgered but never marked.
  const unmarked = overheardFromTraceExcerpt(excerpt, "sess_abc", "overheard-aside", {
    captionMarks: [],
  });
  assert.equal(unmarked[0].markedOverheard, false);
  assert.equal(unmarked[0].inLedger, true);
  const unmarkedGate = evaluateOverheardRecall(unmarked).gate;
  assert.equal(unmarkedGate.status, "FAIL");
  assert.match(unmarkedGate.detail, /not marked Overheard/);
  assert.match(unmarkedGate.detail, /call trace turn 1/);
});

test("the runner's session ledger marker parses to transcript rows", () => {
  const stdout = [
    "  · trace session sess_over14",
    '    heard ledger ["We run a dental clinic.","We\'re a bakery, actually."]',
  ].join("\n");
  assert.deepEqual(parseHeardLedgerOutput(stdout), ["We run a dental clinic.", "We're a bakery, actually."]);
  assert.equal(parseHeardLedgerOutput("no ledger marker"), null);
  assert.equal(parseHeardLedgerOutput("    heard ledger []"), null, "an empty ledger is absent evidence");
  assert.equal(parseHeardLedgerOutput("    heard ledger not-json"), null);
});

test("a start-only HEARD span still proves the aside when the cut follows it", () => {
  // The exact 044716 over-talk excerpt: the API omitted the aside's speech end
  // (`(16.23s–  –  )`), but the reply's real CUT at 17.04s is after the start.
  const excerpt = [
    '0.71s  VONI    "Hi, I\'m Voni! Let\'s try something cool: I\'ll show you what I can do while we talk. Ready?"  (greeting ttfa 660ms)',
    '8.43s  HEARD   "Tell me in detail, step by step, how you would help a dental clinic with its phone calls."  (8.43s–13.13s)',
    '14.40s  VONI    "I\'ll show you by doing it"  (user_speech ttfa 1258ms gap 1261ms)  CUT at 17.04s',
    '16.23s  HEARD   "We\'re a bakery, actually."  (16.23s–  –  )',
    '19.07s  VONI    "That sounds delicious. Want to try the test first?"  (greeting ttfa 2027ms)',
  ];
  const asides = overheardFromTraceExcerpt(
    excerpt,
    "sess_ed67132dfbee46fc9e0f36b2a3a3d987",
    "overheard-aside",
    { ledger: ["Tell me in detail, step by step, how you would help a dental clinic with its phone calls.", "We're a bakery, actually."] },
  );
  assert.equal(asides.length, 1, "only the bakery aside overlapped a reply");
  assert.equal(asides[0].text, "We're a bakery, actually.");
  assert.equal(asides[0].markedOverheard, true);
  assert.equal(asides[0].inLedger, true);
  assert.match(asides[0].tracePointer, /call trace turn 2/);
  assert.ok(asides[0].tracePointer.includes("sess_ed67132dfbee46fc9e0f36b2a3a3d987"));
  const evaluation = evaluateOverheardRecall(asides);
  assert.equal(evaluation.recalled, 1);
  assert.equal(evaluation.total, 1);
  assert.equal(evaluation.gate.status, "PASS");
});

test("a start-only HEARD span with no cut is ordinary speech, not an aside", () => {
  const noCut = overheardFromTraceExcerpt(
    [
      '10.20s  VONI    "handling booking"  (reply.create gap 900ms)',
      '16.23s  HEARD   "We\'re a bakery, actually."  (16.23s–  –  )',
    ],
    "sess_abc",
  );
  assert.deepEqual(noCut, [], "a free floor never marks an aside");

  // The cut predates the words: the reply was already silent when they began.
  const beforeStart = overheardFromTraceExcerpt(
    [
      '10.20s  VONI    "handling booking"  (reply.create)  CUT at 12.00s',
      '16.23s  HEARD   "We\'re a bakery, actually."  (16.23s–  –  )',
    ],
    "sess_abc",
  );
  assert.deepEqual(beforeStart, []);
});

test("the runner's OVERHEARD ASIDE marker parses only a proven, well-formed overlap", () => {
  const line =
    'OVERHEARD ASIDE {"scenario":"over-talk","session":"sess_over14","text":"We\'re a bakery, actually.",' +
    '"agentText":"I\'ll show you by doing it","replyId":"reply_1","startMs":16230,"endMs":null,"cutMs":17040}';
  const evidence = parseOverheardAsideOutput(`  · trace session sess_over14\n${line}`);
  assert.ok(evidence);
  assert.equal(evidence!.sessionId, "sess_over14");
  assert.equal(evidence!.text, "We're a bakery, actually.");
  assert.equal(evidence!.startMs, 16_230);
  assert.equal(evidence!.cutMs, 17_040);
  assert.equal(evidence!.endMs, null);
  assert.equal(parseOverheardAsideOutput("no marker here"), null);

  const rejects = (stdout: string, pattern: RegExp) =>
    assert.throws(() => parseOverheardAsideOutput(stdout), pattern);
  rejects("OVERHEARD ASIDE {not json", /not valid JSON/);
  rejects('OVERHEARD ASIDE {"scenario":"over-talk","session":"sess_a","text":"","startMs":1,"cutMs":2}', /aside text/);
  rejects('OVERHEARD ASIDE {"scenario":"over-talk","session":"loop01","text":"hi","startMs":1,"cutMs":2}', /session id/);
  rejects('OVERHEARD ASIDE {"scenario":"over-talk","session":"sess_a","startMs":1,"cutMs":2}', /aside text/);
  rejects(
    'OVERHEARD ASIDE {"scenario":"over-talk","session":"sess_a","text":"hi","startMs":5000,"cutMs":4000}',
    /cut before the aside/,
  );

  const counted = overheardFromRunEvidence(evidence!, "overheard-aside", ["We're a bakery, actually."]);
  assert.equal(counted.length, 1);
  assert.equal(counted[0].markedOverheard, true);
  assert.equal(counted[0].inLedger, true);
  assert.equal(counted[0].handling, "heard-only");
  assert.match(counted[0].tracePointer, /16\.23s HEARD/);
  assert.match(counted[0].tracePointer, /runner cut 17\.04s/);
  assert.equal(evaluateOverheardRecall(counted).gate.status, "PASS");

  // A missing ledger is not evidence: the marker alone can never pass the gate.
  const unledgered = overheardFromRunEvidence(evidence!, "overheard-aside", ["We run a dental clinic."]);
  assert.equal(unledgered[0].inLedger, false);
  const gate = evaluateOverheardRecall(unledgered).gate;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /ledger/);
});

test("dead-air bars quote the pipeline contracts (2s ceiling, 15s check-in)", () => {
  assert.equal(DEAD_AIR_MAX_MS, 2000);
  assert.equal(SILENCE_CHECK_IN_TARGET_MS, 15_000);
});

test("dead air: a quiet call with no long silence passes", () => {
  const gate = evaluateDeadAir({ gapsMs: [400, 1200], longestSilenceMs: 1200, checkIns: [] });
  assert.equal(gate.name, "dead-air");
  assert.equal(gate.status, "PASS");
});

test("dead air: exactly 2000ms of silence is not a violation", () => {
  const gate = evaluateDeadAir({ gapsMs: [2000], longestSilenceMs: 2000, checkIns: [] });
  assert.equal(gate.status, "PASS");
});

test("dead air: uncovered silence over 2s fails and reports durations with trace pointers", () => {
  const gate = evaluateDeadAir({
    gapsMs: [400, 3200],
    longestSilenceMs: 3200,
    checkIns: [],
    trace: "sess_abc excerpt 12",
  });
  assert.equal(gate.name, "dead-air");
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("3200"), "failure reports the dead-air duration");
  assert.ok(gate.detail.includes("2000"), "failure names the 2s bar");
  assert.ok(gate.detail.includes("silence-check-in"), "failure points at the beat");
  assert.ok(gate.detail.includes("sess_abc excerpt 12"), "failure carries the trace pointer");
});

test("dead air: 15s of silence with no check-in fails check-in-once", () => {
  const gate = evaluateDeadAir({ gapsMs: [], longestSilenceMs: 16_000, checkIns: [] });
  assert.equal(gate.status, "FAIL");
  assert.ok(/exactly one/.test(gate.detail), `want exactly-one wording, got: ${gate.detail}`);
});

test("dead air: 15s of silence with two check-ins fails exactly-once", () => {
  const gate = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 17_000,
    checkIns: [
      { atSilenceMs: 15_200, overCaller: false },
      { atSilenceMs: 32_000, overCaller: false },
    ],
  });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("2"), `want the count in the detail, got: ${gate.detail}`);
});

test("dead air: a check-in over caller speech fails even when durations pass", () => {
  const gate = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 16_000,
    checkIns: [{ atSilenceMs: 15_100, overCaller: true, trace: "turn 12" }],
  });
  assert.equal(gate.status, "FAIL");
  assert.ok(/over caller speech/.test(gate.detail), `want overlap wording, got: ${gate.detail}`);
  assert.ok(gate.detail.includes("turn 12"), "failure carries the trace pointer");
});

test("dead air: a check-in that yields inside the cut budget passes and carries the measured yield", () => {
  // Ticket 19: the visitor started speaking over the check-in; it stopped
  // inside the same 1500ms cut budget the barge-in uses (quoted, not retuned).
  const gate = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 16_000,
    checkIns: [{ atSilenceMs: 15_100, overCaller: true, yieldMs: 900, trace: "turn 12" }],
  });
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /yielded in 900ms/);
});

test("dead air: a check-in that holds past the cut budget fails at its turn", () => {
  const gate = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 16_000,
    checkIns: [{ atSilenceMs: 15_100, overCaller: true, yieldMs: 1900, trace: "call trace turn 7 (sess_yield)" }],
  });
  assert.equal(gate.status, "FAIL", gate.detail);
  assert.match(gate.detail, /held 1900ms/);
  assert.match(gate.detail, /1500ms/);
  assert.match(gate.detail, /call trace turn 7 \(sess_yield\)/);
});

test("the silence timeline carries a measured check-in yield", () => {
  const derived = deriveFreeFloorSilence({
    startedMs: 0,
    endedMs: 20_000,
    agentAudio: [{ startMs: 0, endMs: 1_000 }],
    callerSpeech: [{ startMs: 16_500, endMs: 18_000 }],
    coverage: [{ atMs: 15_500 }],
    checkIns: [{ atMs: 15_400, overCaller: true, yieldMs: 800 }],
  });
  assert.equal(derived.checkIns.length, 1);
  assert.equal(derived.checkIns[0].yieldMs, 800);
});

test("dead air: a check-in over caller speech with no merged turn says so explicitly", () => {
  const gate = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 16_000,
    checkIns: [{ atSilenceMs: 15_100, overCaller: true }],
  });
  assert.equal(gate.status, "FAIL");
  assert.ok(/over caller speech/.test(gate.detail), `want overlap wording, got: ${gate.detail}`);
  assert.match(gate.detail, /no call trace turn merged for this check-in/);
});

test("dead air: an early check-in before 15s of silence fails", () => {
  const gate = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 16_000,
    checkIns: [{ atSilenceMs: 5_000, overCaller: false }],
  });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("5,000") || gate.detail.includes("5000"), `want the timing, got: ${gate.detail}`);
});

test("dead air: 15s of silence with exactly one clean check-in passes", () => {
  const gate = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 16_000,
    checkIns: [{ atSilenceMs: 15_200, overCaller: false }],
  });
  assert.equal(gate.status, "PASS");
  assert.ok(gate.detail.includes("15,200") || gate.detail.includes("15200"), `want the timing, got: ${gate.detail}`);
});

test("dead air: a zero-check-in FAIL cites the silence's call trace turn", () => {
  const gate = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 16_000,
    checkIns: [],
    silences: [
      {
        startMs: 1_000,
        endMs: 17_000,
        durationMs: 16_000,
        trace: "at call trace turn 1 (sess_sil); window 1.00s–17.00s",
      },
    ],
  });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /0 check-ins/);
  assert.match(gate.detail, /call trace turn 1/);
  assert.match(gate.detail, /window 1\.00s–17\.00s/);
});

test("dead air: a zero-check-in FAIL says no turn was merged when the evidence has none", () => {
  const gate = evaluateDeadAir({ gapsMs: [], longestSilenceMs: 16_000, checkIns: [] });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /no call trace turn merged/);
});

test("dead air: a two-check-in FAIL cites the turn of the extra check-in", () => {
  const gate = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 17_000,
    checkIns: [
      { atSilenceMs: 15_200, overCaller: false, trace: "at call trace turn 2 (sess_sil)" },
      { atSilenceMs: 16_400, overCaller: false, trace: "at call trace turn 4 (sess_sil)" },
    ],
  });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /2 check-ins/);
  assert.match(gate.detail, /16,?400ms/);
  assert.match(gate.detail, /call trace turn 4/, "the FAIL cites where the count went wrong");
});

test("dead air: an early check-in FAIL cites its turn, or says none was merged", () => {
  const cited = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 16_000,
    checkIns: [{ atSilenceMs: 5_000, overCaller: false, trace: "at call trace turn 1 (sess_sil)" }],
  });
  assert.equal(cited.status, "FAIL");
  assert.match(cited.detail, /5,?000ms/);
  assert.match(cited.detail, /call trace turn 1/);

  const bare = evaluateDeadAir({
    gapsMs: [],
    longestSilenceMs: 16_000,
    checkIns: [{ atSilenceMs: 5_000, overCaller: false }],
  });
  assert.match(bare.detail, /no call trace turn merged/);
});

test("the runner counts only the demo's exact check-in instructions", () => {
  assert.equal(isSilenceCheckInInstructions(SILENCE_CHECK_IN_INSTRUCTIONS), true);
  assert.equal(isSilenceCheckInInstructions(`  ${SILENCE_CHECK_IN_INSTRUCTIONS}\n`), true);
  assert.equal(isSilenceCheckInInstructions("Still with me?"), false, "a short line is not the floor's check-in");
  assert.equal(isSilenceCheckInInstructions("Say exactly this: Still with me? Take your time."), false);
});

test("free-floor silence: a timeline with no check-ins still exposes the 15s stretch", () => {
  const evidence = deriveFreeFloorSilence({
    startedMs: 0,
    endedMs: 18_000,
    agentAudio: [{ startMs: 0, endMs: 1_000 }],
    callerSpeech: [],
    checkIns: [],
  });
  assert.deepEqual(evidence.checkIns, []);
  assert.equal(evidence.longestSilenceMs, 17_000);
  const gate = evaluateDeadAir({
    gapsMs: evidence.gapsMs,
    gapWindows: evidence.gapWindows,
    silences: evidence.silences,
    longestSilenceMs: evidence.longestSilenceMs,
    checkIns: evidence.checkIns,
  });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /0 check-ins/);
});

test("free-floor silence: two check-ins in the stretch both land at their offsets and FAIL", () => {
  const evidence = deriveFreeFloorSilence({
    startedMs: 0,
    endedMs: 34_000,
    agentAudio: [{ startMs: 0, endMs: 1_000 }],
    callerSpeech: [],
    checkIns: [
      { atMs: 16_200, overCaller: false },
      { atMs: 32_400, overCaller: false },
    ],
  });
  assert.deepEqual(evidence.checkIns, [
    { atMs: 16_200, atSilenceMs: 15_200, overCaller: false },
    { atMs: 32_400, atSilenceMs: 31_400, overCaller: false },
  ]);
  const gate = evaluateDeadAir({
    gapsMs: evidence.gapsMs,
    longestSilenceMs: evidence.longestSilenceMs,
    checkIns: evidence.checkIns,
  });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /2 check-ins/);
});

test("free-floor silence: a check-in over caller speech is kept as overlap evidence, not lost", () => {
  const evidence = deriveFreeFloorSilence({
    startedMs: 0,
    endedMs: 18_000,
    agentAudio: [{ startMs: 0, endMs: 1_000 }],
    callerSpeech: [{ startMs: 16_000, endMs: 16_800 }],
    checkIns: [{ atMs: 16_200, overCaller: true }],
  });
  assert.deepEqual(evidence.checkIns, [{ atMs: 16_200, atSilenceMs: 15_200, overCaller: true }]);
  const gate = evaluateDeadAir({
    gapsMs: evidence.gapsMs,
    longestSilenceMs: evidence.longestSilenceMs,
    checkIns: evidence.checkIns,
  });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /over caller speech/);
  assert.match(gate.detail, /no call trace turn merged for this check-in/);
});

test("free-floor silence: a check-in before 15s of silence FAILs as early", () => {
  const evidence = deriveFreeFloorSilence({
    startedMs: 0,
    endedMs: 18_000,
    agentAudio: [
      { startMs: 0, endMs: 1_000 },
      { startMs: 17_000, endMs: 18_000 },
    ],
    callerSpeech: [],
    checkIns: [{ atMs: 6_000, overCaller: false }],
  });
  assert.deepEqual(evidence.checkIns, [{ atMs: 6_000, atSilenceMs: 5_000, overCaller: false }]);
  const gate = evaluateDeadAir({
    gapsMs: evidence.gapsMs,
    longestSilenceMs: evidence.longestSilenceMs,
    checkIns: evidence.checkIns,
  });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /5,?000ms/);
  assert.match(gate.detail, /before 15,?000ms/);
});

test("free-floor silence: gaps between audible turns are measured from the session timeline", () => {
  const evidence = deriveFreeFloorSilence({
    startedMs: 0,
    endedMs: 4_000,
    agentAudio: [
      { startMs: 0, endMs: 1_000 },
      { startMs: 2_700, endMs: 4_000 },
    ],
    callerSpeech: [{ startMs: 1_500, endMs: 2_500 }],
  });
  assert.deepEqual(evidence.gapsMs, []);
  assert.deepEqual(
    evidence.silences.map((silence) => [silence.startMs, silence.endMs, silence.durationMs]),
    [
      [1_000, 1_500, 500],
      [2_500, 2_700, 200],
    ],
  );
  assert.equal(evidence.longestSilenceMs, 500);
});

test("free-floor silence: a long silence with no coverage is an uncovered gap", () => {
  const evidence = deriveFreeFloorSilence({
    startedMs: 0,
    endedMs: 5_000,
    agentAudio: [
      { startMs: 0, endMs: 1_000 },
      { startMs: 4_200, endMs: 5_000 },
    ],
    callerSpeech: [{ startMs: 1_000, endMs: 1_200 }],
  });
  assert.deepEqual(evidence.gapsMs, [3_000]);
  assert.equal(evidence.longestSilenceMs, 3_000);
  assert.deepEqual(evidence.gapWindows, [
    { startMs: 1_200, endMs: 4_200, durationMs: 3_000, coveredBy: null, trace: null },
  ]);
});

test("free-floor silence: an agent reply start inside the long silence covers it", () => {
  const evidence = deriveFreeFloorSilence({
    startedMs: 0,
    endedMs: 5_000,
    agentAudio: [
      { startMs: 0, endMs: 1_000 },
      { startMs: 4_200, endMs: 5_000 },
    ],
    callerSpeech: [{ startMs: 1_000, endMs: 1_200 }],
    coverage: [{ atMs: 4_000 }],
  });
  assert.deepEqual(evidence.gapsMs, []);
  assert.equal(evidence.longestSilenceMs, 3_000);
  assert.equal(evidence.silences[0].coveredBy, "agent");
  const gate = evaluateDeadAir({
    gapsMs: evidence.gapsMs,
    gapWindows: evidence.gapWindows,
    silences: evidence.silences.map((silence) => ({
      ...silence,
      trace: "between call trace turn 1 and turn 2 (sess_sil); window 1.20s–4.20s",
    })),
    longestSilenceMs: evidence.longestSilenceMs,
    checkIns: evidence.checkIns,
  });
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /covered by an agent turn/);
  assert.match(gate.detail, /call trace turn 1/);
});

test("free-floor silence: a timely check-in covers a 15s silence and reports its timing", () => {
  const evidence = deriveFreeFloorSilence({
    startedMs: 0,
    endedMs: 18_000,
    agentAudio: [
      { startMs: 0, endMs: 1_000 },
      { startMs: 17_000, endMs: 18_000 },
    ],
    callerSpeech: [{ startMs: 1_000, endMs: 1_200 }],
    checkIns: [{ atMs: 16_200, overCaller: false }],
  });
  assert.deepEqual(evidence.gapsMs, []);
  assert.equal(evidence.longestSilenceMs, 15_800);
  assert.equal(evidence.silences[0].coveredBy, "check-in");
  assert.deepEqual(evidence.checkIns, [{ atMs: 16_200, atSilenceMs: 15_000, overCaller: false }]);
  const gate = evaluateDeadAir({
    gapsMs: evidence.gapsMs,
    gapWindows: evidence.gapWindows,
    longestSilenceMs: evidence.longestSilenceMs,
    checkIns: evidence.checkIns,
  });
  assert.equal(gate.status, "PASS", gate.detail);
});

test("dead air: a FAIL cites the gap window and deadAir.gapsMs instead of inventing a trace row", () => {
  const gate = evaluateDeadAir({
    gapsMs: [3_500],
    gapWindows: [
      {
        durationMs: 3_500,
        startMs: 1_500,
        endMs: 5_000,
        trace: "between call trace turn 1 and turn 2 (sess_sil); window 1.50s–5.00s",
      },
    ],
    longestSilenceMs: 3_500,
    checkIns: [],
  });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("3500"), gate.detail);
  assert.ok(gate.detail.includes("deadAir.gapsMs"), gate.detail);
  assert.ok(gate.detail.includes("1.50s–5.00s"), gate.detail);
  assert.ok(gate.detail.includes("call trace turn 1"), gate.detail);
});

test("trace silence citation points at the surrounding turns and the window", () => {
  const excerpt = [
    '1.00s  VONI    "Hi there"  (greeting)',
    '3.50s  HEARD   "We run a bakery"  (3.50s–4.50s)',
    '9.00s  VONI    "Sure thing"  (reply_create gap 900ms)',
  ];
  assert.equal(
    traceSilenceRef(excerpt, { startMs: 4_500, endMs: 9_000 }, "sess_sil"),
    "between call trace turn 1 and turn 2 (sess_sil); window 4.50s–9.00s",
  );
  assert.equal(
    traceSilenceRef(excerpt, { startMs: 1_000, endMs: 3_000 }, "sess_sil"),
    "at call trace turn 1 (sess_sil); window 1.00s–3.00s",
  );
  assert.equal(
    traceSilenceRef(excerpt, { startMs: 9_500, endMs: 12_000 }, "sess_sil"),
    "after call trace turn 2 (sess_sil); window 9.50s–12.00s",
  );
  assert.equal(traceSilenceRef([], { startMs: 0, endMs: 1_000 }, "sess_sil"), null);
});

test("silence timeline evidence parses from the runner line and rejects broken payloads", () => {
  const line =
    'SILENCE TIMELINE {"scenario":"stop-over","session":"sess_sil","startedMs":0,"endedMs":5000,' +
    '"agentAudio":[{"startMs":0,"endMs":1000}],"callerSpeech":[],"coverage":[{"atMs":400}]}';
  const parsed = parseSilenceTimelineOutput(`banner\n${line}\n`);
  assert.equal(parsed?.scenario, "stop-over");
  assert.equal(parsed?.sessionId, "sess_sil");
  assert.equal(parsed?.timeline.endedMs, 5_000);
  assert.deepEqual(parsed?.timeline.agentAudio, [{ startMs: 0, endMs: 1_000 }]);
  assert.deepEqual(parsed?.timeline.coverage, [{ atMs: 400 }]);
  assert.equal(parseSilenceTimelineOutput("no timeline line"), null);
  assert.throws(
    () => parseSilenceTimelineOutput('SILENCE TIMELINE {"scenario":"x","startedMs":0,"endedMs":1000}'),
    /agentAudio/,
  );
  assert.throws(
    () =>
      parseSilenceTimeline(
        { startedMs: 0, endedMs: 1_000, agentAudio: [{ startMs: 900, endMs: 500 }], callerSpeech: [] },
        "silence.json",
      ),
    /startMs/,
  );
});

test("skeleton artifact without dead-air evidence keeps dead-air INFO (unmeasured, never PASS)", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  assert.equal(artifact.gates.find((g) => g.name === "dead-air")?.status, "INFO");
  assert.deepEqual(artifact.deadAir.gapsMs, []);
  assert.deepEqual(artifact.deadAir.checkIns, []);
});

test("skeleton artifact records dead-air evidence and gates it", () => {
  const bad = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    deadAir: { gapsMs: [3200], longestSilenceMs: 3200, checkIns: [] },
  });
  const badGate = bad.gates.find((g) => g.name === "dead-air");
  assert.equal(badGate?.status, "FAIL");
  assert.ok(badGate?.detail.includes("3200"));
  assert.equal(bad.deadAir.maxMs, 3200);

  const good = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    deadAir: {
      gapsMs: [400],
      longestSilenceMs: 16_000,
      checkIns: [{ atSilenceMs: 15_200, overCaller: false }],
    },
  });
  assert.equal(good.gates.find((g) => g.name === "dead-air")?.status, "PASS");
  assert.deepEqual(good.deadAir.checkIns, [{ atSilenceMs: 15_200, overCaller: false }]);
});

test("an over-caller check-in FAIL cites the Call trace turn it became", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "silence-check-in",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceSessionId: "sess_check",
    traceExcerpt: [
      ' 1.00s  VONI    "Hi, this is Anna"  (greeting)',
      '17.00s  VONI    "Still with me? Take your time."  (reply_create gap 900ms)',
    ],
    deadAir: {
      gapsMs: [],
      longestSilenceMs: 16_000,
      checkIns: [{ atMs: 16_200, atSilenceMs: 15_200, overCaller: true }],
    },
  });
  const gate = artifact.gates.find((g) => g.name === "dead-air")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /over caller speech/);
  assert.match(gate.detail, /call trace turn 2 \(sess_check\)/, gate.detail);
  assert.equal(artifact.deadAir.checkIns[0].trace, "call trace turn 2 (sess_check)");
});

test("an over-caller check-in with no later VONI row says no turn was merged", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "silence-check-in",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceSessionId: "sess_check",
    traceExcerpt: [' 1.00s  VONI    "Hi, this is Anna"  (greeting)'],
    deadAir: {
      gapsMs: [],
      longestSilenceMs: 16_000,
      checkIns: [{ atMs: 16_200, atSilenceMs: 15_200, overCaller: true }],
    },
  });
  const gate = artifact.gates.find((g) => g.name === "dead-air")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /no call trace turn merged for this check-in/);
});

const FRESH_INVITE = "Send me an email from your work address with Lime 42 in the subject, and tell me when it's sent.";

function freshEvidence(overrides = {}) {
  return {
    agentLines: [FRESH_INVITE],
    chipShows: [{ address: "test@voni.cc", tag: EMAIL_INVITE_TAG }],
    showToolCalls: 1,
    tagTokenBefore: "tag-tok",
    tagTokenAfter: "tag-tok",
    memoryInvitedBefore: true,
    memoryInvitedAfter: true,
    callTokenBefore: "call-tok",
    callTokenAfter: "call-tok",
    returning: false,
    greetedAsReturning: false,
    freeAddress: null,
    ...overrides,
  };
}

test("email invite counts the tag once exactly (Lime 42)", () => {
  assert.equal(countTagMentions([FRESH_INVITE]), 1);
  assert.equal(countTagMentions(["hello there"]), 0);
  assert.equal(countTagMentions([FRESH_INVITE, FRESH_INVITE]), 2);
  assert.equal(countTagMentions(["send with lime42 please"]), 1, "typed without a space still counts");
});

test("email invite rejects digit-by-digit spelling", () => {
  assert.equal(hasDigitSplitTag([FRESH_INVITE]), false);
  assert.equal(hasDigitSplitTag(["Send with Lime 4 2 in the subject"]), true);
  assert.equal(hasDigitSplitTag(["Send with Lime four two in the subject"]), true);
});

test("email invite rejects an invented tag and a spoken address", () => {
  assert.deepEqual(findInventedTags([FRESH_INVITE]), []);
  assert.ok(findInventedTags(["Send with Coral 17 in the subject"]).length > 0);
  assert.deepEqual(findStrayAddresses([FRESH_INVITE]), []);
  assert.ok(findStrayAddresses(["My mail is andres@casaverde.pt"]).length > 0);
  assert.deepEqual(findStrayAddresses(["The team's at hi@voni.cc to take it further"]), [], "goodbye may name hi@voni.cc");
});

test("work-email gate is said once for a personal address, never otherwise", () => {
  const gate = "Got it, Nidal! But that's a personal address, and I need your work one. Can you send it from there, with the same tag?";
  assert.equal(countWorkEmailGate([gate]), 1);
  assert.equal(countWorkEmailGate([FRESH_INVITE]), 0);
  const gated = evaluateEmailInvite(freshEvidence({ agentLines: [FRESH_INVITE, gate], freeAddress: "nidal@gmail.com" }));
  assert.equal(gated.status, "PASS");
  assert.equal(gated.workEmailGateMentions, 1);
  const twice = evaluateEmailInvite(
    freshEvidence({ agentLines: [FRESH_INVITE, gate, gate], freeAddress: "nidal@gmail.com" }),
  );
  assert.equal(twice.status, "FAIL", "gate said twice");
  const missing = evaluateEmailInvite(freshEvidence({ freeAddress: "nidal@gmail.com" }));
  assert.equal(missing.status, "FAIL", "personal address without the gate");
  const spurious = evaluateEmailInvite(freshEvidence({ agentLines: [FRESH_INVITE, gate] }));
  assert.equal(spurious.status, "FAIL", "gate with no personal address");
});

test("email invite passes once exactly, fails on zero or twice", () => {
  assert.equal(evaluateEmailInvite(freshEvidence()).status, "PASS");
  assert.equal(evaluateEmailInvite(freshEvidence()).tagMentions, 1);
  assert.equal(evaluateEmailInvite(freshEvidence({ agentLines: ["hello"] })).status, "FAIL", "never said");
  assert.equal(evaluateEmailInvite(freshEvidence({ agentLines: [FRESH_INVITE, FRESH_INVITE] })).status, "FAIL", "said twice");
  assert.equal(
    evaluateEmailInvite(freshEvidence({ agentLines: ["Send with Lime 4 2 in the subject"] })).status,
    "FAIL",
    "digit split",
  );
  assert.equal(
    evaluateEmailInvite(freshEvidence({ agentLines: ["Send with Coral 17 in the subject", FRESH_INVITE] })).status,
    "FAIL",
    "invented tag alongside the real one",
  );
  assert.equal(
    evaluateEmailInvite(freshEvidence({ agentLines: [FRESH_INVITE, "Mail me at andres@casaverde.pt"] })).status,
    "FAIL",
    "spoken address",
  );
  assert.equal(evaluateEmailInvite(freshEvidence({ showToolCalls: 2 })).status, "FAIL", "second invite");
});

test("contact chip appears exactly once per address with the inbox and tag", () => {
  assert.equal(evaluateEmailInvite(freshEvidence()).status, "PASS");
  assert.equal(evaluateEmailInvite(freshEvidence({ chipShows: [] })).status, "FAIL", "no chip");
  assert.equal(
    evaluateEmailInvite(freshEvidence({ chipShows: [{ address: "test@voni.cc", tag: EMAIL_INVITE_TAG }, { address: "test@voni.cc", tag: EMAIL_INVITE_TAG }] })).status,
    "FAIL",
    "chip twice for the same address",
  );
  assert.equal(
    evaluateEmailInvite(freshEvidence({ chipShows: [{ address: "other@x.com", tag: EMAIL_INVITE_TAG }] })).status,
    "FAIL",
    "wrong address",
  );
});

test("email invite FAIL cites the Call trace turn where the tag repeated", () => {
  const result = evaluateEmailInvite(
    freshEvidence({
      agentLines: [FRESH_INVITE, FRESH_INVITE],
      lineTurns: ["call trace turn 3 (sess_invite26)", "call trace turn 7 (sess_invite26)"],
      chipTraceTurn: "call trace turn 3 (sess_invite26)",
    }),
  );
  assert.equal(result.status, "FAIL");
  assert.match(result.detail, /said the tag 2 times at call trace turn 7 \(sess_invite26\)/);
});

test("email invite FAIL cites the turn for a split tag, invented tag, stray address, or second invite", () => {
  const split = evaluateEmailInvite(
    freshEvidence({
      agentLines: ["Send with Lime 4 2 in the subject"],
      lineTurns: ["call trace turn 2 (sess_invite26)"],
    }),
  );
  assert.equal(split.status, "FAIL");
  assert.match(split.detail, /digit by digit at call trace turn 2 \(sess_invite26\)/);

  const invented = evaluateEmailInvite(
    freshEvidence({
      agentLines: ["Send with Coral 17 in the subject", FRESH_INVITE],
      lineTurns: ["call trace turn 2 (sess_invite26)", "call trace turn 3 (sess_invite26)"],
    }),
  );
  assert.equal(invented.status, "FAIL");
  assert.match(invented.detail, /invented a tag: "Coral 17" at call trace turn 2 \(sess_invite26\)/);

  const stray = evaluateEmailInvite(
    freshEvidence({
      agentLines: [FRESH_INVITE, "Mail me at andres@casaverde.pt"],
      lineTurns: ["call trace turn 2 (sess_invite26)", "call trace turn 4 (sess_invite26)"],
    }),
  );
  assert.equal(stray.status, "FAIL");
  assert.match(stray.detail, /spoke an address: .* at call trace turn 4 \(sess_invite26\)/);

  const twice = evaluateEmailInvite(
    freshEvidence({
      agentLines: [FRESH_INVITE],
      lineTurns: ["call trace turn 2 (sess_invite26)"],
      showToolCalls: 2,
    }),
  );
  assert.equal(twice.status, "FAIL");
  assert.match(twice.detail, /invited 2 times at call trace turn 2 \(sess_invite26\)/);
});

test("contact chip FAIL cites the turn where the chip duplicated or showed the wrong inbox", () => {
  const twice = evaluateEmailInvite(
    freshEvidence({
      chipShows: [
        { address: "test@voni.cc", tag: EMAIL_INVITE_TAG },
        { address: "test@voni.cc", tag: EMAIL_INVITE_TAG },
      ],
      chipTraceTurn: "call trace turn 2 (sess_invite26)",
    }),
  );
  assert.equal(twice.status, "FAIL");
  assert.match(twice.detail, /chip showed 2 times at call trace turn 2 \(sess_invite26\)/);

  const wrong = evaluateEmailInvite(
    freshEvidence({
      chipShows: [{ address: "other@x.com", tag: EMAIL_INVITE_TAG }],
      chipTraceTurn: "call trace turn 2 (sess_invite26)",
    }),
  );
  assert.equal(wrong.status, "FAIL");
  assert.match(wrong.detail, /chip showed other@x\.com at call trace turn 2 \(sess_invite26\)/);

  const wrongTag = evaluateEmailInvite(
    freshEvidence({
      chipShows: [{ address: "test@voni.cc", tag: "Lime 43" }],
      chipTraceTurn: "call trace turn 2 (sess_invite26)",
    }),
  );
  assert.equal(wrongTag.status, "FAIL");
  assert.match(wrongTag.detail, /chip tag does not match the call tag at call trace turn 2 \(sess_invite26\)/);
});

test("agent lines map to their VONI turn in the merged Call trace, repeats in order", () => {
  const excerpt = [
    ' 1.00s  HEARD   "We run a small travel agency"  (0.20s-1.00s)',
    ' 2.00s  VONI    "Got it, a travel agency."  (reply_create gap 900ms)',
    ' 5.00s  VONI    "Send me an email with Lime 42 in the subject."  (reply_create gap 950ms)',
    ' 9.00s  VONI    "Send me an email with Lime 42 in the subject."  (reply_create gap 1000ms)',
  ];
  assert.deepEqual(traceTurnsForAgentLines(excerpt, ["Got it, a travel agency.", "Send me an email with Lime 42 in the subject."]), [1, 2]);
  assert.deepEqual(
    traceTurnsForAgentLines(excerpt, ["Send me an email with Lime 42 in the subject.", "Send me an email with Lime 42 in the subject."]),
    [2, 3],
    "the second identical line maps to the second VONI turn",
  );
  assert.deepEqual(traceTurnsForAgentLines(excerpt, ["not in the trace"]), [null], "never a guessed turn");
});

test("tag persists across Hold return and reload via Call memory", () => {
  assert.equal(evaluateEmailInvite(freshEvidence()).memoryPersists, true);
  assert.equal(
    evaluateEmailInvite(freshEvidence({ memoryInvitedAfter: false })).status,
    "FAIL",
    "invite lost across hold/reload",
  );
  assert.equal(evaluateEmailInvite(freshEvidence({ tagTokenAfter: "other-tok" })).status, "FAIL", "tag token swapped");
  assert.equal(evaluateEmailInvite(freshEvidence({ callTokenAfter: "other-call" })).status, "FAIL", "call token swapped");
});

test("Hold memory is measured only by a complete before/after pair", () => {
  const base = {
    agentLines: [FRESH_INVITE],
    chipShows: [{ address: "test@voni.cc", tag: EMAIL_INVITE_TAG }],
    showToolCalls: 1,
  };
  const loneTag = evaluateEmailInvite({ ...base, tagTokenBefore: "tag-tok" });
  assert.equal(loneTag.memoryPersists, null, "a lone before is not a pair");
  assert.equal(loneTag.status, "PASS", "unmeasured memory is not a spoken FAIL");
  assert.equal(emailInviteGate(loneTag).status, "INFO", "unmeasured memory never blocks required green");

  const loneInvite = evaluateEmailInvite({ ...base, memoryInvitedBefore: true });
  assert.equal(loneInvite.memoryPersists, null);
  assert.equal(emailInviteGate(loneInvite).status, "INFO");

  const loneAfter = evaluateEmailInvite({ ...base, callTokenAfter: "call-tok" });
  assert.equal(loneAfter.memoryPersists, null);
  assert.equal(emailInviteGate(loneAfter).status, "INFO");

  const paired = evaluateEmailInvite({ ...base, tagTokenBefore: "tag-tok", tagTokenAfter: "tag-tok" });
  assert.equal(paired.memoryPersists, true);
  assert.equal(emailInviteGate(paired).status, "PASS");

  const mismatched = evaluateEmailInvite({ ...base, callTokenBefore: "call-tok", callTokenAfter: "new-call" });
  assert.equal(mismatched.memoryPersists, false);
  assert.equal(emailInviteGate(mismatched).status, "FAIL", "only a measured mismatch fails");
});

test("a tag lost on return FAILs and cites the Call trace turn where it was lost", () => {
  const explicit = evaluateEmailInvite(
    freshEvidence({
      tagTokenAfter: "new-tag",
      memoryTraceTurn: "call trace turn 9 (sess_hold27)",
    }),
  );
  assert.equal(explicit.status, "FAIL");
  assert.match(explicit.detail, /tag did not persist across Hold return\/reload at call trace turn 9 \(sess_hold27\)/);
  assert.equal(explicit.memoryTraceTurn, "call trace turn 9 (sess_hold27)");

  // No explicit turn: the later tag mention is the repeat ask after the return.
  const derived = evaluateEmailInvite(
    freshEvidence({
      agentLines: [FRESH_INVITE, FRESH_INVITE],
      lineTurns: ["call trace turn 2 (sess_hold27)", "call trace turn 7 (sess_hold27)"],
      tagTokenAfter: "new-tag",
    }),
  );
  assert.equal(derived.status, "FAIL");
  assert.match(derived.detail, /tag did not persist across Hold return\/reload at call trace turn 7 \(sess_hold27\)/);

  // A trace that merged no turn says so instead of guessing one.
  const unmerged = evaluateEmailInvite(freshEvidence({ memoryInvitedAfter: false, memoryTraceTurn: null }));
  assert.equal(unmerged.status, "FAIL");
  assert.match(unmerged.detail, /tag did not persist across Hold return\/reload \(no Call trace turn merged\)/);
});

test("after a Hold return a second invite or tag mention FAILs as a repeat ask", () => {
  const reasked = evaluateEmailInvite(
    freshEvidence({
      agentLines: [FRESH_INVITE, FRESH_INVITE],
      lineTurns: ["call trace turn 2 (sess_hold27)", "call trace turn 7 (sess_hold27)"],
      showToolCalls: 2,
    }),
  );
  assert.equal(reasked.status, "FAIL");
  assert.match(reasked.detail, /invited 2 times/);
  assert.match(reasked.detail, /said the tag 2 times at call trace turn 7 \(sess_hold27\)/);
});

test("returning sender is greeted without a second invite", () => {
  const greeted = "Found it, Andres. Good to hear from you again!";
  const ok = evaluateEmailInvite(
    freshEvidence({ agentLines: [FRESH_INVITE, greeted], returning: true, greetedAsReturning: true }),
  );
  assert.equal(ok.status, "PASS");
  assert.equal(
    evaluateEmailInvite(freshEvidence({ agentLines: [FRESH_INVITE, "Found it, Andres."], returning: true, greetedAsReturning: false })).status,
    "FAIL",
    "returning without a greeting",
  );
  assert.equal(
    evaluateEmailInvite(freshEvidence({ returning: true, greetedAsReturning: true, showToolCalls: 2, agentLines: [FRESH_INVITE, FRESH_INVITE, greeted] })).status,
    "FAIL",
    "second invite for a returning sender",
  );
  // Callback: the carried tag is checked at connect, no second invite, no chip yet.
  const callback = evaluateEmailInvite({
    agentLines: ["Got it from an earlier call."],
    chipShows: [],
    showToolCalls: 0,
    tagTokenBefore: "tag-tok",
    tagTokenAfter: "tag-tok",
    memoryInvitedBefore: false,
    memoryInvitedAfter: false,
    callTokenBefore: "call-tok",
    callTokenAfter: "call-tok",
    returning: true,
    greetedAsReturning: true,
    freeAddress: null,
  });
  assert.equal(callback.status, "PASS", "callback needs no second invite");
});

test("skeleton carries an INFO email-invite gate until evidence lands", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  assert.ok(artifact.gates.some((g) => g.name === "email-invite"), "gate row exists");
  assert.equal(artifact.gates.find((g) => g.name === "email-invite")?.status, "INFO");
  assert.equal(artifact.emailInvite, null);
});

test("applying email evidence scores the beat, the artifact, and the console", () => {
  const base = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "invite-tag",
    runnerStdout: FRESH_INVITE,
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  const scored = applyEmailInvite(base, freshEvidence());
  assert.equal(scored.emailInvite?.tagMentions, 1);
  assert.equal(scored.emailInvite?.status, "PASS");
  assert.equal(scored.beats["email-invite"].status, "PASS");
  assert.equal(scored.gates.find((g) => g.name === "email-invite")?.status, "PASS");
  assert.ok(formatGateTable(scored).includes("email-invite"));
  const failed = applyEmailInvite(base, freshEvidence({ agentLines: ["hello"] }));
  assert.equal(failed.emailInvite?.status, "FAIL");
  assert.equal(failed.beats["email-invite"].status, "FAIL");
  assert.equal(failed.gates.find((g) => g.name === "email-invite")?.status, "FAIL");
});

test("double-talk gate pins the 400ms audibility bar", () => {
  assert.equal(DOUBLE_TALK_MAX_OVERLAP_MS, 400);
});

test("post-flush overlap counts only the caller audio and agent playout that survive the flush", () => {
  // Prompt flush at the cut (1200ms) with 400ms of agent audio still queued
  // and the real 40ms fade: the caller hears at most 40ms of the faded tail.
  assert.equal(
    postFlushOverlapMs({ cutAt: 1200, flushAt: 1200, agentUntil: 1240, caller: { start: 1000, end: 2000 } }),
    40,
  );
  // A fade that lets the playout run long (or a flush that never stops the
  // audio) is the regression the 400ms bar exists to catch: 800ms audible.
  assert.equal(
    postFlushOverlapMs({ cutAt: 1200, flushAt: 1200, agentUntil: 2100, caller: { start: 1000, end: 2000 } }),
    800,
  );
  // Agent audio already finished before the cut: nothing sounds after it.
  assert.equal(
    postFlushOverlapMs({ cutAt: 1200, flushAt: 1200, agentUntil: 1100, caller: { start: 1000, end: 2000 } }),
    0,
  );
  // The caller stops 10ms after the cut: only those 10ms can overlap.
  assert.equal(
    postFlushOverlapMs({ cutAt: 1200, flushAt: 1200, agentUntil: 1240, caller: { start: 1000, end: 1210 } }),
    10,
  );
  // The caller starts after the fade completed: no simultaneous audio.
  assert.equal(
    postFlushOverlapMs({ cutAt: 1200, flushAt: 1200, agentUntil: 1240, caller: { start: 1300, end: 2000 } }),
    0,
  );
  // A cut with no caller speech (agent-only flush) is never overlap.
  assert.equal(postFlushOverlapMs({ cutAt: 1200, flushAt: 1200, agentUntil: 1240, caller: null }), 0);
});

test("a 1200ms cut latency with a prompt flush passes double talk", () => {
  // The caller starts at 0 and the server cut lands at 1200ms: that 1200ms is
  // cut latency, budgeted by barge-in-cut (1500ms). It must NOT be scored as
  // double talk. The flush drops the queue, so only the 40ms fade remains.
  const caller = { start: 0, end: 2000 };
  const prompt = playoutCutWindow({ cutAt: 0, flushAt: 1200, playUntil: 5000, fadeMs: 40, caller });
  assert.equal(prompt.agentUntil, 1240);
  assert.equal(postFlushOverlapMs(prompt), 40);
  assert.equal(cutOverlapMs(prompt), 1240, "cut latency is diagnosed, never gated as double talk");
  const gate = evaluateDoubleTalk({ overlapMs: [postFlushOverlapMs(prompt)], traceRef: "sess_cut / over-talk" });
  assert.equal(gate.status, "PASS", gate.detail);
});

test("an ineffective flush leaves agent audio sounding and fails at the cut turn", () => {
  // The flush was processed at 1200ms but failed to drop the queue: audio
  // keeps sounding for 650ms after it (then fades). The post-flush residual
  // is 690ms, a real talk-over rather than an assumption that flush == stop.
  const caller = { start: 1000, end: 3000 };
  const failed = playoutCutWindow({
    cutAt: 1200,
    flushAt: 1200,
    playUntil: 5000,
    fadeMs: 40,
    keepSoundingMs: 650,
    caller,
  });
  assert.equal(failed.agentUntil, 1890);
  assert.equal(postFlushOverlapMs(failed), 690);
  const gate = evaluateDoubleTalk({ overlapMs: [postFlushOverlapMs(failed)], traceRef: "sess_fault / over-talk" });
  assert.equal(gate.status, "FAIL", gate.detail);
  assert.match(gate.detail, /690/);
  assert.match(gate.detail, /call trace|sess_fault/);
});

test("the over-talk runner line is the overlap evidence the gate scores", () => {
  const stdout = [
    "over-talk: 1/1",
    '    DOUBLE TALK {"scenario":"over-talk","session":"sess_abc","overlapMs":[40,0],"fadeMs":40}',
  ].join("\n");
  assert.deepEqual(parseDoubleTalkOutput(stdout), {
    scenario: "over-talk",
    sessionId: "sess_abc",
    overlapMs: [40, 0],
    fadeMs: 40,
  });
});

test("the last DOUBLE TALK line wins and unrelated stdout is ignored", () => {
  const stdout = [
    '    DOUBLE TALK {"scenario":"over-talk","session":"sess_first","overlapMs":[900]}',
    "    heard ledger []",
    '    DOUBLE TALK {"scenario":"over-talk","session":"sess_last","overlapMs":[40]}',
  ].join("\n");
  assert.deepEqual(parseDoubleTalkOutput(stdout)?.overlapMs, [40]);
  assert.equal(parseDoubleTalkOutput(stdout)?.sessionId, "sess_last");
  assert.equal(parseDoubleTalkOutput("over-talk: 1/1\n    heard ledger []\n"), null);
});

test("a malformed DOUBLE TALK line breaks fast instead of scoring invented overlap", () => {
  assert.throws(
    () => parseDoubleTalkOutput('    DOUBLE TALK {"scenario":"over-talk","overlapMs":"40"}'),
    /DOUBLE TALK/,
  );
});

test("double-talk evidence past 400ms fails with every measured cut and the Call trace turn", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "over-talk",
    runnerStdout: "over-talk: 0/1\n",
    exitCode: 1,
    durationMs: 9000,
    runs: 1,
    doubleTalkOverlapMs: [40, 650],
    traceSessionId: "sess_abc",
    traceExcerpt: [
      '  VONI    "Sure, first the tour" (reply_create gap 900ms) CUT at 12.20s by caller speech',
      '  VONI    "So the price depends on call volume." (reply_create gap 700ms)',
    ],
  });
  const gate = artifact.gates.find((g) => g.name === "double-talk")!;
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("40, 650"), `detail names every measured cut: ${gate.detail}`);
  assert.match(gate.detail, /call trace turn 1 \(sess_abc\)/);
});

test("fake-playout timings turn a flush into the post-flush overlap window", () => {
  const caller = { start: 1000, end: 2000 };
  // 3.8s of agent audio still queued, real 40ms fade: only the fade is heard.
  const faded = playoutCutWindow({ cutAt: 1200, playUntil: 5000, fadeMs: 40, caller });
  assert.equal(faded.flushAt, 1200, "a prompt flush defaults to the cut instant");
  assert.equal(faded.agentUntil, 1240);
  assert.equal(postFlushOverlapMs(faded), 40);
  assert.equal(cutOverlapMs(faded), 40);
  // Playout already finished before the cut: nothing survives the flush.
  assert.equal(postFlushOverlapMs(playoutCutWindow({ cutAt: 1200, playUntil: 900, fadeMs: 40, caller })), 0);
  // A hard stop (no fade) leaves no residual, only the click the fade prevents.
  assert.equal(postFlushOverlapMs(playoutCutWindow({ cutAt: 1200, playUntil: 5000, fadeMs: 0, caller })), 0);
  // A fade regression that lets the queued tail run long is the 400ms breach.
  const long = playoutCutWindow({ cutAt: 1200, playUntil: 5000, fadeMs: 900, caller });
  assert.equal(long.agentUntil, 2100);
  assert.equal(postFlushOverlapMs(long), 800);
  // An ineffective flush keeps queued audio sounding after the fade.
  const kept = playoutCutWindow({ cutAt: 1200, playUntil: 5000, fadeMs: 40, keepSoundingMs: 650, caller });
  assert.equal(kept.agentUntil, 1890);
  assert.equal(postFlushOverlapMs(kept), 690);
  // The caller arriving mid-fade still only overlaps the fade's remainder.
  assert.equal(
    postFlushOverlapMs(playoutCutWindow({ cutAt: 1200, playUntil: 5000, fadeMs: 40, caller: { start: 1230, end: 2000 } })),
    10,
  );
});

test("a flush that stops the agent late still passes: only the post-flush residual counts", () => {
  // The server cut lands at 1700ms (after 1200ms of cut latency); the flush
  // itself is prompt, so the residual is the fade. Double talk cannot fail
  // for cut latency, which the barge-in-cut gate budgets separately.
  const caller = { start: 0, end: 2000 };
  const lateCut = playoutCutWindow({ cutAt: 0, flushAt: 1700, playUntil: 5000, fadeMs: 40, caller });
  assert.equal(lateCut.agentUntil, 1740);
  assert.equal(postFlushOverlapMs(lateCut), 40);
  assert.equal(evaluateDoubleTalk({ overlapMs: [postFlushOverlapMs(lateCut)] }).status, "PASS");
});

test("double-talk passes when every cut fades inside 400ms", () => {
  const gate = evaluateDoubleTalk({ overlapMs: [0, 120, 400] });
  assert.equal(gate.name, "double-talk");
  assert.equal(gate.status, "PASS");
  assert.ok(gate.detail.includes("400"), `detail names the bar: ${gate.detail}`);
});

test("double-talk fails on any audible overlap over 400ms, with durations", () => {
  const gate = evaluateDoubleTalk({ overlapMs: [120, 650] });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("650"), `detail names the offender: ${gate.detail}`);
  assert.ok(gate.detail.includes("400"), `detail names the bar: ${gate.detail}`);
});

test("double-talk failure points at the trace that heard it", () => {
  const gate = evaluateDoubleTalk({ overlapMs: [900], traceRef: "sess_abc / greeting-cut" });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("900"), `detail names the duration: ${gate.detail}`);
  assert.ok(gate.detail.includes("sess_abc"), `detail points at the trace: ${gate.detail}`);
});

test("double-talk with no measured cuts is INFO, never a false FAIL", () => {
  const gate = evaluateDoubleTalk({ overlapMs: [] });
  assert.equal(gate.status, "INFO");
});

test("end-call drain gate quotes the settled-poll handshake", () => {
  assert.equal(END_CALL_POLL_MS, 250);
  assert.equal(END_CALL_SETTLE_POLLS, 3);
  assert.equal(END_CALL_AUDIO_GRACE_MS, 500);
  assert.equal(END_CALL_DRAIN_TIMEOUT_MS, 10000);
  assert.equal(GOODBYE_AUDIO_COVERAGE_MIN, 0.8);
  assert.equal(HANG_UP_AFTER_GOODBYE_MAX_MS, 1500);
});

test("end-call drain passes when the full closing plays before the hang-up", () => {
  const gate = evaluateEndCallDrain({ goodbyeCoverage: 0.95, hangUpDelayMs: 900, narratedEnding: false });
  assert.equal(gate.name, "end-call-drain");
  assert.equal(gate.status, "PASS");
});

test("end-call drain fails when the goodbye is chopped below 80% coverage", () => {
  const gate = evaluateEndCallDrain({ goodbyeCoverage: 0.5, hangUpDelayMs: 100, narratedEnding: false });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("50"), `detail carries the coverage: ${gate.detail}`);
  assert.ok(gate.detail.includes("80"), `detail names the bar: ${gate.detail}`);
});

test("end-call drain fails when the session ends before the goodbye does", () => {
  const gate = evaluateEndCallDrain({ goodbyeCoverage: null, hangUpDelayMs: -200, narratedEnding: false });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("-200") || gate.detail.includes("before"), `detail says it hung up early: ${gate.detail}`);
});

test("end-call drain fails when the line is held past the hang-up bar", () => {
  const gate = evaluateEndCallDrain({ goodbyeCoverage: 1, hangUpDelayMs: 4000, narratedEnding: false });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("4000"), `detail carries the delay: ${gate.detail}`);
});

test("end-call drain fails when the model narrates the ending", () => {
  const gate = evaluateEndCallDrain({ goodbyeCoverage: 1, hangUpDelayMs: 800, narratedEnding: true });
  assert.equal(gate.status, "FAIL");
  assert.ok(/narrat/i.test(gate.detail), `detail says the ending was narrated: ${gate.detail}`);
});

test("end-call drain failure points at the trace that heard it", () => {
  const gate = evaluateEndCallDrain({
    goodbyeCoverage: 0.4,
    hangUpDelayMs: 100,
    narratedEnding: false,
    traceRef: "sess_xyz / goodbye-drain",
  });
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("sess_xyz"), `detail points at the trace: ${gate.detail}`);
});

test("end-call drain with no measured goodbye is INFO, never a false FAIL", () => {
  const gate = evaluateEndCallDrain({ goodbyeCoverage: null, hangUpDelayMs: null, narratedEnding: false });
  assert.equal(gate.status, "INFO");
});

test("a missing closing line fails explicitly instead of measuring from the greeting", () => {
  // Live hang-up-fast: the caller asked to hang up and the model called
  // end_call silently. Measuring lastAudioEnd - endedAt used the greeting and
  // reported a fake 4242ms drain; the honest evidence is "no goodbye audio".
  const gate = evaluateEndCallDrain({
    goodbyeCoverage: null,
    hangUpDelayMs: null,
    narratedEnding: false,
    missingGoodbye: true,
    traceRef: "sess_8d9245c69c8b4aefa29882b3410f1330 (no closing turn merged)",
  });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /no goodbye audio after End call/);
  assert.match(gate.detail, /sess_8d9245c69c8b4aefa29882b3410f1330/);
});

test("the closing line only names the team inbox when the address is actually said", () => {
  assert.equal(TEAM_INBOX_ADDRESS, "hi@voni.cc");
  for (const spoken of [
    "If you'd like to try again properly, the team's at hi at voni dot c c.",
    "the team's at hi@voni.cc",
    "the team's at hi at voni dot cc",
    "the team's at hi at voni dot c, c.",
    "reach us at hi@voni.cc.",
  ]) {
    assert.equal(namesTeamInbox(spoken), true, spoken);
  }
  for (const missing of [
    "I'll let you go for now. If you'd like to try again properly, the team's there.",
    "Send it to test@voni.cc.",
    "",
  ]) {
    assert.equal(namesTeamInbox(missing), false, missing);
  }
});

test("the runner's GOODBYE DRAIN evidence carries the inbox verdict, coverage, and closing turn", () => {
  const stdout = [
    "bye-audio: 1/1",
    'GOODBYE DRAIN {"scenario":"bye-audio","session":"sess_gd20","turn":4,"coverage":0.97,"inboxNamed":true}',
  ].join("\n");
  assert.deepEqual(parseGoodbyeDrainOutput(`${stdout}\n`), {
    scenario: "bye-audio",
    sessionId: "sess_gd20",
    turn: 4,
    coverage: 0.97,
    inboxNamed: true,
    narratedEnding: null,
    hangUpDelayMs: null,
  });
  assert.equal(parseGoodbyeDrainOutput("bye-audio: 1/1\n"), null);
});

test("the runner's GOODBYE DRAIN evidence carries whether the ending was narrated", () => {
  // Post-End call silence is measured by the runner too: the trace proves the
  // turn, the runner line proves the model spoke after its own hang-up.
  const narrated = parseGoodbyeDrainOutput(
    'GOODBYE DRAIN {"scenario":"bye-audio","session":"sess_gd20","turn":4,"coverage":0.97,"inboxNamed":true,"narratedEnding":true}',
  )!;
  assert.equal(narrated.narratedEnding, true);
  const silent = parseGoodbyeDrainOutput(
    'GOODBYE DRAIN {"scenario":"bye-audio","session":"sess_gd20","turn":4,"coverage":0.97,"inboxNamed":true,"narratedEnding":false}',
  )!;
  assert.equal(silent.narratedEnding, false);
  assert.throws(
    () =>
      parseGoodbyeDrainOutput(
        'GOODBYE DRAIN {"scenario":"bye-audio","inboxNamed":true,"turn":4,"narratedEnding":"yes"}',
      ),
    /narratedEnding/,
  );
});

test("several goodbye runs keep the worst closing line, never a later green one", () => {
  const stdout = [
    'GOODBYE DRAIN {"scenario":"free-gate","session":"sess_a","turn":5,"coverage":0.98,"inboxNamed":true}',
    'GOODBYE DRAIN {"scenario":"bye-audio","session":"sess_b","turn":3,"coverage":0.41,"inboxNamed":true}',
  ].join("\n");
  const parsed = parseGoodbyeDrainOutput(stdout)!;
  assert.equal(parsed.coverage, 0.41);
  assert.equal(parsed.turn, 3);
  assert.equal(parsed.sessionId, "sess_b");

  const inboxMissed = parseGoodbyeDrainOutput(
    [
      'GOODBYE DRAIN {"scenario":"bye-audio","session":"sess_b","turn":3,"coverage":0.99,"inboxNamed":false}',
      'GOODBYE DRAIN {"scenario":"free-gate","session":"sess_a","turn":5,"coverage":0.98,"inboxNamed":true}',
    ].join("\n"),
  )!;
  assert.equal(inboxMissed.inboxNamed, false);
  assert.equal(inboxMissed.sessionId, "sess_b");

  // A narrated run is the one the gate must see, even when a later run is
  // quieter: narration is never averaged away.
  const narrated = parseGoodbyeDrainOutput(
    [
      'GOODBYE DRAIN {"scenario":"free-gate","session":"sess_q","turn":5,"coverage":0.97,"inboxNamed":true,"narratedEnding":false}',
      'GOODBYE DRAIN {"scenario":"bye-audio","session":"sess_n","turn":4,"coverage":0.99,"inboxNamed":true,"narratedEnding":true}',
    ].join("\n"),
  )!;
  assert.equal(narrated.narratedEnding, true);
  assert.equal(narrated.sessionId, "sess_n");
});

test("a malformed GOODBYE DRAIN line is a harness error, never a guessed measurement", () => {
  assert.throws(
    () => parseGoodbyeDrainOutput('GOODBYE DRAIN {"scenario":"bye-audio","turn":1,"coverage":0.9}'),
    /inboxNamed/,
  );
  assert.throws(
    () =>
      parseGoodbyeDrainOutput(
        'GOODBYE DRAIN {"scenario":"bye-audio","inboxNamed":true,"turn":0,"coverage":0.9}',
      ),
    /turn/,
  );
  assert.throws(
    () =>
      parseGoodbyeDrainOutput(
        'GOODBYE DRAIN {"scenario":"bye-audio","inboxNamed":true,"coverage":"lots"}',
      ),
    /coverage/,
  );
});

test("the runner's own hang-up line is the measured end-of-audio vs session-close delay", () => {
  assert.equal(
    runnerHangUpDelayMs("    hung up 912ms after the goodbye finished playing\n"),
    912,
  );
  // Several runs: the worst hang-up is what the gate must see.
  assert.equal(
    runnerHangUpDelayMs(
      "    hung up 912ms after the goodbye finished playing\n" +
        "    hung up 4200ms after the goodbye finished playing\n",
    ),
    4200,
  );
  assert.equal(runnerHangUpDelayMs("hang-up-fast: 1/1\n"), null);
});

test("the runner's hang-up line carries the call whose drain ran long", () => {
  // A slow hang-up must cite its own closing turn, never another scenario's.
  assert.deepEqual(
    parseRunnerHangUp("    hung up 4200ms after the goodbye finished playing (session sess_drain21)\n"),
    { ms: 4200, sessionId: "sess_drain21" },
  );
  // A line without a session still measures the delay; the turn is unmerged.
  assert.deepEqual(
    parseRunnerHangUp("    hung up 912ms after the goodbye finished playing\n"),
    { ms: 912, sessionId: null },
  );
  // Several runs: the worst delay wins, with its own session.
  assert.deepEqual(
    parseRunnerHangUp(
      "    hung up 4200ms after the goodbye finished playing (session sess_fast)\n" +
        "    hung up 4800ms after the goodbye finished playing (session sess_over)\n",
    ),
    { ms: 4800, sessionId: "sess_over" },
  );
  assert.equal(parseRunnerHangUp("hang-up-fast: 1/1\n"), null);
});

test("both hang-up scenarios share one drain bar: 1500ms and never an early close", () => {
  // hang-up-fast and hang-up-over return this same verdict, so neither path
  // can print a measured drain without asserting it.
  assert.equal(hangUpDrainFailure(950), null);
  assert.equal(hangUpDrainFailure(HANG_UP_AFTER_GOODBYE_MAX_MS), null, "the bar itself passes");
  assert.match(hangUpDrainFailure(1501) ?? "", /1501ms > 1500ms/, "past the bar fails with the budget");
  assert.match(
    hangUpDrainFailure(-200) ?? "",
    /200ms before the goodbye audio ended/,
    "a session that closed before the goodbye's audio ended is chopped, not fast",
  );
});

test("an early close outranks a slow hang-up and keeps its own call", () => {
  // Any negative delay means the goodbye was cut. Taking the max delay would
  // let a normal run hide it, and the FAIL must cite the call that closed
  // early, not the one that merely ran long.
  assert.deepEqual(
    parseRunnerHangUp(
      "    hung up 912ms after the goodbye finished playing (session sess_ok)\n" +
        "    hung up -200ms after the goodbye finished playing (session sess_chop)\n" +
        "    hung up 4200ms after the goodbye finished playing (session sess_slow)\n",
    ),
    { ms: -200, sessionId: "sess_chop" },
  );
});

test("end-call drain fails when the closing line never named the team inbox", () => {
  const gate = evaluateEndCallDrain({
    goodbyeCoverage: 0.97,
    hangUpDelayMs: 900,
    narratedEnding: false,
    inboxNamed: false,
    traceRef: "call trace turn 4 (sess_gd20)",
  });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /hi@voni\.cc/, `detail names the missing inbox: ${gate.detail}`);
  assert.match(gate.detail, /call trace turn 4 \(sess_gd20\)/, `detail cites the turn: ${gate.detail}`);
});

test("end-call drain passes a full goodbye that names the team inbox", () => {
  const gate = evaluateEndCallDrain({
    goodbyeCoverage: 0.97,
    hangUpDelayMs: 900,
    narratedEnding: false,
    inboxNamed: true,
  });
  assert.equal(gate.status, "PASS");
  assert.match(gate.detail, /hi@voni\.cc/, `detail names the inbox: ${gate.detail}`);
});

test("runner goodbye evidence drives the drain gate and cites its own closing turn", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "bye-audio",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    endCallDrain: {
      goodbyeCoverage: 0.97,
      hangUpDelayMs: null,
      narratedEnding: false,
      inboxNamed: true,
    },
    endCallDrainTraceRef: "call trace turn 4 (sess_gd20)",
  });
  assert.equal(artifact.endCallDrain.inboxNamed, true);
  assert.equal(artifact.endCallDrain.goodbyeCoverage, 0.97);
  const gate = artifact.gates.find((g) => g.name === "end-call-drain")!;
  assert.equal(gate.status, "PASS");
  assert.equal(artifact.beats["goodbye-drain"].status, "PASS");
  assert.match(gate.detail, /hi@voni\.cc/);
});

test("a drain FAIL with no merged closing row says no turn instead of citing the session alone", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "bye-audio",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceSessionId: "sess_noturn20",
    traceExcerpt: ['12.20s  VONI    "Sure, first the tour"  (reply_create gap 900ms)'],
    endCallDrain: { goodbyeCoverage: 0.4, hangUpDelayMs: null, narratedEnding: false, inboxNamed: true },
  });
  const gate = artifact.gates.find((g) => g.name === "end-call-drain")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /no turn merged \(sess_noturn20\)/, `detail states the missing turn: ${gate.detail}`);
});

test("unmeasured goodbye drain never reports PASS", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "bye-audio",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    endCallDrain: { goodbyeCoverage: null, hangUpDelayMs: null, narratedEnding: false, inboxNamed: null },
  });
  const gate = artifact.gates.find((g) => g.name === "end-call-drain")!;
  assert.equal(gate.status, "INFO");
});

test("artifact carries double-talk overlaps and end-call drain evidence with both gates", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: 'heard: "Wait, stop."\n',
    exitCode: 0,
    durationMs: 1234,
    runs: 1,
    doubleTalkOverlapMs: [120, 650],
    endCallDrain: { goodbyeCoverage: 0.5, hangUpDelayMs: 100, narratedEnding: false },
    traceRef: "sess_abc",
  });
  assert.deepEqual(artifact.doubleTalk.overlapMs, [120, 650]);
  assert.equal(artifact.doubleTalk.maxMs, 650);
  assert.equal(artifact.endCallDrain.goodbyeCoverage, 0.5);
  assert.equal(artifact.endCallDrain.hangUpDelayMs, 100);
  assert.equal(artifact.endCallDrain.narratedEnding, false);
  const byName = Object.fromEntries(artifact.gates.map((g) => [g.name, g]));
  assert.equal(byName["double-talk"].status, "FAIL");
  assert.equal(byName["end-call-drain"].status, "FAIL");
  assert.ok(byName["double-talk"].detail.includes("sess_abc"));
  assert.ok(byName["end-call-drain"].detail.includes("sess_abc"));
  const table = formatGateTable(artifact);
  assert.ok(table.includes("double-talk"));
  assert.ok(table.includes("end-call-drain"));
  assert.ok(table.includes("FAIL"));
});

// ── Ticket 10, slice 1: timbre auto gate + loudness sanity ──────────────

const ZERO_PROBES = { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 };

/** A measured agent channel with no clip and no pop-scale jump. */
const CLEAN_CHANNEL = { peakDbfs: -7.2, clippedSampleRatio: 0, largestAdjacentStep: 120 };

/** The run's platform-read body; `undefined` output = no level served. */
const servedBody = (volume: number | undefined, agentId = "agent_stored", fingerprint: string | null = "fp_stored") =>
  runBodyOf(volume, { agentId, fingerprint });

test("timbre probes pass only when every count is zero", () => {
  const clean = checkTimbreProbes(ZERO_PROBES);
  assert.equal(clean.ok, true);
  for (const kind of ["jump", "overload", "clip", "underrun", "inputDrop"] as const) {
    const dirty = checkTimbreProbes({ ...ZERO_PROBES, [kind]: 1 });
    assert.equal(dirty.ok, false, `${kind} must fail the gate`);
    assert.ok(dirty.detail.includes(kind), `detail names the offender: ${dirty.detail}`);
  }
});

test("the level leg's verdict moves with the measured files, not the loudness formula", () => {
  // Same voice, same probes, same served body at the registry's unity volume —
  // where the retired native + gain + volume formula lands exactly on the
  // reference and would PASS by construction. Only the delivered capture
  // changes, so a moved verdict can only be the measurement's (ticket 17).
  const gateFor = (deliveredRms: number) =>
    evaluateTimbreGate({
      probes: ZERO_PROBES,
      voiceId: "anna",
      agentChannel: CLEAN_CHANNEL,
      runBody: servedBody(SERVED_LEVEL),
      measuredLevel: measuredLevel(-23.1, deliveredRms),
      humanRatings: passingBallots(),
    });

  const measuredPass = gateFor(-23.2);
  assert.equal(measuredPass.status, "PASS", measuredPass.detail);
  assert.match(measuredPass.detail, /level agrees within 0\.20 LU/);
  assert.match(measuredPass.detail, /captures\/delivered-anna-en\.wav/);

  // 6.0 LU below the reference, thirty times the tolerance. The formula still
  // lands on -23.1 at volume 100: if it were the input, this run would PASS.
  const measuredFail = gateFor(-29.1);
  assert.equal(measuredFail.status, "FAIL", measuredFail.detail);
  assert.match(measuredFail.detail, /level differs by 6\.00 LU/);
  assert.match(measuredFail.detail, /-23\.\d\d LUFS vs -29\.\d\d LUFS/);
  assert.match(measuredFail.detail, /captures\/delivered-anna-en\.wav/);

  // Both runs name the same stored body at the same served level, so the only
  // thing that moved between PASS and FAIL is what the files measured.
  const bodyRef = /served by stored agent agent_stored at volume 100/;
  assert.match(measuredPass.detail, bodyRef);
  assert.match(measuredFail.detail, bodyRef);
});

test("the scoreboard reports no client gain: level is the served body and measured files", () => {
  const withMeasured = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: {
      reference: measuredTone("captures/reference-anna-en.wav", -23.1),
      delivered: measuredTone("captures/delivered-anna-en.wav", -23.2),
    },
  });
  // The gain row and its review number are deleted, not merely unused.
  assert.equal("gain" in withMeasured.loudness, false, "no client gain on the artifact");
  assert.equal("voices" in withMeasured.loudness, false, "no per-voice gain table on the artifact");
  assert.equal("matchedLufs" in withMeasured.loudness, false, "no gain-derived level number");
  assert.equal(withMeasured.loudness.outputVolume, SERVED_LEVEL, "the served level remains");
  assert.equal(withMeasured.loudness.measured.status, "PASS", "the measured leg remains the level gate");

  // A served body with no measured file cannot green the level by arithmetic:
  // there is no formula left to PASS from.
  const bodyOnly = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: servedBody(SERVED_LEVEL),
  });
  assert.equal(bodyOnly.loudness.measured.status, "INFO");
  assert.equal(bodyOnly.loudness.ok, false);
  assert.equal(
    bodyOnly.gates.find((gate) => gate.name === "timbre-probes")?.status,
    "INFO",
    "a served level alone can never PASS the timbre gate",
  );

  const matrix = buildRegressionMatrix({ entries: [] });
  assert.equal("gains" in matrix, false, "the matrix carries no gain rows");
  assert.doesNotMatch(formatMatrixTable(matrix), /gain=/, "a gain table is never printed");

  const source = readFileSync(new URL("./scoreboard.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /voicePlaybackGain|playbackGain|VoiceGainRow|voiceGainRow|voiceGainTable|formatVoiceGainTable|NATIVE_VOICE_LUFS|matchedLoudnessLufs|checkLoudness|checkServedLoudness/,
    "scoreboard gain math or a gain table survived the deletion",
  );
});

test("timbre gate passes clean and fails named defects", () => {
  // A clean gate needs the measured level leg: probes, evidence and a measured
  // pass inside tolerance (ticket 16).
  const clean = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: {
      reference: measuredTone("captures/reference-anna-en.wav", -23.1),
      delivered: measuredTone("captures/delivered-anna-en.wav", -23.2),
    },
    humanRatings: passingBallots(),
  });
  assert.equal(clean.name, "timbre-probes");
  assert.equal(clean.status, "PASS", clean.detail);
  const clipped = evaluateTimbreGate({
    probes: { ...ZERO_PROBES, clip: 2 },
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
  });
  assert.equal(clipped.status, "FAIL");
  assert.ok(clipped.detail.includes("clip"));
  const jumped = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: { peakDbfs: -7.2, clippedSampleRatio: 0, largestAdjacentStep: 9831 },
  });
  assert.equal(jumped.status, "FAIL");
  assert.ok(jumped.detail.includes("jump"));
});

test("session evidence flags clipped samples and playout-scale jumps", () => {
  assert.equal(POP_JUMP_INT16, 9830);
  const clean = checkEvidenceTimbre(CLEAN_CHANNEL);
  assert.equal(clean.status, "PASS");
  assert.ok(clean.detail.includes("-7.2"), `peak stays reviewable: ${clean.detail}`);
  const clipped = checkEvidenceTimbre({ peakDbfs: -0.4, clippedSampleRatio: 0.0001, largestAdjacentStep: 120 });
  assert.equal(clipped.status, "FAIL");
  assert.ok(clipped.detail.includes("clip"));
  const stepped = checkEvidenceTimbre({ peakDbfs: -6.0, clippedSampleRatio: 0, largestAdjacentStep: 20000 });
  assert.equal(stepped.status, "FAIL");
  assert.ok(stepped.detail.includes("jump"));
  const missing = checkEvidenceTimbre(null);
  assert.equal(missing.status, "INFO", "unmeasured is INFO, never PASS");
  assert.ok(missing.detail.includes("no agent-channel evidence"));
});

test("a dry run's missing agent channel is INFO and cannot contribute a PASS", () => {
  // Every other half passes; the only unmeasured input is the agent-channel
  // PCM evidence a dry run never produces. It must keep the gate INFO, not
  // let the measured files and ballot green it (CODING_STANDARDS.md §Gates).
  const dry = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: null,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: measuredLevel(-23.1, -23.2),
    humanRatings: passingBallots(),
  });
  assert.equal(dry.status, "INFO", dry.detail);
  assert.match(dry.detail, /no agent-channel evidence/);
  assert.match(dry.detail, /unmeasured agent channel/);

  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: measuredLevel(-23.1, -23.2),
    humanRatings: passingBallots(),
    agentChannel: null,
  });
  const timbre = artifact.gates.find((gate) => gate.name === "timbre-probes");
  assert.equal(timbre?.status, "INFO", timbre?.detail);
  assert.match(timbre?.detail ?? "", /no agent-channel evidence/);
});

// ── Ticket 21: the level leg reads the stored body a visitor receives ─────

test("the timbre gate reads the served body's level, never the registry constant", () => {
  const measured = {
    reference: measuredTone("captures/reference-anna-en.wav", -23.1),
    delivered: measuredTone("captures/delivered-anna-en.wav", -23.2),
  };
  const atRegistryVolume = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: measured,
    humanRatings: passingBallots(),
  });
  assert.equal(atRegistryVolume.status, "PASS", atRegistryVolume.detail);
  assert.match(
    atRegistryVolume.detail,
    /served by stored agent agent_stored at volume 100/,
    "the verdict names the body it was measured against",
  );

  // 62 is not the registry's 100. With no measured file the level is
  // unmeasured, never greened by the registry constant.
  const quieter = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(62),
  });
  assert.equal(quieter.status, "INFO", quieter.detail);
  assert.match(quieter.detail, /unmeasured level/);
  assert.doesNotMatch(quieter.detail, /level agrees/);
});

test("a served level reaches the timbre gate unchanged", () => {
  const measured = {
    reference: measuredTone("captures/reference-anna-en.wav", -23.1),
    delivered: measuredTone("captures/delivered-anna-en.wav", -23.2),
  };
  for (const volume of [100, 90, 62, 40]) {
    const gate = evaluateTimbreGate({
      probes: ZERO_PROBES,
      voiceId: "anna",
      agentChannel: CLEAN_CHANNEL,
      runBody: servedBody(volume),
      measuredLevel: measured,
      humanRatings: passingBallots(),
    });
    assert.ok(
      gate.detail.includes(`at volume ${volume}`),
      `served volume ${volume} must be reported verbatim: ${gate.detail}`,
    );
  }
});

test("an unread served level is reported unmeasured, never passed by a registry default", () => {
  const noLevel = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(undefined),
  });
  assert.equal(noLevel.status, "INFO", "probes still gate; the level is unmeasured");
  assert.match(noLevel.detail, /unmeasured level/);
  assert.doesNotMatch(noLevel.detail, /level agrees/);

  const noBody = evaluateTimbreGate({ probes: ZERO_PROBES, voiceId: "anna", agentChannel: CLEAN_CHANNEL });
  assert.equal(noBody.status, "INFO");
  assert.match(noBody.detail, /unmeasured level/);
  assert.doesNotMatch(noBody.detail, /level agrees/);
});

test("the artifact records the body identity beside the level it measured", () => {
  const unmeasured = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: servedBody(62),
  });
  assert.deepEqual(unmeasured.agentBody, {
    source: "stored-agent",
    measured: true,
    agentId: "agent_stored",
    fingerprint: "fp_stored",
    turnDetection: null,
    reason: null,
  });
  // One run-level identity: the level no longer carries a second copy.
  assert.equal("body" in unmeasured.loudness, false, "loudness has no second body identity");
  assert.equal(unmeasured.loudness.outputVolume, 62);
  assert.equal(unmeasured.loudness.measured.status, "INFO");
  assert.equal(unmeasured.loudness.ok, false);
  assert.equal(unmeasured.gates.find((gate) => gate.name === "timbre-probes")?.status, "INFO");
  // The end-of-turn gate read the same body: one source for both gates.
  assert.equal(unmeasured.gates.find((gate) => gate.name === "end-of-turn")?.status, "PASS");

  const measured = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: servedBody(62),
    measuredLevel: {
      reference: measuredTone("captures/reference-anna-en.wav", -23.1),
      delivered: measuredTone("captures/delivered-anna-en.wav", -25.0),
    },
  });
  assert.equal(measured.loudness.measured.status, "FAIL");
  assert.match(measured.loudness.detail, /captures\/delivered-anna-en\.wav/);
  assert.equal(measured.loudness.ok, false);
  assert.equal(measured.gates.find((gate) => gate.name === "timbre-probes")?.status, "FAIL");
  assert.match(
    measured.gates.find((gate) => gate.name === "timbre-probes")?.detail ?? "",
    /at volume 62/,
  );
});

test("no served body leaves the artifact level unmeasured, never a registry number", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "suite",
    runnerStdout: "suite",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  assert.equal("body" in artifact.loudness, false);
  assert.equal(artifact.agentBody?.measured, false);
  assert.equal(artifact.loudness.outputVolume, null);
  assert.match(artifact.loudness.detail, /unmeasured/);
});

// ── Ticket 16: the level leg reads measured files, never the formula ────────
//
// Synthetic 1 kHz tones at a known RMS: the level analyser's own conformance
// case, so the delta between two files is a measured number rather than
// something the gate could derive from a native constant plus a gain.

function measuredTone(path: string, rmsDbfs: number): MeasuredLevelFile {
  const sampleRate = 24_000;
  const frames = sampleRate;
  const bytes = Buffer.alloc(frames * 2);
  const amplitude = 32_768 * 10 ** (rmsDbfs / 20) * Math.SQRT2;
  for (let frame = 0; frame < frames; frame++) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 1000 * frame) / sampleRate));
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, value)), frame * 2);
  }
  return { path, audio: decodePcm(bytes, { sampleRate, channels: 1 }) };
}

function silentTone(path: string): MeasuredLevelFile {
  const sampleRate = 24_000;
  return {
    path,
    audio: decodePcm(Buffer.alloc(sampleRate * 2), { sampleRate, channels: 1 }),
  };
}

function measuredLevel(referenceRms: number, deliveredRms: number): MeasuredLevelInput {
  return {
    reference: measuredTone("captures/reference-anna-en.wav", referenceRms),
    delivered: measuredTone("captures/delivered-anna-en.wav", deliveredRms),
  };
}

test("a measured level within tolerance passes the measured leg of the timbre gate", () => {
  const gate = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: measuredLevel(-23.1, -23.2),
    humanRatings: passingBallots(),
  });
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /captures\/reference-anna-en\.wav/, "names the reference file");
  assert.match(gate.detail, /captures\/delivered-anna-en\.wav/, "names the delivered file");
  assert.match(gate.detail, /level agrees within 0\.20 LU/);
  assert.match(gate.detail, /-23\.\d\d LUFS vs -23\.\d\d LUFS/);
});

test("a measured level out of tolerance fails the timbre gate with both measured values", () => {
  const leg = checkMeasuredLevel(measuredLevel(-23.1, -25.0));
  assert.equal(leg.status, "FAIL");
  assert.equal(leg.toleranceDb, 0.2, "the existing level tolerance decides");
  assert.ok(
    leg.deltaLu !== null && Math.abs(leg.deltaLu + 1.9) < 0.1,
    `the measured margin is the known ~1.9 LU: ${leg.deltaLu}`,
  );
  assert.equal(leg.deliveredFile, "captures/delivered-anna-en.wav");

  const gate = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: measuredLevel(-23.1, -25.0),
  });
  assert.equal(gate.status, "FAIL", gate.detail);
  assert.match(gate.detail, /level differs by 1\.\d\d LU/);
  assert.match(gate.detail, /-23\.\d\d LUFS/, "cites the measured reference");
  assert.match(gate.detail, /-25\.\d\d LUFS/, "cites the measured delivery");
  assert.match(gate.detail, /over the 0\.20 LU tolerance/);
  assert.match(gate.detail, /captures\/delivered-anna-en\.wav/);
});

test("a missing measurement is INFO, never PASS", () => {
  const noFiles = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(SERVED_LEVEL),
  });
  assert.equal(noFiles.status, "INFO", noFiles.detail);
  assert.match(noFiles.detail, /unmeasured level/);
  assert.doesNotMatch(noFiles.detail, /level agrees/);

  const silent = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: {
      reference: measuredTone("captures/reference-anna-en.wav", -23.1),
      delivered: silentTone("captures/delivered-anna-en.wav"),
    },
  });
  assert.equal(silent.status, "INFO", silent.detail);
  assert.match(silent.detail, /digital-silence/);
  assert.match(silent.detail, /captures\/delivered-anna-en\.wav/);
});

test("the derived constant cannot make the level leg pass", () => {
  // At volume 100 the old arithmetic lands exactly on the reference. With no
  // measured file present that must be INFO, not PASS.
  const arithmeticOnly = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(SERVED_LEVEL),
  });
  assert.equal(arithmeticOnly.status, "INFO", "the formula alone never passes the level leg");

  // A measured fail outranks the arithmetic pass.
  const measuredFail = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: measuredLevel(-23.1, -28.1),
  });
  assert.equal(measuredFail.status, "FAIL");

  // A measured file with no served body identity is still unmeasured: the
  // gate cannot say which body the audio came from.
  const noBody = evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: "anna",
    agentChannel: CLEAN_CHANNEL,
    measuredLevel: measuredLevel(-23.1, -23.2),
  });
  assert.equal(noBody.status, "INFO", noBody.detail);
  assert.match(noBody.detail, /no stored body read/);
});

// ── Ticket 74: the timbre gate is a measured result plus a weighted ballot ──
//
// Spec W5: a subject passes timbre only when the measured axes pass AND two
// independent raters file a weighted ballot at five out of five on one shared
// recording. Neither half can green the gate alone.

const GATE_RECORDING = "c".repeat(64);
const OTHER_RECORDING = "d".repeat(64);

function gateSubject(voice = DEFAULT_GATE_VOICE): SubjectRecord {
  return resolveSubject({ voice });
}

function ballotsFor(
  first: { timbre: number; accent: number; languageNaturalness?: number },
  second: { timbre: number; accent: number; languageNaturalness?: number },
  recording = GATE_RECORDING,
): HumanRatings {
  const one = addHumanRating(emptyHumanRatings(recording), { rater: "ana", ...first }, recording);
  return addHumanRating(one, { rater: "bob", ...second }, recording);
}

function measuredPass(): MeasuredLevelInput {
  return {
    reference: measuredTone("captures/reference-anna-en.wav", -23.1),
    delivered: measuredTone("captures/delivered-anna-en.wav", -23.2),
  };
}

function timbreGateFor(input: {
  measuredLevel?: MeasuredLevelInput | null;
  humanRatings?: HumanRatings | null;
  subject?: SubjectRecord;
} = {}) {
  return evaluateTimbreGate({
    probes: ZERO_PROBES,
    voiceId: DEFAULT_GATE_VOICE,
    agentChannel: CLEAN_CHANNEL,
    runBody: servedBody(SERVED_LEVEL),
    subject: input.subject ?? gateSubject(),
    measuredLevel: input.measuredLevel === undefined ? measuredPass() : input.measuredLevel,
    humanRatings: input.humanRatings ?? null,
  });
}

test("a measured pass with no ballot is INFO/unmeasured, never a timbre PASS", () => {
  const gate = timbreGateFor();
  assert.equal(gate.status, "INFO", gate.detail);
  assert.match(gate.detail, /measured timbre PASS/, "the measured result is quoted");
  assert.match(gate.detail, /level/);
  assert.match(gate.detail, /true peak/i);
  assert.match(gate.detail, /distortion/i);
  assert.match(gate.detail, /crest/i);
  assert.match(gate.detail, /spectral/i);
  assert.match(gate.detail, /breakup/i);
  assert.match(gate.detail, /ballot|awaiting/i, "the missing ballot is named");
});

test("a measured fail fails the timbre gate even with a five-out-of-five ballot", () => {
  const gate = timbreGateFor({
    measuredLevel: {
      reference: measuredTone("captures/reference-anna-en.wav", -23.1),
      delivered: measuredTone("captures/delivered-anna-en.wav", -29.1),
    },
    humanRatings: ballotsFor({ timbre: 5, accent: 5 }, { timbre: 5, accent: 5 }),
  });
  assert.equal(gate.status, "FAIL", gate.detail);
  assert.match(gate.detail, /level/);
});

test("a five-out-of-five ballot from one rater is not a pass", () => {
  const one = addHumanRating(
    emptyHumanRatings(GATE_RECORDING),
    { rater: "ana", timbre: 5, accent: 5 },
    GATE_RECORDING,
  );
  const gate = timbreGateFor({ humanRatings: one });
  assert.equal(gate.status, "INFO", gate.detail);
  assert.match(gate.detail, /1\/2|one rater/i);
});

test("two raters at five out of five on one shared recording pass the timbre gate", () => {
  const gate = timbreGateFor({
    humanRatings: ballotsFor({ timbre: 5, accent: 5 }, { timbre: 5, accent: 5 }),
  });
  assert.equal(gate.status, "PASS", gate.detail);
  for (const axis of [/level/, /true peak/i, /distortion/i, /crest/i, /spectral/i, /breakup/i]) {
    assert.match(gate.detail, axis, `the gate names ${axis}: ${gate.detail}`);
  }
  assert.match(gate.detail, /5\.00\/5|five out of five/i);
  assert.ok(gate.detail.includes(GATE_RECORDING.slice(0, 12)), "the shared recording is named");
});

test("two raters on different recordings are not one shared recording and never pass", () => {
  const mixed: HumanRatings = {
    timbre: 5,
    accent: 5,
    languageNaturalness: null,
    weighted: 5,
    recordingSha256: GATE_RECORDING,
    ratings: [
      { rater: "ana", timbre: 5, accent: 5, recordingSha256: GATE_RECORDING },
      { rater: "bob", timbre: 5, accent: 5, recordingSha256: OTHER_RECORDING },
    ],
  };
  const gate = timbreGateFor({ humanRatings: mixed });
  assert.equal(gate.status, "FAIL", gate.detail);
  assert.match(gate.detail, /different recordings|one shared recording/i);
});

test("the weighted ballot aggregates the axes and a four blocks below five", () => {
  // Weights: timbre 0.5, accent 0.25, language naturalness 0.25.
  assert.deepEqual(TIMBRE_BALLOT_AXIS_WEIGHTS, {
    timbre: 0.5,
    accent: 0.25,
    languageNaturalness: 0.25,
  });
  assert.equal(
    ballotWeightedScore({ rater: "ana", timbre: 5, accent: 4, languageNaturalness: 5 }),
    4.75,
  );
  assert.equal(
    ballotWeightedScore({ rater: "ana", timbre: 5, accent: 5, languageNaturalness: 4 }),
    4.75,
  );
  const ballots = ballotsFor(
    { timbre: 5, accent: 4, languageNaturalness: 5 },
    { timbre: 5, accent: 5, languageNaturalness: 5 },
  );
  const ballot = evaluateTimbreBallot(ballots, gateSubject());
  assert.equal(ballot.status, "FAIL", ballot.detail);
  assert.equal(ballot.weighted, 4.88, "the two raters' weighted scores average to 4.88");
  assert.match(ballot.detail, /accent/);
  assert.match(ballot.detail, /4\.88/);
  const gate = timbreGateFor({ humanRatings: ballots });
  assert.equal(gate.status, "FAIL", gate.detail);
  assert.match(gate.detail, /below five|4\.88/);
});

// ── Ticket 75: the third axis, language naturalness ─────────────────────────

test("the weighted result includes naturalness: changing only that axis changes the score and the verdict", () => {
  const es = resolveSubject({ voice: "lola" });
  assert.equal(es.locale, "es");

  const naturalness = (score: number): HumanRatings =>
    ballotsFor(
      { timbre: 5, accent: 5, languageNaturalness: score },
      { timbre: 5, accent: 5, languageNaturalness: score },
    );

  // 0.5×5 + 0.25×5 + 0.25×n, worked out independently of the implementation.
  const five = evaluateTimbreBallot(naturalness(5), es);
  assert.equal(five.status, "PASS", five.detail);
  assert.equal(five.weighted, 5);

  const four = evaluateTimbreBallot(naturalness(4), es);
  assert.equal(four.status, "FAIL", four.detail);
  assert.equal(four.weighted, 4.75, "naturalness is a quarter of the weighted ballot");
  assert.match(four.detail, /languageNaturalness/);
  assert.match(four.detail, /4\.75/);

  const three = evaluateTimbreBallot(naturalness(3), es);
  assert.equal(three.weighted, 4.5);
  assert.notEqual(three.weighted, four.weighted);
  assert.equal(timbreGateFor({ humanRatings: naturalness(4), subject: es }).status, "FAIL");
});

test("a Spanish subject's two-axis ballot is incomplete, never a renormalised pass", () => {
  const es = resolveSubject({ voice: "lola" });
  // A record built before the axis existed: five out of five on the two axes
  // it carries. Renormalisation would score it 5.00 and pass it.
  const twoAxis = ballotsFor({ timbre: 5, accent: 5 }, { timbre: 5, accent: 5 });

  const ballot = evaluateTimbreBallot(twoAxis, es);
  assert.equal(ballot.status, "FAIL", ballot.detail);
  assert.equal(ballot.weighted, null, "an incomplete ballot has no weighted score");
  assert.match(ballot.detail, /incomplete/i);
  assert.match(ballot.detail, /language naturalness/i);
  assert.match(ballot.detail, /ana, bob/);

  const gate = timbreGateFor({ humanRatings: twoAxis, subject: es });
  assert.equal(gate.status, "FAIL", gate.detail);
  assert.match(gate.detail, /incomplete/i);
});

test("filing a two-axis ballot for a bound Spanish subject is refused by name", () => {
  const es = resolveSubject({ voice: "lola" });
  const bound = bindBallotsToSubject(emptyHumanRatings(GATE_RECORDING), es);
  assert.throws(
    () => addHumanRating(bound, { rater: "ana", timbre: 5, accent: 5 }, GATE_RECORDING),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /incomplete/);
      assert.match(error.message, /languageNaturalness/);
      return true;
    },
  );

  const filed = addHumanRating(
    bound,
    { rater: "ana", timbre: 5, accent: 5, languageNaturalness: 5 },
    GATE_RECORDING,
  );
  assert.equal(filed.languageNaturalness, 5, "the third axis has its own mean");
  assert.equal(filed.weighted, 5);
});

test("English is the one named N/A: the axis renormalises with a stated reason and still reports its weight", () => {
  assert.equal(naturalnessApplies("en"), false);
  assert.equal(naturalnessApplies("es"), true);
  assert.equal(naturalnessApplies(null), true, "an unnamed Locale never drops an axis");

  const ballots = ballotsFor({ timbre: 5, accent: 5 }, { timbre: 5, accent: 5 });
  const ballot = evaluateTimbreBallot(ballots, gateSubject());
  assert.equal(ballot.status, "PASS", ballot.detail);
  assert.equal(ballot.weighted, 5, "timbre and accent renormalise over themselves for English");
  assert.match(ballot.detail, /language naturalness N\/A/);
  assert.match(ballot.detail, /featured baseline Locale/);

  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: measuredPass(),
    humanRatings: ballots,
    agentChannel: CLEAN_CHANNEL,
  });
  const axis = artifact.humanReview.axes.find((entry) => entry.axis === "languageNaturalness");
  assert.equal(axis?.status, "na");
  assert.equal(axis?.weight, 0.25, "the report keeps the axis's weight even where it is N/A");
  assert.match(axis?.reason ?? "", /English is the featured baseline Locale/);
  assert.equal(artifact.humanReview.counted, true);
  assert.equal(artifact.humanRatings.notApplicable?.languageNaturalness, NATURALNESS_NA_REASON);

  const report = formatHumanReview(artifact.humanReview);
  assert.match(report, /languageNaturalness: N\/A ×0\.25/);
  assert.match(report, /featured baseline/);
  assert.match(report, /timbre: 5\.0 mean ×0\.5/);
});

test("a ballot below five names the rater's stated reason and blocks", () => {
  let slots = addHumanRating(
    emptyHumanRatings(GATE_RECORDING),
    {
      rater: "ana",
      timbre: 4,
      accent: 5,
      reasons: { timbre: "thin upper register on the first sentence" },
    },
    GATE_RECORDING,
  );
  slots = addHumanRating(slots, { rater: "bob", timbre: 5, accent: 5 }, GATE_RECORDING);
  const ballot = evaluateTimbreBallot(slots, gateSubject());
  assert.equal(ballot.status, "FAIL");
  assert.match(ballot.detail, /thin upper register/);
  assert.equal(timbreGateFor({ humanRatings: slots }).status, "FAIL");
});

test("a ballot judged on another subject is never this subject's pass", () => {
  const lola = resolveSubject({ voice: "lola" });
  const ballots: HumanRatings = {
    ...ballotsFor({ timbre: 5, accent: 5 }, { timbre: 5, accent: 5 }),
    subject: lola,
  };
  const ballot = evaluateTimbreBallot(ballots, gateSubject());
  assert.equal(ballot.status, "FAIL", ballot.detail);
  assert.match(ballot.detail, /lola|another subject/i);
  const gate = timbreGateFor({ humanRatings: ballots });
  assert.equal(gate.status, "FAIL", gate.detail);
});

test("an artifact binds the ballots to its own subject and records the weighted score", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: measuredPass(),
    humanRatings: ballotsFor({ timbre: 5, accent: 5 }, { timbre: 5, accent: 5 }),
    agentChannel: CLEAN_CHANNEL,
  });
  const timbre = artifact.gates.find((gate) => gate.name === "timbre-probes");
  assert.equal(timbre?.status, "PASS", timbre?.detail);
  assert.equal(artifact.humanRatings.subject?.agent.kind, "demo");
  assert.equal(artifact.humanReview.subject, formatSubject(artifact.subject!));
  assert.equal(artifact.humanReview.weighted, 5);
  assert.equal(artifact.humanReview.counted, true);
  assert.match(formatHumanReview(artifact.humanReview), /weighted 5\.00\/5/);
});

// ── Ticket 10, slice 2: blind human slots ─────────────────────────────────

const RECORDING = "a".repeat(64);

test("human ratings need 1-5 ints, one ballot per rater, one shared recording", () => {
  assert.equal(HUMAN_RATERS_REQUIRED, 2);
  let slots = emptyHumanRatings(RECORDING);
  assert.equal(slots.timbre, null);
  assert.equal(slots.accent, null);
  assert.deepEqual(slots.ratings, []);
  slots = addHumanRating(slots, { rater: "ana", timbre: 5, accent: 4 }, RECORDING);
  assert.equal(slots.timbre, 5);
  assert.equal(slots.accent, 4);
  assert.throws(() => addHumanRating(slots, { rater: "ana", timbre: 4, accent: 4 }, RECORDING), /already rated/);
  assert.throws(
    () => addHumanRating(slots, { rater: "bob", timbre: 4, accent: 4 }, "b".repeat(64)),
    /same recording/,
  );
  for (const bad of [0, 6, 4.5]) {
    assert.throws(
      () => addHumanRating(slots, { rater: "bob", timbre: bad, accent: 4 }, RECORDING),
      /1-5/,
      `timbre ${bad} must throw`,
    );
    assert.throws(
      () => addHumanRating(slots, { rater: "bob", timbre: 4, accent: bad }, RECORDING),
      /1-5/,
      `accent ${bad} must throw`,
    );
  }
  assert.throws(() => addHumanRating(slots, { rater: "", timbre: 4, accent: 4 }, RECORDING), /rater/);
});

test("the human gate needs two raters at five out of five, after the measured result", () => {
  const none = emptyHumanRatings(RECORDING);
  const awaiting = evaluateHumanGate(true, none);
  assert.equal(awaiting.name, "accent-human");
  assert.equal(awaiting.status, "INFO");
  assert.ok(awaiting.detail.includes("awaiting"));
  const one = addHumanRating(
    none,
    { rater: "ana", timbre: 5, accent: 5, languageNaturalness: 5 },
    RECORDING,
  );
  assert.equal(evaluateHumanGate(true, one).status, "INFO", "one ballot is reported, never counted");
  // A four is a delivered judgement, not a missing one: it blocks.
  const four = addHumanRating(
    one,
    {
      rater: "bob",
      timbre: 4,
      accent: 4,
      languageNaturalness: 4,
      reasons: { timbre: "thin", accent: "marked", languageNaturalness: "reads as a translation" },
    },
    RECORDING,
  );
  assert.equal(evaluateHumanGate(true, four).status, "FAIL", "a ballot below five blocks");
  const two = addHumanRating(
    one,
    { rater: "bob", timbre: 5, accent: 5, languageNaturalness: 5 },
    RECORDING,
  );
  const counted = evaluateHumanGate(true, two);
  assert.equal(counted.status, "PASS");
  assert.match(counted.detail, /weighted 5\.00\/5/, counted.detail);
  const blocked = evaluateHumanGate(false, two);
  assert.equal(blocked.status, "INFO");
  assert.ok(blocked.detail.includes("auto"), `auto must pass first: ${blocked.detail}`);
});

test("auto timbre failure reports ballots but never counts them", () => {
  const two = addHumanRating(
    addHumanRating(emptyHumanRatings(RECORDING), { rater: "ana", timbre: 5, accent: 5 }, RECORDING),
    { rater: "bob", timbre: 5, accent: 5 },
    RECORDING,
  );
  const blocked = evaluateHumanGate(false, two);
  assert.equal(blocked.status, "INFO", "auto failure keeps the human slot INFO, never FAIL");
  assert.match(blocked.detail, /auto/);
  assert.match(blocked.detail, /2 ballots/);
  assert.match(blocked.detail, /reported, not counted/);
  assert.ok(blocked.detail.includes(RECORDING.slice(0, 12)), "the shared recording is named in the record");

  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout:
      'EVAL SUMMARY {"scenario":"greeting-cut","runs":1,"failures":0,' +
      '"scenarios":[{"name":"greeting-cut","passed":1,"runs":1}],' +
      '"traceSessions":["sess_subject"],"playout":[],"audioChunks":1,"live":true}\n',
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    probes: { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 },
    humanRatings: two,
    codeFingerprint: { head: "a".repeat(40), dirty: false, dirtyHash: "0".repeat(64) },
  });
  assert.equal(artifact.gates.find((g) => g.name === "timbre-probes")?.status, "FAIL");
  const human = artifact.gates.find((g) => g.name === "accent-human");
  assert.equal(human?.status, "INFO");
  assert.match(human?.detail ?? "", /reported, not counted/);
  // Ballots on a FAILed auto gate never make the run green.
  assert.equal(subjectGateVerdict(artifact).status, "FAIL");
});

test("artifact makes the shared-recording ballot protocol reviewable", () => {
  const two = addHumanRating(
    addHumanRating(emptyHumanRatings(RECORDING), { rater: "ana", timbre: 5, accent: 5 }, RECORDING),
    { rater: "bob", timbre: 5, accent: 5 },
    RECORDING,
  );
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: {
      reference: measuredTone("captures/reference-anna-en.wav", -23.1),
      delivered: measuredTone("captures/delivered-anna-en.wav", -23.2),
    },
    humanRatings: two,
    agentChannel: CLEAN_CHANNEL,
  });
  assert.equal(artifact.humanReview.recordingSha256, RECORDING);
  assert.equal(artifact.humanReview.raterCount, 2);
  assert.equal(artifact.humanReview.requiredRaters, HUMAN_RATERS_REQUIRED);
  assert.deepEqual(artifact.humanReview.raters, ["ana", "bob"]);
  assert.equal(artifact.humanReview.autoTimbrePassed, true);
  assert.equal(artifact.humanReview.counted, true);
  assert.match(artifact.humanReview.protocol, /blind/);
  assert.match(artifact.humanReview.protocol, /one shared/);
  const report = formatHumanReview(artifact.humanReview);
  assert.ok(report.includes(RECORDING), "report names the shared recording sha256");
  assert.match(report, /2\/2/);
  assert.match(report, /blind/);

  const blocked = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    probes: { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 },
    humanRatings: two,
  });
  assert.equal(blocked.humanReview.autoTimbrePassed, false);
  assert.equal(blocked.humanReview.counted, false);
  assert.match(formatHumanReview(blocked.humanReview), /not counted/);

  const unbound = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  assert.equal(unbound.humanReview.recordingSha256, null);
  assert.equal(unbound.humanReview.raterCount, 0);
  assert.match(formatHumanReview(unbound.humanReview), /--recording/);
});

test("a ballot below five blocks the timbre gate even on a measured pass", () => {
  const low = addHumanRating(
    addHumanRating(
      emptyHumanRatings(RECORDING),
      { rater: "ana", timbre: 1, accent: 1, reasons: { timbre: "robotic", accent: "wrong stress" } },
      RECORDING,
    ),
    { rater: "bob", timbre: 1, accent: 1, reasons: { timbre: "robotic", accent: "wrong stress" } },
    RECORDING,
  );
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    humanRatings: low,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: {
      reference: measuredTone("captures/reference-anna-en.wav", -23.1),
      delivered: measuredTone("captures/delivered-anna-en.wav", -23.1),
    },
    dryRun: true,
    codeFingerprint: { head: "a".repeat(40), dirty: false, dirtyHash: "0".repeat(64) },
  });
  const timbre = artifact.gates.find((g) => g.name === "timbre-probes");
  assert.equal(timbre?.status, "FAIL", "a ballot below five blocks the timbre gate");
  assert.match(timbre?.detail ?? "", /below five/);
  assert.match(timbre?.detail ?? "", /robotic/, "the rater's stated reason is recorded");
  const human = artifact.gates.find((g) => g.name === "accent-human");
  assert.equal(human?.status, "INFO", "a measured failure keeps the human slot reported, not counted");
  assert.match(human?.detail ?? "", /not counted/);
  assert.equal(subjectGateVerdict(artifact).status, "FAIL", "a below-five ballot is never a green run");

  const missing = evaluateHumanGate(true, emptyHumanRatings(RECORDING));
  assert.equal(missing.status, "INFO", "missing ballots stay INFO");
  assert.match(missing.detail, /awaiting/);
});

test("artifact carries human slots, the served level, and live timbre gates", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: 'heard: "Wait, stop."\n',
    exitCode: 0,
    durationMs: 1234,
    runs: 1,
    runBody: servedBody(SERVED_LEVEL),
    measuredLevel: {
      reference: measuredTone("captures/reference-anna-en.wav", -23.1),
      delivered: measuredTone("captures/delivered-anna-en.wav", -23.2),
    },
  });
  assert.equal(artifact.schemaVersion, 4);
  assert.equal(artifact.humanRatings.timbre, null);
  assert.equal(artifact.humanRatings.accent, null);
  assert.deepEqual(artifact.humanRatings.ratings, []);
  assert.equal(artifact.humanRatings.recordingSha256, null);
  assert.equal(artifact.loudness.outputVolume, SERVED_LEVEL);
  assert.equal(artifact.agentBody?.agentId, "agent_stored");
  assert.equal(artifact.loudness.measured.status, "PASS", artifact.loudness.measured.detail);
  assert.equal(artifact.loudness.measured.deliveredFile, "captures/delivered-anna-en.wav");
  assert.ok(artifact.loudness.ok);
  // A measured result with no ballot is INFO/unmeasured, never a timbre PASS
  // (ticket 74): the machine half alone cannot green the gate.
  const timbre = artifact.gates.find((g) => g.name === "timbre-probes");
  assert.equal(timbre?.status, "INFO", timbre?.detail);
  assert.match(timbre?.detail ?? "", /awaiting the weighted ballot/);
  const human = artifact.gates.find((g) => g.name === "accent-human");
  assert.equal(human?.status, "INFO");
});

test("artifact timbre gate fails named defects and holds human ratings until auto passes", () => {
  const clipped = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    probes: { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 },
    humanRatings: addHumanRating(
      addHumanRating(emptyHumanRatings(RECORDING), { rater: "ana", timbre: 5, accent: 5 }, RECORDING),
      { rater: "bob", timbre: 5, accent: 5 },
      RECORDING,
    ),
  });
  assert.equal(clipped.gates.find((g) => g.name === "timbre-probes")?.status, "FAIL");
  const human = clipped.gates.find((g) => g.name === "accent-human");
  assert.equal(human?.status, "INFO");
  assert.ok(human?.detail.includes("auto"));
});

// ── Ticket 10, slice 3: voice regression matrix ────────────────────────────

test("tag discipline reuses the shared tag vocabulary: once exactly, never spelled, never invented", () => {
  const clean = analyzeTagMentions(["send an email with Lime 42 in the subject"], "Lime 42");
  assert.equal(clean.saidOnceExactly, true);
  assert.equal(clean.digitSpelled, false);
  assert.deepEqual(clean.invented, []);
  const twice = analyzeTagMentions(["Lime 42 here", "and Lime 42 again"], "Lime 42");
  assert.equal(twice.saidOnceExactly, false);
  const hyphen = analyzeTagMentions(["subject: Lime-42 please"], "Lime 42");
  assert.equal(hyphen.saidOnceExactly, true);
  const spelled = analyzeTagMentions(["your tag is Lime four two"], "Lime 42");
  assert.equal(spelled.digitSpelled, true);
  assert.equal(spelled.saidOnceExactly, false);
  const split = analyzeTagMentions(["your tag is Lime 4 2"], "Lime 42");
  assert.equal(split.digitSpelled, true);
  const invented = analyzeTagMentions(["your tag is Coral 17"], "Lime 42");
  assert.ok(invented.invented.includes("coral 17"), `invented tag caught: ${invented.invented}`);
  assert.equal(invented.saidOnceExactly, false);
  const missing = analyzeTagMentions(["we never said any tag"], "Lime 42");
  assert.equal(missing.saidOnceExactly, false);
});

test("regression voices pass clean and fail named: clip, invented tag, tag count, digit spelling", () => {
  const clean = checkRegressionVoice({
    voice: "lola",
    isGate: false,
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    tag: { saidOnceExactly: true, digitSpelled: false, invented: [] },
  });
  assert.equal(clean.status, "PASS");
  const clipped = checkRegressionVoice({
    voice: "lola",
    isGate: false,
    probes: { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 },
    tag: { saidOnceExactly: true, digitSpelled: false, invented: [] },
  });
  assert.equal(clipped.status, "FAIL");
  assert.ok(clipped.detail.includes("clip"));
  const invented = checkRegressionVoice({
    voice: "lola",
    isGate: false,
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    tag: { saidOnceExactly: false, digitSpelled: false, invented: ["coral 17"] },
  });
  assert.equal(invented.status, "FAIL");
  assert.ok(invented.detail.includes("coral 17"));
  const missing = checkRegressionVoice({
    voice: "lola",
    isGate: false,
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    tag: { saidOnceExactly: false, digitSpelled: false, invented: [] },
  });
  assert.equal(missing.status, "FAIL");
  assert.ok(missing.detail.includes("exactly once"));
  const spelled = checkRegressionVoice({
    voice: "lola",
    isGate: true,
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    tag: { saidOnceExactly: false, digitSpelled: true, invented: [] },
  });
  assert.equal(spelled.status, "FAIL");
  assert.ok(spelled.detail.includes("digit by digit"));
});

test("matrix voices resolve through the registry, never as literals", () => {
  assert.deepEqual(resolveMatrixVoices(""), [...DEMO_VOICE_IDS]);
  assert.deepEqual(resolveMatrixVoices("lola,giovanni"), ["lola", "giovanni"]);
  assert.deepEqual(resolveMatrixVoices("lola, lola"), ["lola"]);
  assert.throws(() => resolveMatrixVoices("lola,nope"), /unknown gate voice/);
});

/** One matrix row's run: a real artifact carrying the row's subject and gates. */
function matrixRun(input: {
  voice: string;
  subject: SubjectRecord;
  gates: ScoreboardGate[];
  clip?: number;
  runId?: string;
}): ScoreboardArtifact {
  const artifact = buildSkeletonArtifact({
    voice: input.voice,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
    subject: input.subject,
    // A verdict answers to the code it ran (ticket 117): rows without a
    // fingerprint would be blocked before any gate could be judged.
    codeFingerprint: { head: "a".repeat(40), dirty: false, dirtyHash: "0".repeat(64) },
    ...(input.runId ? { runId: input.runId } : {}),
    probes: { jump: 0, overload: 0, clip: input.clip ?? 0, underrun: 0, inputDrop: 0 },
  });
  return {
    ...artifact,
    gates: input.gates,
    transcripts: { ...artifact.transcripts, redacted: ["send it with Lime 42 in the subject"] },
  };
}

/** One matrix row's run with a single gate that decides its verdict. */
function judgedRun(
  subject: SubjectRecord,
  voice: string,
  status: "PASS" | "FAIL" = "PASS",
): ScoreboardArtifact {
  return matrixRun({
    voice,
    subject,
    gates:
      status === "PASS"
        ? [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }]
        : [{ name: "barge-in-cut", status: "FAIL", detail: "cut 1841ms exceeds 1500ms" }],
  });
}

test("each matrix row derives its gate verdict from its own subject artifact", () => {
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const annaRun = matrixRun({
    voice: "anna",
    subject: anna,
    gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }],
  });
  const lolaRun = matrixRun({
    voice: "lola",
    subject: lola,
    gates: [{ name: "barge-in-cut", status: "FAIL", detail: "cut 1841ms exceeds 1500ms" }],
  });

  const matrix = buildRegressionMatrix({
    entries: [
      { subject: anna, artifact: annaRun },
      { subject: lola, artifact: lolaRun },
    ],
  });

  const annaRow = matrix.results.find((row) => sameSubject(row.subject, anna));
  const lolaRow = matrix.results.find((row) => sameSubject(row.subject, lola));
  assert.equal(annaRow?.status, "PASS", annaRow?.detail);
  assert.equal(lolaRow?.status, "FAIL", lolaRow?.detail);
  assert.equal(annaRow?.verdict?.runId, annaRun.runId);
  assert.equal(lolaRow?.verdict?.runId, lolaRun.runId);
  assert.deepEqual(lolaRow?.verdict?.failing, ["barge-in-cut"]);
  assert.equal("gate" in matrix, false, "no carried featured-voice verdict survives");
  assert.equal("gateVoice" in matrix, false, "the matrix is not voice-keyed");

  const table = formatMatrixTable(matrix);
  assert.match(table, /demo anna \(en, browser\)/, table);
  assert.match(table, /demo lola \(es, browser\)/, table);
  assert.match(table, /1\/2 clean/, table);
});

test("a failing subject cannot borrow the featured voice's passing verdict", () => {
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const passing = (subject: SubjectRecord, voice: string) =>
    matrixRun({
      voice,
      subject,
      gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }],
    });
  const failing = (subject: SubjectRecord, voice: string) =>
    matrixRun({
      voice,
      subject,
      gates: [{ name: "barge-in-cut", status: "FAIL", detail: "cut 1841ms exceeds 1500ms" }],
    });

  // The featured voice passes and a non-featured subject fails: the failure
  // stays red.
  const featuredGreen = buildRegressionMatrix({
    entries: [
      { subject: anna, artifact: passing(anna, "anna") },
      { subject: lola, artifact: failing(lola, "lola") },
    ],
  });
  assert.equal(featuredGreen.results.find((row) => sameSubject(row.subject, anna))?.status, "PASS");
  assert.equal(featuredGreen.results.find((row) => sameSubject(row.subject, lola))?.status, "FAIL");
  assert.equal(featuredGreen.gates.find((gate) => gate.name === "matrix")?.status, "FAIL");

  // And the reverse: a red featured voice never hands its verdict to a clean
  // subject's row — since ticket 78 that row is not judged at all.
  const featuredRed = buildRegressionMatrix({
    entries: [
      { subject: anna, artifact: failing(anna, "anna") },
      { subject: lola, artifact: passing(lola, "lola") },
    ],
  });
  assert.equal(featuredRed.results.find((row) => sameSubject(row.subject, anna))?.status, "FAIL");
  const blockedLola = featuredRed.results.find((row) => sameSubject(row.subject, lola));
  assert.equal(blockedLola?.status, "BLOCKED");
  assert.equal(blockedLola?.verdict, null, "a clean run is not judged before the featured subject passes");
  assert.equal(featuredRed.gates.find((gate) => gate.name === "matrix")?.status, "FAIL");
});

test("featured first: a failing featured subject blocks a non-English subject from being judged", () => {
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const matrix = buildRegressionMatrix({
    entries: [
      { subject: lola, artifact: judgedRun(lola, "lola") },
      { subject: anna, artifact: judgedRun(anna, "anna", "FAIL") },
    ],
  });

  const lolaRow = matrix.results.find((row) => sameSubject(row.subject, lola));
  assert.equal(lolaRow?.status, "BLOCKED", "a non-English subject is not judged on an unproved instrument");
  assert.equal(lolaRow?.verdict, null, "blocked means no verdict was derived");
  assert.match(
    lolaRow?.detail ?? "",
    /blocked: featured subject demo anna \(en, browser\) has not passed/,
  );
  const table = formatMatrixTable(matrix);
  assert.match(table, /BLOCK\s+demo lola \(es, browser\).*blocked: featured subject demo anna/);
});

test("featured first: once the featured subject passes, non-English subjects are judged normally", () => {
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const matrix = buildRegressionMatrix({
    entries: [
      { subject: anna, artifact: judgedRun(anna, "anna") },
      { subject: lola, artifact: judgedRun(lola, "lola", "FAIL") },
    ],
  });

  const lolaRow = matrix.results.find((row) => sameSubject(row.subject, lola));
  assert.equal(lolaRow?.status, "FAIL", "after anna passes the Locale row is judged on its own run");
  assert.ok(lolaRow?.verdict, "the judged row cites its own run");
  assert.doesNotMatch(lolaRow?.detail ?? "", /blocked:/);
});

test("featured first: a missing featured run blocks every other subject by name", () => {
  const lola = resolveSubject({ voice: "lola" });
  const matrix = buildRegressionMatrix({
    entries: [{ subject: lola, artifact: judgedRun(lola, "lola") }],
  });

  const lolaRow = matrix.results.find((row) => sameSubject(row.subject, lola));
  assert.equal(lolaRow?.status, "BLOCKED");
  assert.equal(lolaRow?.verdict, null);
  assert.match(lolaRow?.detail ?? "", /blocked: featured subject demo anna \(en, browser\) has not passed/);
  assert.equal(matrix.ordering.featuredStatus, null, "no featured row means the gate never opened");
});

test("featured first: an English non-featured subject is ordered by the same rule", () => {
  const anna = resolveSubject({ voice: "anna" });
  const tenant = resolveSubject({ agent: "agent_en_1", voice: "alba", locale: "en" });
  const blocked = buildRegressionMatrix({
    entries: [
      { subject: anna, artifact: judgedRun(anna, "anna", "FAIL") },
      { subject: tenant, artifact: judgedRun(tenant, "alba") },
    ],
  });
  const blockedTenant = blocked.results.find((row) => sameSubject(row.subject, tenant));
  assert.equal(blockedTenant?.status, "BLOCKED", "ordering is not a locale rule: English rows wait too");
  assert.equal(blockedTenant?.verdict, null);

  const judged = buildRegressionMatrix({
    entries: [
      { subject: anna, artifact: judgedRun(anna, "anna") },
      { subject: tenant, artifact: judgedRun(tenant, "alba") },
    ],
  });
  assert.equal(judged.results.find((row) => sameSubject(row.subject, tenant))?.status, "PASS");
});

test("featured first: the artifact records the ordering rule and the featured row leads", () => {
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const matrix = buildRegressionMatrix({
    entries: [
      { subject: lola, artifact: judgedRun(lola, "lola") },
      { subject: anna, artifact: judgedRun(anna, "anna", "FAIL") },
    ],
  });

  assert.equal(matrix.ordering.rule, "featured-first");
  assert.equal(matrix.ordering.featuredStatus, "FAIL");
  assert.deepEqual(matrix.ordering.blocked, [subjectRowKey(lola)]);
  assert.match(matrix.ordering.detail, /featured subject demo anna \(en, browser\) has not passed/);
  assert.equal(matrix.results[0]?.isFeatured, true, "the featured row is ordered first");
  assert.equal(matrix.subjects[0]?.agent.kind, "demo");
  assert.match(formatMatrixTable(matrix), /ordering featured-first/);
  const orderingGate = matrix.gates.find((gate) => gate.name === "ordering:featured-first");
  assert.equal(orderingGate?.status, "FAIL");
  assert.match(orderingGate?.detail ?? "", /blocked: featured subject demo anna/);
});

test("featured first: a passing featured run opens the gate and leaves no subject blocked", () => {
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const matrix = buildRegressionMatrix({
    entries: [
      { subject: lola, artifact: judgedRun(lola, "lola") },
      { subject: anna, artifact: judgedRun(anna, "anna") },
    ],
  });
  assert.equal(matrix.ordering.featuredStatus, "PASS");
  assert.deepEqual(matrix.ordering.blocked, []);
  assert.ok(matrix.results.every((row) => row.status !== "BLOCKED"));
  assert.equal(matrix.gates.find((gate) => gate.name === "ordering:featured-first")?.status, "PASS");
});

test("a tenant subject and its demo voice are distinct rows with their own verdicts", () => {
  const demo = resolveSubject({ voice: "lola" });
  const tenant = resolveSubject({ agent: "agent_tenant_1", voice: "lola", locale: "es" });
  const demoRun = matrixRun({
    voice: "lola",
    subject: demo,
    runId: "run-demo-lola",
    gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }],
  });
  const tenantRun = matrixRun({
    voice: "lola",
    subject: tenant,
    runId: "run-tenant-1",
    gates: [{ name: "barge-in-cut", status: "FAIL", detail: "cut 1841ms exceeds 1500ms" }],
  });

  const anna = resolveSubject({ voice: "anna" });
  const matrix = buildRegressionMatrix({
    entries: [
      // The featured subject opens the ordering gate (ticket 78), so the
      // tenant/demo distinction below is what decides these rows.
      { subject: anna, artifact: judgedRun(anna, "anna") },
      { subject: demo, artifact: demoRun },
      { subject: tenant, artifact: tenantRun },
    ],
  });
  assert.equal(matrix.results.length, 3);
  const demoRow = matrix.results.find((row) => sameSubject(row.subject, demo));
  const tenantRow = matrix.results.find((row) => sameSubject(row.subject, tenant));
  assert.equal(demoRow?.status, "PASS");
  assert.equal(tenantRow?.status, "FAIL");
  assert.notEqual(demoRow?.label, tenantRow?.label);
  assert.match(formatMatrixTable(matrix), /tenant agent_tenant_1 \(es, browser\)/);
  // The demo row's verdict is not reachable through the tenant row.
  assert.equal(tenantRow?.verdict?.runId, tenantRun.runId);
  assert.notEqual(tenantRow?.verdict?.runId, demoRow?.verdict?.runId);
});

test("a missing subject run is reported missing, never copied from another row", () => {
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const annaRun = matrixRun({
    voice: "anna",
    subject: anna,
    gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }],
  });

  const matrix = buildRegressionMatrix({
    entries: [{ subject: anna, artifact: annaRun }, { subject: lola }],
  });
  const lolaRow = matrix.results.find((row) => sameSubject(row.subject, lola));
  assert.equal(lolaRow?.status, "MISSING");
  assert.equal(lolaRow?.verdict, null, "no artifact, no verdict to inherit");
  assert.equal(lolaRow?.probes, null);
  assert.match(lolaRow?.detail ?? "", /MISSING/);
  assert.equal(matrix.gates.find((gate) => gate.name === "matrix")?.status, "FAIL");
  assert.match(formatMatrixTable(matrix), /MISS\s+demo lola \(es, browser\).*MISSING/);
});

test("matrix rows read gates only from their own subject artifact", () => {
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const annaGates = [{ name: "plumbing", status: "PASS" as const, detail: "eval runner finished" }];
  const lolaGates = [{ name: "timbre-probes", status: "FAIL" as const, detail: "clip 1 > 0" }];
  const matrix = buildRegressionMatrix({
    entries: [
      { subject: anna, artifact: matrixRun({ voice: "anna", subject: anna, gates: annaGates }) },
      { subject: lola, artifact: matrixRun({ voice: "lola", subject: lola, gates: lolaGates }) },
    ],
  });
  const annaRow = matrix.results.find((row) => sameSubject(row.subject, anna));
  const lolaRow = matrix.results.find((row) => sameSubject(row.subject, lola));
  assert.deepEqual(annaRow?.verdict?.gates, annaGates);
  assert.deepEqual(lolaRow?.verdict?.gates, lolaGates);
  assert.ok(!annaRow?.verdict?.gates.some((gate) => gate.name === "timbre-probes"));
  assert.ok(lolaRow?.verdict?.failing.includes("timbre-probes"));
});

test("a matrix row refuses an artifact from another subject", () => {
  const anna = resolveSubject({ voice: "anna" });
  const lola = resolveSubject({ voice: "lola" });
  const lolaRun = matrixRun({
    voice: "lola",
    subject: lola,
    gates: [{ name: "plumbing", status: "PASS", detail: "eval runner finished" }],
  });
  assert.throws(
    () => buildRegressionMatrix({ entries: [{ subject: anna, artifact: lolaRun }] }),
    /only reads its own subject's run/,
    "a passing artifact from another subject is never a row's own verdict",
  );
});

// ── Review fixes: harness break, measurements, memory INFO, attribution, sub-scores ──

test("shared probe validator accepts zeros and rejects bad counts", () => {
  assert.deepEqual(
    validateProbeCounts({ jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 }, "src"),
    { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
  );
  assert.deepEqual(
    validateProbeCounts({}, "src"),
    { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
  );
  assert.throws(() => validateProbeCounts({ jump: -1 }, "src"), /probe count "jump" must be a non-negative int/);
  assert.throws(() => validateProbeCounts({ clip: 1.5 }, "src"), /probe count "clip" must be a non-negative int/);
  assert.throws(() => validateProbeCounts({ inputDrop: "x" }, "src"), /probe count "inputDrop" must be a non-negative int/);
});

test("harness break: non-dry runner crash fails plumbing and marks the eval runner failed", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 1,
    durationMs: 10,
    runs: 1,
    gaps: { "greeting-cut": [900] },
  });
  const plumbing = artifact.gates.find((g) => g.name === "plumbing")!;
  assert.equal(plumbing.status, "FAIL");
  assert.match(plumbing.detail, /harness break/);
  assert.equal(artifact.evalRunner.status, "failed");
  assert.equal(artifact.evalRunner.passed, false);
  assert.equal(artifact.evalRunner.exitCode, 1);
});

/** One machine-readable runner summary, the signal the scoreboard classifies. */
function evalSummary(overrides: Record<string, unknown> = {}): string {
  return `EVAL SUMMARY ${JSON.stringify({
    scenario: "stop-over",
    runs: 1,
    failures: 1,
    scenarios: [{ name: "stop-over", passed: 0, runs: 1 }],
    traceSessions: ["sess_switch06"],
    playout: [{ scenario: "stop-over", run: 1, wallClockMs: 8123 }],
    audioChunks: 42,
    live: true,
    ...overrides,
  })}`;
}

test("a finished eval run is plumbing health even when its scenarios fail", () => {
  const legacy = classifyRunnerOutcome({
    stdout: "  ✗ stop-over #1: cut too late: 1841ms\nstop-over: 0/1\n",
    exitCode: 1,
  });
  assert.equal(legacy.status, "finished");
  assert.equal(legacy.reason, null);
  assert.deepEqual(legacy.scenarios, [{ name: "stop-over", passed: 0, runs: 1 }]);
  assert.match(legacy.detail, /finished/);

  const summary = classifyRunnerOutcome({ stdout: `${evalSummary()}\n`, exitCode: 1 });
  assert.equal(summary.status, "finished");
  assert.equal(summary.summary?.failures, 1);
  assert.deepEqual(summary.summary?.playout, [{ scenario: "stop-over", run: 1, wallClockMs: 8123 }]);
});

test("spawn failure, a kill, a crash, and a summary-less exit are harness breaks", () => {
  assert.equal(
    classifyRunnerOutcome({ stdout: "", exitCode: null, error: "spawn npm ENOENT" }).reason,
    "spawn-failed",
  );
  assert.equal(classifyRunnerOutcome({ stdout: "", exitCode: null }).reason, "killed");
  assert.equal(classifyRunnerOutcome({ stdout: "partial output", exitCode: 1 }).reason, "crashed");
  assert.equal(classifyRunnerOutcome({ stdout: "", exitCode: 0 }).reason, "missing-summary");
});

test("a finished run with no Call trace session or no agent audio is a harness break", () => {
  const noTrace = classifyRunnerOutcome({
    stdout: `${evalSummary({ traceSessions: [] })}\n`,
    exitCode: 1,
  });
  assert.equal(noTrace.status, "harness-break");
  assert.equal(noTrace.reason, "missing-trace");
  assert.match(noTrace.detail, /missing trace/);

  const noAudio = classifyRunnerOutcome({
    stdout: `${evalSummary({ audioChunks: 0 })}\n`,
    exitCode: 1,
  });
  assert.equal(noAudio.status, "harness-break");
  assert.equal(noAudio.reason, "missing-audio");
  assert.match(noAudio.detail, /missing audio/);
});

test("a scenario FAIL stays plumbing PASS while a measured gate FAIL stays judgment", () => {
  const stdout = [
    "  · trace session sess_switch06",
    "    cut 1841ms after the caller started",
    '    verdict ["yield","Wait, stop."]',
    "  ✗ stop-over #1: cut too late: 1841ms",
    "stop-over: 0/1",
    evalSummary(),
    "",
  ].join("\n");
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: stdout,
    exitCode: 1,
    durationMs: 9000,
    runs: 1,
    realCutEvidencePresent: true,
  });
  const judged = applyRealCutGate(artifact, {
    cutMs: 1841,
    verdict: "yield",
    verdictSource: "judge",
    answered: false,
    resumed: false,
    ended: false,
    traceTurn: null,
  });
  assert.equal(judged.gates.find((g) => g.name === "plumbing")?.status, "PASS");
  assert.equal(judged.evalRunner.status, "ok");
  assert.equal(judged.evalRunner.breakReason, null);
  assert.equal(judged.gates.find((g) => g.name === "barge-in-cut")?.status, "FAIL");
});

test("a missing trace is a harness break in the artifact, distinct from a gate FAIL", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: `${evalSummary({ traceSessions: [] })}\nstop-over: 0/1\n`,
    exitCode: 1,
    durationMs: 9000,
    runs: 1,
    gaps: { "real-cut-answered": [900] },
  });
  const plumbing = artifact.gates.find((g) => g.name === "plumbing")!;
  assert.equal(plumbing.status, "FAIL");
  assert.match(plumbing.detail, /missing trace/);
  assert.equal(artifact.evalRunner.status, "failed");
  assert.equal(artifact.evalRunner.breakReason, "missing-trace");
  assert.equal(artifact.gates.find((g) => g.name === "reply-gap")?.status, "PASS");
  assert.match(formatEvalRunnerReport(artifact), /HARNESS BREAK \(missing-trace\).*not a gate FAIL/);
});

test("live scenario playout is reported separately from gate verdicts", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: `${evalSummary()}\nstop-over: 0/1\n`,
    exitCode: 1,
    durationMs: 9000,
    runs: 1,
  });
  assert.equal(artifact.gates.find((g) => g.name === "plumbing")?.status, "PASS");
  assert.deepEqual(artifact.evalRunner.timings.scenarioRuns, [
    { scenario: "stop-over", run: 1, wallClockMs: 8123 },
  ]);
  assert.ok(artifact.gates.every((gate) => gate.name !== "playout"));
  const report = formatEvalRunnerReport(artifact);
  assert.match(report, /plumbing PASS/);
  assert.match(report, /playout \(wall clock, never gated\): stop-over #1 8123ms/);
});

test("dry run records a skipped eval runner and keeps plumbing green", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "(dry run: eval runner skipped)",
    exitCode: null,
    durationMs: 0,
    runs: 1,
    dryRun: true,
  });
  assert.equal(artifact.gates.find((g) => g.name === "plumbing")?.status, "PASS");
  assert.equal(artifact.evalRunner.status, "skipped");
  assert.equal(artifact.evalRunner.passed, null);
});

test("non-dry run with zero measured evidence fails measurements with the exact message", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  const gate = artifact.gates.find((g) => g.name === "measurements")!;
  assert.equal(gate.status, "FAIL");
  assert.equal(gate.detail, "no measurements - run real audio or pass evidence flags");
});

test("dry run with zero measured evidence stays INFO for backward compatibility", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
  });
  assert.ok(artifact.gates.every((g) => g.status !== "FAIL"));
  assert.equal(artifact.gates.find((g) => g.name === "measurements")?.status, "INFO");
});

test("measured evidence silences the measurements gate", () => {
  assert.equal(hasMeasuredEvidence({}), false);
  assert.equal(hasMeasuredEvidence({ gaps: { "greeting-cut": [900] } }), true);
  assert.equal(hasMeasuredEvidence({ traceGaps: [{ gapMs: 900, turnIndex: 1 }] }), true);
  assert.equal(hasMeasuredEvidence({ doubleTalkOverlapMs: [120] }), true);
  assert.equal(hasMeasuredEvidence({ doubleTalkOverlapMs: [] }), false);
  assert.equal(
    hasMeasuredEvidence({ endCallDrain: { goodbyeCoverage: null, hangUpDelayMs: null, narratedEnding: false } }),
    false,
  );
  assert.equal(
    hasMeasuredEvidence({ endCallDrain: { goodbyeCoverage: 0.95, hangUpDelayMs: null, narratedEnding: false } }),
    true,
  );
});

test("evidence provenance names only inputs that carry observed values", () => {
  assert.deepEqual(measuredEvidenceSources({}), []);
  assert.deepEqual(measuredEvidenceSources({ gaps: { "greeting-cut": [] } }), []);
  assert.deepEqual(measuredEvidenceSources({ overheardAsides: [] }), []);
  assert.deepEqual(
    measuredEvidenceSources({ deadAir: { gapsMs: [], longestSilenceMs: null, checkIns: [] } }),
    [],
  );
  assert.deepEqual(measuredEvidenceSources({ gaps: { "greeting-cut": [900] } }), ["gaps"]);
  assert.deepEqual(measuredEvidenceSources({ traceGaps: [{ gapMs: 900, turnIndex: 1 }] }), ["trace-gaps"]);
  assert.deepEqual(
    measuredEvidenceSources({ probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 } }),
    ["timbre-probes"],
  );
  assert.deepEqual(
    measuredEvidenceSources({ gaps: { "greeting-cut": [900] }, doubleTalkOverlapMs: [120] }),
    ["gaps", "double-talk"],
  );
  assert.deepEqual(measuredEvidenceSources({ emailInviteEvidencePresent: true }), ["email-invite"]);
  // Empty containers never flip the measurements gate: only values observed count.
  assert.equal(hasMeasuredEvidence({ overheardAsides: [] }), false);
  assert.equal(hasMeasuredEvidence({ deadAir: { gapsMs: [], longestSilenceMs: null, checkIns: [] } }), false);
});

test("email memory unmeasured is INFO, persisted is PASS, mismatch is FAIL", () => {
  assert.equal(
    persistsEmailAcrossMemory({ agentLines: [], chipShows: [], showToolCalls: 0 }),
    null,
  );
  const unmeasured = evaluateEmailInvite({
    agentLines: [FRESH_INVITE],
    chipShows: [{ address: "test@voni.cc", tag: EMAIL_INVITE_TAG }],
    showToolCalls: 1,
  });
  assert.equal(unmeasured.memoryPersists, null);
  assert.equal(unmeasured.status, "PASS");
  const info = emailInviteGate(unmeasured);
  assert.equal(info.status, "INFO");
  assert.equal(info.detail, "unmeasured - provide a before/after Hold return pair");
  const kept = emailInviteGate(evaluateEmailInvite(freshEvidence()));
  assert.equal(kept.status, "PASS");
  const lost = emailInviteGate(evaluateEmailInvite(freshEvidence({ memoryInvitedAfter: false })));
  assert.equal(lost.status, "FAIL");
});

test("applying unmeasured email evidence scores the beat INFO, not PASS", () => {
  const base = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "invite-tag",
    runnerStdout: FRESH_INVITE,
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
  });
  const scored = applyEmailInvite(base, {
    agentLines: [FRESH_INVITE],
    chipShows: [{ address: "test@voni.cc", tag: EMAIL_INVITE_TAG }],
    showToolCalls: 1,
  });
  assert.equal(scored.emailInvite?.memoryPersists, null);
  assert.equal(scored.gates.find((g) => g.name === "email-invite")?.status, "INFO");
  assert.equal(scored.beats["email-invite"].status, "INFO");
});

test("first trace turn attributes to greeting-cut only with an explicit beat or a greeting marker", () => {
  const mapped = attributeFirstTraceGap(['12.20s  VONI    "Sorry"  (reply_create gap 900ms)'], {
    beatMap: "real-cut-answered",
  });
  assert.equal(mapped.beat, "real-cut-answered");
  assert.equal(mapped.verified, true);
  const anchored = attributeFirstTraceGap([
    '12.10s  HEARD   "Wait, stop."',
    '12.20s  VONI    "Hi, thanks for calling"  (reply_create gap 900ms)  greeting-cut marker',
  ]);
  assert.equal(anchored.beat, "greeting-cut");
  assert.equal(anchored.verified, true);
  const unverified = attributeFirstTraceGap([
    '12.10s  HEARD   "Wait, stop."',
    '12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)',
  ]);
  assert.equal(unverified.beat, null);
  assert.equal(unverified.verified, false);
  assert.match(unverified.note, /trace attribution unverified/);
});

test("explicit beat mapping never overrides a trace that opens with the greeting cut", () => {
  const greetingOpening = [
    '0.10s  HEARD   "Hi, this is Anna."  (0.00s-1.00s)',
    '0.90s  VONI    "Hi, thanks for calling"  (reply_create gap 900ms)  greeting-cut marker',
  ];
  const dominated = attributeFirstTraceGap(greetingOpening, { beatMap: "real-cut-answered" });
  assert.equal(dominated.beat, "greeting-cut");
  assert.equal(dominated.verified, true);
  assert.match(dominated.note, /opens with the greeting cut/);

  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceGaps: [{ gapMs: 900, turnIndex: 1 }],
    traceExcerpt: greetingOpening,
    traceBeat: "real-cut-answered",
    traceSessionId: "sess_abc",
  });
  assert.deepEqual(artifact.beats["greeting-cut"].gapSamples, [900]);
  assert.deepEqual(artifact.beats["real-cut-answered"].gapSamples, []);

  // Without a greeting opening, the explicit map still does its job.
  const nonGreeting = attributeFirstTraceGap(
    ['12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)'],
    { beatMap: "real-cut-answered" },
  );
  assert.equal(nonGreeting.beat, "real-cut-answered");
});

test("unattributed trace gaps stay call-level with an INFO greeting-cut beat, never a PASS", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceGaps: [{ gapMs: 900, turnIndex: 1 }],
    traceExcerpt: ['12.20s  VONI    "Sorry about that"  (reply_create gap 900ms)'],
    traceSessionId: "sess_abc",
  });
  assert.deepEqual(artifact.beats["greeting-cut"].gapSamples, []);
  assert.equal(artifact.beats["greeting-cut"].status, "INFO");
  assert.match(artifact.beats["greeting-cut"].note, /trace attribution unverified/);
  const reply = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(reply.status, "PASS");
  assert.match(reply.detail, /trace attribution unverified/);
});

test("greeting-cut marker attributes the first trace turn to the greeting-cut beat", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "trace",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    traceGaps: [{ gapMs: 900, turnIndex: 1 }],
    traceExcerpt: ['12.20s  VONI    "Hi"  (reply_create gap 900ms)  greeting-cut marker'],
    traceSessionId: "sess_abc",
  });
  assert.deepEqual(artifact.beats["greeting-cut"].gapSamples, [900]);
});

test("sub-scores aggregate the five human-likeness areas in spec priority", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    runBody: runBodyOf(SERVED_LEVEL, { fingerprint: null }),
    gaps: { "greeting-cut": [900] },
    doubleTalkOverlapMs: [120, 650],
  });
  const subs = buildSubScores(artifact.gates);
  assert.deepEqual(
    subs.map((s) => s.name),
    ["responsiveness", "barge-in", "overheard", "naturalness", "voice"],
  );
  assert.equal(subs[0].status, "PASS");
  assert.equal(subs[3].status, "FAIL");
  assert.ok(subs[3].detail.includes("650"));
  assert.equal(artifact.subScores.length, 5);
  const table = formatSubScoreTable(artifact);
  for (const name of ["responsiveness", "barge-in", "overheard", "naturalness", "voice"]) {
    assert.ok(table.includes(name), `sub-score table names ${name}`);
  }
});

test("gates report in spec priority: gap, cut, overheard, naturalness", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
  });
  const order = artifact.gates.map((g) => g.name);
  const before = (a: string, b: string) => {
    assert.ok(order.indexOf(a) !== -1 && order.indexOf(b) !== -1, `${a} and ${b} present`);
    assert.ok(order.indexOf(a) < order.indexOf(b), `${a} reports before ${b}`);
  };
  before("plumbing", "reply-gap");
  before("reply-gap", "barge-in-cut");
  before("barge-in-cut", "overheard-recall");
  before("overheard-recall", "double-talk");
  before("double-talk", "dead-air");
  before("dead-air", "timbre-probes");
});

test("artifact records a run id with an empty beat-quarantine stub", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
  });
  assert.ok(typeof artifact.runId === "string" && artifact.runId.length > 0);
  assert.deepEqual(artifact.quarantinedBeats, []);
  const named = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
    runId: "run-manual",
  });
  assert.equal(named.runId, "run-manual");
  // Tests inject the fingerprint; the real CLI reads it from git.
  const injected: CodeFingerprint = { head: "a".repeat(40), dirty: true, dirtyHash: sha256Hex("dirty") };
  const fingerprinted = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
    codeFingerprint: injected,
  });
  assert.deepEqual(fingerprinted.codeFingerprint, injected);
});

test("manual and external checks stay INFO, never a false green", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "ok",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
    dryRun: true,
  });
  const phone = artifact.gates.find((g) => g.name === "phone-checklist")!;
  assert.equal(phone.status, "INFO");
  assert.match(phone.detail, /manual/);
  const pinned = artifact.gates.find((g) => g.name === "talk-hold-pinned")!;
  assert.equal(pinned.status, "INFO");
  assert.match(pinned.detail, /externally|pinned/);
});

// ── Ticket 03: threshold freeze guard ────────────────────────────────────────
//
// Every gate budget is pinned twice: once as a literal expectation here and
// once in the committed `scoreboard-budgets.json` record. A threshold edit
// that does not move the table, the golden window, the pinned literal, and
// the record together fails before it can turn a run green.

/** The hand-pinned budgets. These literals are the expectation, not a re-derivation. */
const PINNED_BUDGETS: Record<string, number> = {
  goldenScriptBudgetS: 90,
  replyGapP50Ms: 1500,
  replyGapP95Ms: 2500,
  realCutMs: 1500,
  fillerResumeTailMs: 2500,
  overheardAsidesMin: 1,
  overheardAsidesMax: 1,
  deadAirMaxMs: 2000,
  silenceCheckInTargetMs: 15_000,
  silenceCheckInMaxMs: 18_000,
  emailTagMentionsMin: 1,
  emailTagMentionsMax: 1,
  doubleTalkMaxOverlapMs: 400,
  doubleTalkFadeOutS: 0.04,
  endCallPollMs: 250,
  endCallSettlePolls: 3,
  endCallAudioGraceMs: 500,
  endCallDrainTimeoutMs: 10_000,
  goodbyeAudioCoverageMin: 0.8,
  hangUpAfterGoodbyeMaxMs: 1500,
  timbreReferenceLufs: -23.1,
  timbreLufsToleranceDb: 1.5,
  timbreProbeMaxCount: 0,
  popJumpInt16: 9830,
  humanRatersRequired: 2,
  humanRatingScaleMin: 1,
  humanRatingScaleMax: 5,
  comparisonLevelLu: 1.5,
  comparisonModulationDepth: 0.05,
  comparisonBandDeltaDb: 3,
  comparisonDistortionDb: -45,
  comparisonDistortionDeltaDb: 3,
  comparisonBreakupCount: 1,
  comparisonOnsetToleranceS: 0.05,
  comparisonModelTextWordChanges: 0,
  comparisonReferenceClipDbtp: -0.1,
  timbreMeasuredTruePeakDbtp: -1,
  timbreMeasuredDistortionDb: -45,
  timbreMeasuredCrestMin: 1.2,
  timbreMeasuredBandDeltaDb: 3,
  timbreMeasuredBreakupMax: 0,
  timbreMeasuredBreakupMatchSeconds: 0.05,
  floorLevelDeviationLu: 0.2,
  floorPeakHeadroomDb: 0.3,
  floorDistortionResidualDb: -60,
  floorBreakupSeconds: 0.02,
  floorModulationDepth: 0.01,
  timbreBallotWeightTimbre: 0.5,
  timbreBallotWeightAccent: 0.25,
  timbreBallotWeightLanguageNaturalness: 0.25,
  timbreBallotPassScore: 5,
  timbreBallotRatersRequired: 2,
};

const BUDGET_RECORD_URL = new URL("./scoreboard-budgets.json", import.meta.url);

function readBudgetRecord(): { version: number; note: string; budgets: Record<string, number> } {
  return JSON.parse(readFileSync(BUDGET_RECORD_URL, "utf8")) as {
    version: number;
    note: string;
    budgets: Record<string, number>;
  };
}

test("budget table pins every gate budget and timing window", () => {
  assert.deepEqual(budgetValues(), PINNED_BUDGETS);
  for (const [key, entry] of Object.entries(SCOREBOARD_BUDGETS)) {
    assert.equal(typeof entry.value, "number", `${key} carries a numeric value`);
    assert.ok(entry.gate.length > 0, `${key} names the gate it guards`);
    assert.ok(entry.source.length > 0, `${key} names its spec/pipeline source`);
  }
});

test("every gate constant is pinned independently of the table it derives from", () => {
  // Expected values come from PINNED_BUDGETS (hand literals), not from the
  // same expression the constant uses: a constant that stopped tracking the
  // ruler still fails here.
  assert.equal(GOLDEN_SCRIPT_BUDGET_S, PINNED_BUDGETS.goldenScriptBudgetS);
  assert.equal(REPLY_GAP_P50_BUDGET_MS, PINNED_BUDGETS.replyGapP50Ms);
  assert.equal(REPLY_GAP_P95_BUDGET_MS, PINNED_BUDGETS.replyGapP95Ms);
  assert.equal(REAL_CUT_MAX_MS, PINNED_BUDGETS.realCutMs);
  assert.equal(FILLER_RESUME_TAIL_BUDGET_MS, PINNED_BUDGETS.fillerResumeTailMs);
  assert.equal(DEAD_AIR_MAX_MS, PINNED_BUDGETS.deadAirMaxMs);
  assert.equal(SILENCE_CHECK_IN_TARGET_MS, PINNED_BUDGETS.silenceCheckInTargetMs);
  assert.equal(SILENCE_CHECK_IN_MAX_MS, PINNED_BUDGETS.silenceCheckInMaxMs);
  assert.equal(SILENCE_CHECK_IN_TARGET_MS, SILENCE_CHECK_IN_MS, "the budget quotes the pipeline's check-in");
  assert.equal(DOUBLE_TALK_MAX_OVERLAP_MS, PINNED_BUDGETS.doubleTalkMaxOverlapMs);
  assert.equal(DOUBLE_TALK_FADE_OUT_S, PINNED_BUDGETS.doubleTalkFadeOutS);
  assert.equal(END_CALL_POLL_MS, PINNED_BUDGETS.endCallPollMs);
  assert.equal(END_CALL_SETTLE_POLLS, PINNED_BUDGETS.endCallSettlePolls);
  assert.equal(END_CALL_AUDIO_GRACE_MS, PINNED_BUDGETS.endCallAudioGraceMs);
  assert.equal(END_CALL_DRAIN_TIMEOUT_MS, PINNED_BUDGETS.endCallDrainTimeoutMs);
  assert.equal(GOODBYE_AUDIO_COVERAGE_MIN, PINNED_BUDGETS.goodbyeAudioCoverageMin);
  assert.equal(HANG_UP_AFTER_GOODBYE_MAX_MS, PINNED_BUDGETS.hangUpAfterGoodbyeMaxMs);
  assert.equal(TIMBRE_REFERENCE_LUFS, PINNED_BUDGETS.timbreReferenceLufs);
  assert.equal(TIMBRE_LUFS_TOLERANCE_DB, PINNED_BUDGETS.timbreLufsToleranceDb);
  assert.equal(POP_JUMP_INT16, PINNED_BUDGETS.popJumpInt16);
  assert.equal(HUMAN_RATERS_REQUIRED, PINNED_BUDGETS.humanRatersRequired);
});

test("the live session's drain constants are the ones the freeze guard pins", () => {
  // scoreboard.ts re-exports the session's handshake constants. Retuning the
  // session alone must move a number this test (and the committed record)
  // pins, so a budget edit in session.ts can never quietly escape the freeze.
  assert.equal(SESSION_END_CALL_POLL_MS, PINNED_BUDGETS.endCallPollMs);
  assert.equal(SESSION_END_CALL_SETTLE_POLLS, PINNED_BUDGETS.endCallSettlePolls);
  assert.equal(SESSION_END_CALL_AUDIO_GRACE_MS, PINNED_BUDGETS.endCallAudioGraceMs);
  assert.equal(SESSION_END_CALL_DRAIN_TIMEOUT_MS, PINNED_BUDGETS.endCallDrainTimeoutMs);
  assert.equal(END_CALL_POLL_MS, SESSION_END_CALL_POLL_MS, "one source of truth, re-exported");
  assert.equal(END_CALL_SETTLE_POLLS, SESSION_END_CALL_SETTLE_POLLS);
  assert.equal(END_CALL_AUDIO_GRACE_MS, SESSION_END_CALL_AUDIO_GRACE_MS);
  assert.equal(END_CALL_DRAIN_TIMEOUT_MS, SESSION_END_CALL_DRAIN_TIMEOUT_MS);
});

test("committed budget record matches the pinned table", () => {
  const record = readBudgetRecord();
  assert.equal(record.version, 1);
  assert.match(record.note, /threshold edit/i);
  assert.deepEqual(record.budgets, PINNED_BUDGETS);
  assert.deepEqual(record.budgets, budgetValues());
});

test("floor-mode bars and the breakup matcher are the pinned records, not local literals", () => {
  // The driver used to declare these itself. They now live only in the budget
  // table, so a local retune must move the record (and this pin) or fail.
  assert.equal(FLOOR_AXIS_THRESHOLDS.levelDeviationLu, PINNED_BUDGETS.floorLevelDeviationLu);
  assert.equal(FLOOR_AXIS_THRESHOLDS.peakHeadroomDb, PINNED_BUDGETS.floorPeakHeadroomDb);
  assert.equal(FLOOR_AXIS_THRESHOLDS.distortionResidualDb, PINNED_BUDGETS.floorDistortionResidualDb);
  assert.equal(FLOOR_AXIS_THRESHOLDS.breakupSeconds, PINNED_BUDGETS.floorBreakupSeconds);
  assert.equal(FLOOR_AXIS_THRESHOLDS.modulationDepth, PINNED_BUDGETS.floorModulationDepth);
  assert.equal(BREAKUP_MATCH_SECONDS, PINNED_BUDGETS.timbreMeasuredBreakupMatchSeconds);
  // The budget source strings quote these metric modules; if one moves alone
  // the record (and this pin) fails instead of the two bars disagreeing.
  assert.equal(FLOOR_AXIS_THRESHOLDS.levelDeviationLu, LEVEL_TOLERANCE_DB);
  assert.equal(FLOOR_AXIS_THRESHOLDS.peakHeadroomDb, TRUE_PEAK_TOLERANCE_DB);
  assert.equal(
    FLOOR_AXIS_THRESHOLDS.distortionResidualDb,
    DEFAULT_DISTORTION_CREST_THRESHOLDS.maxResidualDb,
  );
});

test("bars that judge the same defect stay equal across gates", () => {
  // `comparisonBandDeltaDb` / `timbreMeasuredBandDeltaDb` are the same octave
  // tilt bar, and `comparisonDistortionDb` / `timbreMeasuredDistortionDb` the
  // same clean-file residual bar, measured on two different capture pairs.
  // Separate records keep each gate's provenance; this pin stops a retune of
  // one from silently disagreeing with the other.
  assert.equal(
    SCOREBOARD_BUDGETS.comparisonBandDeltaDb.value,
    SCOREBOARD_BUDGETS.timbreMeasuredBandDeltaDb.value,
    "the spectral-tilt bar is one bar, whichever gate quotes it",
  );
  assert.equal(
    SCOREBOARD_BUDGETS.comparisonDistortionDb.value,
    SCOREBOARD_BUDGETS.timbreMeasuredDistortionDb.value,
    "the clean-file distortion residual bar is one bar, whichever gate quotes it",
  );
});

test("budget freeze guard rejects a threshold edit that does not move the record", () => {
  const record = readBudgetRecord().budgets;
  assert.deepEqual(checkBudgetFreeze(budgetValues(), record), [], "table and record agree today");

  const editedTable = { ...budgetValues(), replyGapP50Ms: 1800 };
  const tableDrift = checkBudgetFreeze(editedTable, record);
  assert.equal(tableDrift.length, 1, `one drift, got ${JSON.stringify(tableDrift)}`);
  assert.equal(tableDrift[0].key, "replyGapP50Ms");
  assert.equal(tableDrift[0].reason, "changed");
  assert.equal(tableDrift[0].table, 1800);
  assert.equal(tableDrift[0].record, 1500);

  const editedRecord = { ...record, replyGapP50Ms: 1800 };
  const recordDrift = checkBudgetFreeze(budgetValues(), editedRecord);
  assert.equal(recordDrift[0].key, "replyGapP50Ms");
  assert.equal(recordDrift[0].reason, "changed");

  const extra = checkBudgetFreeze(budgetValues(), { ...record, sneakyThresholdMs: 1 });
  assert.ok(extra.some((drift) => drift.key === "sneakyThresholdMs" && drift.reason === "extra"));

  const missing = { ...record };
  delete missing.replyGapP50Ms;
  const missingDrift = checkBudgetFreeze(budgetValues(), missing);
  assert.ok(
    missingDrift.some((drift) => drift.key === "replyGapP50Ms" && drift.reason === "missing"),
    "a budget dropped from the record is still drift",
  );
});

test("independent GOLDEN_SCRIPT windows agree with the frozen budget constants", () => {
  const windows = Object.fromEntries(GOLDEN_SCRIPT.map((beat) => [beat.beat, beat.window]));
  assert.deepEqual(windows, goldenWindowExpectations());
  assert.deepEqual(checkGoldenWindows(GOLDEN_SCRIPT), [], "windows track the budget table");
});

test("golden window guard rejects a window edit that leaves the budget alone", () => {
  const edited = GOLDEN_SCRIPT.map((beat) =>
    beat.beat === "greeting-cut" ? { ...beat, window: { ...beat.window, max: 1800 } } : beat,
  );
  const drift = checkGoldenWindows(edited);
  assert.equal(drift.length, 1, `one drift, got ${JSON.stringify(drift)}`);
  assert.equal(drift[0].beat, "greeting-cut");
  assert.equal(drift[0].field, "max");
  assert.equal(drift[0].script, 1800);
  assert.equal(drift[0].budget, 1500);
});

// ── Ticket 29: triple green + candidate behavior suite ──────────────────────

const STREAK_FP: CodeFingerprint = {
  head: "a".repeat(40),
  dirty: false,
  dirtyHash: sha256Hex("clean\n"),
};

function greenBehavior(codeFingerprint: CodeFingerprint = STREAK_FP): BehaviorRunEvidence {
  return {
    kind: BEHAVIOR_RUN_EVIDENCE_KIND,
    schemaVersion: BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION,
    mode: "behavior",
    passed: true,
    exitCode: 0,
    recordedAt: "2026-10-29T12:00:00.000Z",
    command: "npm run test:e2e:behavior",
    codeFingerprint,
  };
}

function streakGates(overrides: Record<string, ScoreboardArtifact["gates"][number]> = {}) {
  const required = STREAK_REQUIRED_GATES.map((name) => ({
    name,
    status: "PASS" as const,
    detail: `${name} measured`,
  }));
  const provenance = [
    {
      name: "measurements",
      status: "INFO" as const,
      reason: "measured-evidence" as const,
      detail: "measured evidence present (gaps, real-cut)",
    },
  ];
  const informational = STREAK_INFORMATIONAL_GATES.map((name) => ({
    name,
    status: "INFO" as const,
    detail: `${name} manual`,
  }));
  const all: ScoreboardGate[] = [...required, ...provenance, ...informational];
  return all.filter((gate) => overrides[gate.name] === undefined).concat(Object.values(overrides));
}

function streakArtifact(
  index: number,
  overrides: Partial<StreakArtifact> = {},
): StreakArtifact {
  return {
    runId: `run-${index}`,
    recordedAt: new Date(Date.UTC(2026, 9, 29, 12, index)).toISOString(),
    voice: DEFAULT_GATE_VOICE,
    schemaVersion: 4,
    gates: streakGates(),
    codeFingerprint: STREAK_FP,
    ...overrides,
  };
}

function runStreak(artifacts: StreakArtifact[], behavior: BehaviorRunEvidence | null = greenBehavior()) {
  return evaluateScoreStreak({
    artifacts,
    gateVoice: DEFAULT_GATE_VOICE,
    behavior,
  });
}

test("triple green: three all-required-PASS artifacts on one code fingerprint pass", () => {
  const result = runStreak([streakArtifact(1), streakArtifact(2), streakArtifact(3)]);
  assert.equal(result.ok, true, formatStreakVerdict(result));
  assert.deepEqual(result.failures, []);
  assert.equal(result.runs, 3);
  assert.match(formatStreakVerdict(result), /streak: PASS/);
  assert.match(formatStreakVerdict(result), /behavior: PASS/);
  // The required set is explicit and the manual rows are never in it.
  assert.ok(STREAK_REQUIRED_GATES.includes("barge-in-cut"));
  for (const manual of STREAK_INFORMATIONAL_GATES) {
    assert.ok(!(STREAK_REQUIRED_GATES as readonly string[]).includes(manual), `${manual} is informational`);
  }
});

test("a required gate INFO or FAIL fails the streak and names the run and gate", () => {
  const info = runStreak([
    streakArtifact(1),
    streakArtifact(2, {
      gates: streakGates({ "reply-gap": { name: "reply-gap", status: "INFO", detail: "unmeasured" } }),
    }),
    streakArtifact(3),
  ]);
  assert.equal(info.ok, false);
  assert.ok(info.failures.some((failure) => failure.run === "run-2" && failure.gate === "reply-gap"), JSON.stringify(info.failures));
  assert.match(formatStreakVerdict(info), /run-2/);
  assert.match(formatStreakVerdict(info), /reply-gap/);

  const fail = runStreak([
    streakArtifact(1),
    streakArtifact(2),
    streakArtifact(3, {
      gates: streakGates({ "dead-air": { name: "dead-air", status: "FAIL", detail: "uncovered 3200ms" } }),
    }),
  ]);
  assert.equal(fail.ok, false);
  assert.ok(fail.failures.some((failure) => failure.run === "run-3" && failure.gate === "dead-air"), JSON.stringify(fail.failures));
});

test("a differing code fingerprint fails the streak naming the run that differs", () => {
  const other: CodeFingerprint = { head: "b".repeat(40), dirty: true, dirtyHash: sha256Hex("dirty\n") };
  const result = runStreak([streakArtifact(1), streakArtifact(2), streakArtifact(3, { codeFingerprint: other })]);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.code === "fingerprint-differs" && failure.run === "run-3"));
  assert.match(formatStreakVerdict(result), /code fingerprint/);
});

test("non-increasing timestamps, voice drift, schema drift, and a missing fingerprint fail", () => {
  const equal = runStreak([streakArtifact(1), streakArtifact(2), streakArtifact(3, { recordedAt: "2026-10-29T12:02:00.000Z" })]);
  assert.equal(equal.ok, false);
  assert.ok(equal.failures.some((failure) => failure.code === "recorded-at-not-increasing"));

  const voice = runStreak([streakArtifact(1), streakArtifact(2, { voice: DEMO_VOICE_IDS[1] }), streakArtifact(3)]);
  assert.equal(voice.ok, false);
  assert.ok(voice.failures.some((failure) => failure.code === "voice-mismatch" && failure.run === "run-2"));

  const schema = runStreak([streakArtifact(1), streakArtifact(2, { schemaVersion: 3 as unknown as 4 }), streakArtifact(3)]);
  assert.equal(schema.ok, false);
  assert.ok(schema.failures.some((failure) => failure.code === "schema-mismatch" && failure.run === "run-2"));

  const missing = runStreak([streakArtifact(1), streakArtifact(2, { codeFingerprint: null }), streakArtifact(3)]);
  assert.equal(missing.ok, false);
  assert.ok(missing.failures.some((failure) => failure.code === "fingerprint-missing" && failure.run === "run-2"));
});

test("unmeasured prospect-capture memory is the only email-invite INFO a streak allows", () => {
  const memoryOnly = runStreak([
    streakArtifact(1, {
      gates: streakGates({
        "email-invite": {
          name: "email-invite",
          status: "INFO",
          reason: "unmeasured-memory",
          detail: "unmeasured - provide a before/after Hold return pair",
        },
      }),
    }),
    streakArtifact(2),
    streakArtifact(3),
  ]);
  assert.equal(memoryOnly.ok, true, formatStreakVerdict(memoryOnly));

  const otherInfo = runStreak([
    streakArtifact(1),
    streakArtifact(2, {
      gates: streakGates({
        "email-invite": { name: "email-invite", status: "INFO", detail: "unmeasured - show the chip first" },
      }),
    }),
    streakArtifact(3),
  ]);
  assert.equal(otherInfo.ok, false);
  assert.ok(otherInfo.failures.some((failure) => failure.gate === "email-invite" && failure.run === "run-2"));
});

test("gate rows carry typed semantics for artifact readers", () => {
  assert.equal(
    emailInviteGate({
      tag: "Lime 42",
      tagMentions: 1,
      digitSplit: false,
      inventedTags: [],
      strayAddresses: [],
      workEmailGateMentions: 1,
      chipShows: 1,
      memoryPersists: null,
      memoryTraceTurn: null,
      returningOk: null,
      showToolCalls: 1,
      status: "PASS",
      detail: "tag said once",
    }).reason,
    "unmeasured-memory",
  );
  const row = parseGateRow(
    { name: "email-invite", status: "INFO", detail: "held", reason: "unmeasured-memory" },
    "artifact",
    0,
  );
  assert.equal(row.reason, "unmeasured-memory");
  assert.throws(() => parseGateRow({ name: "x", status: "INFO", detail: "d", reason: "vibes" }, "artifact", 0), /unknown reason/);
  assert.throws(() => parseGateRows([{ name: "x", status: "MAYBE", detail: "d" }], "artifact"), /name\/status\/detail/);
});

test("the streak judges typed reasons, never the human-readable detail prose", () => {
  // Prose that reads like the old regex shapes earns nothing without the
  // typed reason...
  const proseOnly = runStreak([
    streakArtifact(1, {
      gates: streakGates({
        "email-invite": {
          name: "email-invite",
          status: "INFO",
          detail: "unmeasured - before/after Hold return pair",
        },
      }),
    }),
    streakArtifact(2),
    streakArtifact(3),
  ]);
  assert.equal(proseOnly.ok, false, "a typed reason is required");

  // ...and a typed reason survives any rewording of the detail.
  const typed = runStreak([
    streakArtifact(1, {
      gates: streakGates({
        "email-invite": {
          name: "email-invite",
          status: "INFO",
          reason: "unmeasured-memory",
          detail: "held: no pair yet",
        },
      }),
    }),
    streakArtifact(2),
    streakArtifact(3),
  ]);
  assert.equal(typed.ok, true, formatStreakVerdict(typed));

  // The provenance row likewise depends on the typed reason.
  const provenanceProse = runStreak([
    streakArtifact(1, {
      gates: streakGates({
        measurements: { name: "measurements", status: "INFO", detail: "measured evidence present (gaps)" },
      }),
    }),
    streakArtifact(2),
    streakArtifact(3),
  ]);
  assert.equal(provenanceProse.ok, false, "measurements INFO needs the typed measured-evidence reason");
});

test("accent ballots, the real-phone checklist, and Talk pinning never block the streak", () => {
  const result = runStreak([
    streakArtifact(1, {
      gates: streakGates({
        "accent-human": { name: "accent-human", status: "FAIL", detail: "one rater" },
        "phone-checklist": { name: "phone-checklist", status: "FAIL", detail: "not run" },
        "talk-hold-pinned": { name: "talk-hold-pinned", status: "INFO", detail: "external" },
      }),
    }),
    streakArtifact(2, {
      gates: streakGates().filter((gate) => gate.name !== "phone-checklist" && gate.name !== "talk-hold-pinned"),
    }),
    streakArtifact(3),
  ]);
  assert.equal(result.ok, true, formatStreakVerdict(result));

  const unknownInfo = runStreak([
    streakArtifact(1, {
      gates: streakGates({ "new-unmeasured-gate": { name: "new-unmeasured-gate", status: "INFO", detail: "future" } }),
    }),
    streakArtifact(2),
    streakArtifact(3),
  ]);
  assert.equal(unknownInfo.ok, false, "a new non-informational INFO gate still blocks green");
});

test("the behavior run must be present, green, and on the same code fingerprint", () => {
  const missing = runStreak([streakArtifact(1), streakArtifact(2), streakArtifact(3)], null);
  assert.equal(missing.ok, false);
  assert.ok(missing.failures.some((failure) => failure.code === "behavior-missing"));

  const red = runStreak([streakArtifact(1), streakArtifact(2), streakArtifact(3)], {
    ...greenBehavior(),
    passed: false,
    exitCode: 1,
  });
  assert.equal(red.ok, false);
  assert.ok(red.failures.some((failure) => failure.code === "behavior-failed"));

  const otherCode = runStreak([streakArtifact(1), streakArtifact(2), streakArtifact(3)], greenBehavior({
    head: "c".repeat(40),
    dirty: false,
    dirtyHash: STREAK_FP.dirtyHash,
  }));
  assert.equal(otherCode.ok, false);
  assert.ok(otherCode.failures.some((failure) => failure.code === "behavior-code-differs"));
});

test("behavior evidence is validated instead of trusted", () => {
  assert.throws(() => parseBehaviorRunEvidence({ kind: "something-else" }), /not a behavior-run evidence file/);
  assert.throws(
    () => parseBehaviorRunEvidence({ ...greenBehavior(), mode: "instant" }),
    /mode must be "behavior"/,
  );
  assert.throws(
    () => parseBehaviorRunEvidence({ ...greenBehavior(), codeFingerprint: { head: "x" } }),
    /codeFingerprint/,
  );
  const parsed = parseBehaviorRunEvidence(greenBehavior());
  assert.equal(parsed.passed, true);
  assert.equal(parsed.codeFingerprint?.head, STREAK_FP.head);
});

test("code fingerprint hashes HEAD plus uncommitted status and diff", () => {
  const clean = codeFingerprintFromGit({ head: "abc123", status: "", diff: "" });
  const dirty = codeFingerprintFromGit({ head: "abc123", status: " M voni/a.ts\n", diff: "diff --git a/x b/x" });
  assert.equal(clean?.head, "abc123");
  assert.equal(clean?.dirty, false);
  assert.equal(dirty?.dirty, true);
  assert.notEqual(clean?.dirtyHash, dirty?.dirtyHash);
  assert.equal(codeFingerprintFromGit({ head: "" }), null, "no HEAD is no fingerprint, never a fake clean one");
});
