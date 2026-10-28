import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyRealCutGate,
  callerClipDrift,
  callerClipFingerprint,
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
  evaluateDeadAir,
  evaluateDoubleTalk,
  evaluateEndCallDrain,
  evaluateFillerResumeGate,
  evaluateRealCut,
  extractRealCutEvidence,
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
  buildRegressionMatrix,
  checkEvidenceTimbre,
  checkLoudness,
  checkLoudnessSanity,
  checkRegressionVoice,
  checkTimbreProbes,
  diffScoreboardArtifact,
  emptyHumanRatings,
  evaluateHumanGate,
  evaluateTimbreGate,
  classifyRunnerOutcome,
  formatArtifactDiff,
  formatEvalRunnerReport,
  formatMatrixTable,
  formatTraceTurn,
  matchedLoudnessLufs,
  resolveMatrixVoices,
  classifyOverheard,
  evaluateOverheardRecall,
  formatGateTable,
  formatGoldenScript,
  formatOverheardReport,
  formatReplyGapReport,
  gateVoicePlayback,
  isRealCutExpected,
  meaningBasedEndOfTurnGate,
  measureCutLatency,
  overheardFromTraceExcerpt,
  parseTraceGaps,
  percentile,
  REAL_CUT_MAX_MS,
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
  emailInviteGate,
  formatSubScoreTable,
  hasMeasuredEvidence,
  measuredEvidenceSources,
  persistsEmailAcrossMemory,
  validateProbeCounts,
  formatVoiceGainTable,
  voiceGainRow,
  voiceGainTable,
  type OverheardAside,
  EMAIL_INVITE_TAG,
  applyEmailInvite,
  countTagMentions,
  countWorkEmailGate,
  evaluateEmailInvite,
  findInventedTags,
  findStrayAddresses,
  hasDigitSplitTag,
  type ScoreboardArtifact,
} from "./scoreboard";
import {
  SCOREBOARD_BUDGETS,
  budgetValues,
  checkBudgetFreeze,
  checkGoldenWindows,
  goldenWindowExpectations,
} from "./scoreboard-budgets";
import { judgeOverlap } from "../voice/barge-in";
import { DEMO_VOICE_IDS, SILENCE_CHECK_IN_MS } from "./voni-agent";
import { buildDemoAgentBody } from "./stored-agents";
import { VOICE_OUTPUT_VOLUME, voicePlaybackGain } from "../agents/voices";

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

test("gate voice playback comes from the shared registry (volume plus per-voice gain)", () => {
  for (const id of DEMO_VOICE_IDS) {
    const playback = gateVoicePlayback(id);
    assert.equal(playback.id, id);
    assert.equal(playback.outputVolume, VOICE_OUTPUT_VOLUME);
    assert.equal(playback.playbackGain, voicePlaybackGain(id));
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

test("reply-gap gate fails when p50 exceeds 1500ms and points at the trace turn", () => {
  const gate = replyGapGate([
    { beat: "real-cut-answered", gapMs: 1600, turnIndex: 2 },
    { beat: "real-cut-answered", gapMs: 1800, turnIndex: 3 },
    { beat: "email-invite", gapMs: 900, turnIndex: 4 },
  ]);
  assert.equal(gate.status, "FAIL");
  assert.ok(gate.detail.includes("real-cut-answered"), `detail names the failing beat: ${gate.detail}`);
  assert.ok(gate.detail.includes("turn 3"), `detail points at the failing trace turn: ${gate.detail}`);
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

test("every merged turn is judged on its own: one slow later turn fails and cites its Call trace turn", () => {
  // Six turns, one slow turn 5. The call-level p50 (1100ms) and p95 (2000ms)
  // both sit inside budget, so only a per-turn judgment catches turn 5.
  const excerpt = [
    '10.00s  HEARD   "Yes please"  (9.20s–9.90s)',
    '10.90s  VONI    "Happy to help"  (reply_create gap 900ms)',
    '12.00s  VONI    "Of course"  (reply_create ttfa 600ms gap 1000ms)',
    '13.10s  VONI    "The team is small"  (reply_create gap 1100ms)',
    '14.20s  VONI    "Two bedrooms"  (reply_create gap 1200ms)',
    '16.40s  VONI    "Here is the tag"  (reply_create gap 2000ms)',
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
  assert.equal(reply.p95Ms, 2000, "the call-level p95 is still inside its 2500ms budget");
  const gate = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /call trace turn 5 \(sess_per_turn\)/, `detail points at turn 5: ${gate.detail}`);
  assert.match(gate.detail, /2000ms/);
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
  const agentInput = buildDemoAgentBody(DEFAULT_GATE_VOICE).input;
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
    agentInput,
  });
  const gate = artifact.gates.find((g) => g.name === "reply-gap")!;
  assert.equal(gate.status, "PASS", gate.detail);
  assert.match(gate.detail, /p50 1100ms/, `every turn is inside budget: ${gate.detail}`);
  // Ticket 24 stays intact: per-turn judgment introduces no turn-detection
  // object on the managed path and the merged excerpt carries no CONFIG line.
  assert.equal(agentInput.turn_detection, null);
  assert.ok(!excerpt.some((line) => line.includes("turn_detection")));
  assert.equal(artifact.gates.find((g) => g.name === "end-of-turn")?.status, "PASS");
});

test("only the verified first turn is attributed to a beat; later turns stay call-level", () => {
  const excerpt = [
    '0.50s  VONI    "Hi, you have reached Voni"  (reply_create gap 900ms)  greeting-cut',
    '3.00s  VONI    "Of course"  (reply_create gap 2000ms)',
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
  assert.match(gate.detail, /call-level/, `later turns are judged call-level: ${gate.detail}`);
});

test("greeting-cut breach fails within the same gap budget and names the beat", () => {
  const gate = replyGapGate([
    { beat: "greeting-cut", gapMs: 2100, turnIndex: 1 },
    { beat: "greeting-cut", gapMs: 2200, turnIndex: 2 },
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
    gaps: { "greeting-cut": [1800, 1900] },
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
    assert.equal(judgeOverlap(filler, "We help dental clinics answer every call"), "ignore", `${filler} must never steal the floor`);
  }
  assert.equal(
    judgeOverlap("help dental clinics", "We help dental clinics answer every call"),
    "ignore",
    "agent echo must never steal the floor",
  );
  assert.equal(judgeOverlap("Wait, stop.", "We help dental clinics answer every call"), "yield", "steering always yields");
  assert.equal(judgeOverlap("I want you to hang up.", "Thanks for calling"), "yield", "end-call always yields");
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
      gate.detail.includes(evidence.traceTurn ?? "no trace turn"),
      `detail should report the trace turn: ${gate.detail}`,
    );
  }
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
  const passed = extractRealCutEvidence('    cut 912ms after the caller started\nstop-over: 1/1\n');
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

test("real-cut evidence derives the Call trace turn from the merged excerpt", () => {
  const excerpt = [
    '12.10s  HEARD   "Tell me about the price."  (10.20s-11.30s)',
    '12.20s  VONI    "Sure, first the tour"  (reply_create gap 900ms)  CUT at 12.90s',
    '15.00s  VONI    "The price is"  (reply_create gap 800ms)',
  ];
  const pointers = traceTurnPointers(excerpt);
  assert.deepEqual(pointers, { cutTurn: 1, goodbyeTurn: null });
  assert.equal(formatTraceTurn(1, "sess_abc"), "call trace turn 1 (sess_abc)");

  const late = extractRealCutEvidence(
    '    cut 1601ms after the caller started\n  ✗ stop-over #1: cut too late: 1601ms\nstop-over: 0/1\n',
    excerpt,
  );
  assert.equal(late?.traceTurn, "call trace turn 1");
  const gate = evaluateRealCut(late!);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.detail, /call trace turn 1/, `detail should name the derived turn: ${gate.detail}`);
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
  assert.deepEqual(traceTurnPointers(excerpt), { cutTurn: 1, goodbyeTurn: 2 });
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
    traceGaps: [{ gapMs: 1600, turnIndex: 1 }],
    traceExcerpt: ['12.20s  VONI    "Hi"  (reply_create gap 1600ms)  greeting-cut marker'],
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
    endCallDrain: { goodbyeCoverage: 0.95, hangUpDelayMs: 900, narratedEnding: false },
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
    endCallDrain: { goodbyeCoverage: 0.7, hangUpDelayMs: 4200, narratedEnding: true },
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

test("trace excerpt HEARD rows become ledger-counted asides with barge-in verdict handling", () => {
  const excerpt = [
    '10.20s  VONI    "handling booking and reminders"  (reply.create ttfa 400ms)',
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

  const steeringExcerpt = [
    '10.20s  VONI    "handling booking"  (reply.create)',
    '11.05s  HEARD   "Wait, stop."  (11.05s–11.60s)',
    "11.40s  CLIENT  barge-in yield rule Wait, stop.",
  ];
  const steering = overheardFromTraceExcerpt(steeringExcerpt, "sess_abc");
  assert.equal(steering[0].handling, "answered");

  const bare = overheardFromTraceExcerpt(
    ['11.05s  HEARD   "mm-hmm"  (11.05s–11.40s)'],
    "sess_xyz",
  );
  assert.equal(bare.length, 1);
  assert.equal(bare[0].handling, "heard-only");
  assert.equal(bare[0].markedOverheard, true);
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

test("timbre probes pass only when every count is zero", () => {
  const clean = checkTimbreProbes(ZERO_PROBES);
  assert.equal(clean.ok, true);
  for (const kind of ["jump", "overload", "clip", "underrun", "inputDrop"] as const) {
    const dirty = checkTimbreProbes({ ...ZERO_PROBES, [kind]: 1 });
    assert.equal(dirty.ok, false, `${kind} must fail the gate`);
    assert.ok(dirty.detail.includes(kind), `detail names the offender: ${dirty.detail}`);
  }
});

test("per-voice gain matches every voice back to the loudness reference", () => {
  assert.equal(TIMBRE_REFERENCE_LUFS, -23.1);
  assert.equal(TIMBRE_LUFS_TOLERANCE_DB, 1.5);
  assert.equal(matchedLoudnessLufs("anna"), -23.1);
  for (const voice of DEMO_VOICE_IDS) {
    const matched = matchedLoudnessLufs(voice);
    assert.ok(matched !== null, `${voice} has a native measurement plus a gain`);
    assert.ok(
      Math.abs(matched - TIMBRE_REFERENCE_LUFS) <= TIMBRE_LUFS_TOLERANCE_DB,
      `${voice} lands at ${matched} LUFS, outside tolerance`,
    );
  }
  assert.equal(matchedLoudnessLufs("not-a-voice"), null);
});

test("loudness sanity fails a misgained voice by the numbers", () => {
  const good = checkLoudness({ nativeLufs: -23.1, gain: 1.0 });
  assert.equal(good.ok, true);
  assert.ok(good.detail.includes("-23.1"));
  // 4x gain on a reference-level voice lands ~12 dB hot: must fail.
  const hot = checkLoudness({ nativeLufs: -23.1, gain: 4.0 });
  assert.equal(hot.ok, false);
  assert.ok(hot.detail.includes("-11.06"), `detail shows the hot level: ${hot.detail}`);
  const sanity = checkLoudnessSanity("giovanni");
  assert.equal(sanity.ok, true);
  assert.ok(sanity.detail.includes("3.89"), `detail cites the registry gain: ${sanity.detail}`);
});

test("per-voice gain table is complete: gate plus every regression voice from the registry", () => {
  const table = voiceGainTable("anna");
  assert.deepEqual(
    table.map((row) => row.voice),
    ["anna", ...regressionVoices("anna")],
    "gate first, every regression voice included",
  );
  assert.deepEqual(
    [...table.map((row) => row.voice)].sort(),
    [...DEMO_VOICE_IDS].sort(),
    "no demo voice is missing from the gain table",
  );
  for (const row of table) {
    assert.equal(row.isGate, row.voice === "anna");
    assert.equal(row.outputVolume, VOICE_OUTPUT_VOLUME, `${row.voice} server level is the registry constant`);
    assert.equal(row.gain, voicePlaybackGain(row.voice), `${row.voice} client gain comes from the registry`);
    assert.ok(Math.abs((row.matchedLufs ?? 0) - TIMBRE_REFERENCE_LUFS) <= TIMBRE_LUFS_TOLERANCE_DB);
    assert.equal(row.status, "PASS");
  }
  // A different gate voice flips the gate row, never the registry values.
  const lola = voiceGainTable("lola");
  assert.equal(lola[0]?.voice, "lola");
  assert.equal(lola[0]?.isGate, true);
  assert.equal(lola.find((row) => row.voice === "anna")?.isGate, false);
});

test("an unmeasured voice is reported INFO, never failed", () => {
  // alba is in the voice registry but has no native loudness measurement.
  const row = voiceGainRow("alba", "anna");
  assert.equal(row.gain, 1.0, "an unknown gain stays the registry default");
  assert.equal(row.nativeLufs, null);
  assert.equal(row.matchedLufs, null);
  assert.equal(row.status, "INFO");
  assert.ok(row.detail.includes("no native loudness measurement"), row.detail);
  assert.ok(formatVoiceGainTable([row]).includes("INFO"), "printed as INFO, never FAIL");

  const sanity = checkLoudnessSanity("alba");
  assert.equal(sanity.unmeasured, true);
  assert.equal(sanity.matchedLufs, null);
  const gate = evaluateTimbreGate({ probes: ZERO_PROBES, voiceId: "alba", agentChannel: null });
  assert.equal(gate.status, "PASS", "unmeasured loudness never fails the timbre gate");
  assert.ok(gate.detail.includes("no native loudness measurement"));
});

test("gain table output names every voice with its server level and client gain", () => {
  const table = voiceGainTable("anna");
  const printed = formatVoiceGainTable(table);
  for (const row of table) {
    assert.ok(printed.includes(row.voice), `printed table missing ${row.voice}`);
  }
  assert.ok(printed.includes(`vol=${VOICE_OUTPUT_VOLUME}`));
  assert.ok(printed.includes("gain=3.89"), "giovanni's registry gain is visible");
});


test("timbre gate passes clean and fails named defects", () => {
  const clean = evaluateTimbreGate({ probes: ZERO_PROBES, voiceId: "anna", agentChannel: null });
  assert.equal(clean.name, "timbre-probes");
  assert.equal(clean.status, "PASS");
  const clipped = evaluateTimbreGate({
    probes: { ...ZERO_PROBES, clip: 2 },
    voiceId: "anna",
    agentChannel: null,
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
  const clean = checkEvidenceTimbre({ peakDbfs: -7.2, clippedSampleRatio: 0, largestAdjacentStep: 120 });
  assert.equal(clean.ok, true);
  assert.ok(clean.detail.includes("-7.2"), `peak stays reviewable: ${clean.detail}`);
  const clipped = checkEvidenceTimbre({ peakDbfs: -0.4, clippedSampleRatio: 0.0001, largestAdjacentStep: 120 });
  assert.equal(clipped.ok, false);
  assert.ok(clipped.detail.includes("clip"));
  const stepped = checkEvidenceTimbre({ peakDbfs: -6.0, clippedSampleRatio: 0, largestAdjacentStep: 20000 });
  assert.equal(stepped.ok, false);
  assert.ok(stepped.detail.includes("jump"));
  const missing = checkEvidenceTimbre(null);
  assert.equal(missing.ok, true);
  assert.ok(missing.detail.includes("no agent-channel evidence"));
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

test("human gate counts only after two raters and a passing auto gate", () => {
  const none = emptyHumanRatings(RECORDING);
  const awaiting = evaluateHumanGate(true, none);
  assert.equal(awaiting.name, "accent-human");
  assert.equal(awaiting.status, "INFO");
  assert.ok(awaiting.detail.includes("awaiting"));
  const one = addHumanRating(none, { rater: "ana", timbre: 5, accent: 4 }, RECORDING);
  assert.equal(evaluateHumanGate(true, one).status, "INFO");
  const two = addHumanRating(one, { rater: "bob", timbre: 4, accent: 4 }, RECORDING);
  assert.equal(two.timbre, 4.5);
  assert.equal(two.accent, 4);
  const counted = evaluateHumanGate(true, two);
  assert.equal(counted.status, "PASS");
  assert.ok(counted.detail.includes("4.5"), `means stay reviewable: ${counted.detail}`);
  const blocked = evaluateHumanGate(false, two);
  assert.equal(blocked.status, "INFO");
  assert.ok(blocked.detail.includes("auto"), `auto must pass first: ${blocked.detail}`);
});

test("artifact carries human slots, loudness sanity, and live timbre gates", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: 'heard: "Wait, stop."\n',
    exitCode: 0,
    durationMs: 1234,
    runs: 1,
  });
  assert.equal(artifact.schemaVersion, 4);
  assert.equal(artifact.humanRatings.timbre, null);
  assert.equal(artifact.humanRatings.accent, null);
  assert.deepEqual(artifact.humanRatings.ratings, []);
  assert.equal(artifact.humanRatings.recordingSha256, null);
  assert.ok(Math.abs((artifact.loudness.matchedLufs ?? 0) - TIMBRE_REFERENCE_LUFS) <= TIMBRE_LUFS_TOLERANCE_DB);
  const timbre = artifact.gates.find((g) => g.name === "timbre-probes");
  assert.equal(timbre?.status, "PASS");
  const human = artifact.gates.find((g) => g.name === "accent-human");
  assert.equal(human?.status, "INFO");
});

test("artifact carries the per-voice gain table, not only the gate voice", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 10,
    runs: 1,
  });
  const rows = artifact.loudness.voices;
  assert.equal(rows.length, DEMO_VOICE_IDS.length, "every demo voice has a gain row");
  assert.equal(rows[0]?.voice, DEFAULT_GATE_VOICE);
  assert.equal(rows[0]?.isGate, true);
  for (const voice of regressionVoices(DEFAULT_GATE_VOICE)) {
    const row = rows.find((entry) => entry.voice === voice);
    assert.ok(row, `regression voice ${voice} missing from the artifact gain table`);
    assert.equal(row.gain, voicePlaybackGain(voice), `${voice} gain comes from the registry`);
    assert.equal(row.outputVolume, VOICE_OUTPUT_VOLUME);
    assert.equal(row.status, "PASS");
  }
  assert.ok(formatVoiceGainTable(rows).includes("giovanni"));
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

test("matrix passes all-clean and fails named per voice with an overall row", () => {
  const entries = [
    {
      voice: "anna",
      probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
      tagLines: ["send it with Lime 42 in the subject"],
      expectedTag: "Lime 42",
    },
    {
      voice: "lola",
      probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
      tagLines: ["send it with Lime 42 in the subject"],
      expectedTag: "Lime 42",
    },
  ];
  const matrix = buildRegressionMatrix({ gateVoice: "anna", entries });
  assert.equal(matrix.schemaVersion, 4);
  assert.equal(matrix.gateVoice, "anna");
  assert.equal(matrix.results.length, 2);
  assert.ok(matrix.results.every((r) => r.status === "PASS"));
  assert.ok(matrix.results.find((r) => r.voice === "anna")?.isGate);
  assert.ok(!matrix.results.find((r) => r.voice === "lola")?.isGate);
  assert.equal(matrix.gates.find((g) => g.name === "matrix")?.status, "PASS");
  const dirty = buildRegressionMatrix({
    gateVoice: "anna",
    entries: [
      entries[0],
      { ...entries[1], probes: { jump: 1, overload: 0, clip: 0, underrun: 0, inputDrop: 0 } },
    ],
  });
  const lola = dirty.results.find((r) => r.voice === "lola");
  assert.equal(lola?.status, "FAIL");
  assert.ok(lola?.detail.includes("jump"));
  assert.equal(dirty.gates.find((g) => g.name === "matrix")?.status, "FAIL");
  assert.equal(dirty.gates.filter((g) => g.name.startsWith("regression:")).length, 2);
});

test("matrix table names every voice with its verdict plus a summary", () => {
  const matrix = buildRegressionMatrix({
    gateVoice: "anna",
    entries: [
      {
        voice: "anna",
        probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        tagLines: ["Lime 42 in the subject"],
        expectedTag: "Lime 42",
      },
      {
        voice: "lola",
        probes: { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 },
        tagLines: ["Lime 42 in the subject"],
        expectedTag: "Lime 42",
      },
    ],
  });
  const table = formatMatrixTable(matrix);
  assert.ok(table.includes("anna"));
  assert.ok(table.includes("lola"));
  assert.ok(table.includes("PASS"));
  assert.ok(table.includes("FAIL"));
  assert.ok(table.includes("1/2"), `summary counts clean voices: ${table}`);
});

test("matrix carries the gate voice verdict and sub-scores, never re-judges them", () => {
  const gateGates = [
    { name: "plumbing", status: "PASS" as const, detail: "eval runner finished" },
    { name: "reply-gap", status: "PASS" as const, detail: "p50 900ms (budget 1500ms)" },
    { name: "end-of-turn", status: "PASS" as const, detail: "meaning-based end of turn (no turn_detection object)" },
    { name: "barge-in-cut", status: "PASS" as const, detail: "cut 912ms (budget 1500ms)" },
    { name: "measurements", status: "INFO" as const, detail: "measured evidence present (real-cut)" },
  ];
  const gateSubScores = buildSubScores(gateGates);
  const gateEntry = {
    voice: "anna",
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    tagLines: ["send it with Lime 42 in the subject"],
    gates: gateGates,
    subScores: gateSubScores,
  };
  const cleanVoice = {
    voice: "lola",
    probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
    tagLines: ["send it with Lime 42 in the subject"],
  };

  const clean = buildRegressionMatrix({ gateVoice: "anna", entries: [gateEntry, cleanVoice] });
  assert.equal(clean.gate.voice, "anna");
  assert.equal(clean.gate.status, "PASS", clean.gate.detail);
  assert.deepEqual(clean.gate.gates, gateGates);
  assert.deepEqual(clean.gate.subScores, gateSubScores);

  const table = formatMatrixTable(clean);
  assert.match(table, /GATE\s+anna\s+gate anna: PASS/, table);
  assert.match(table, /sub-scores responsiveness PASS/, table);
  assert.match(table, /regression lola/, table);

  // A dirty regression voice flips only its own row and the regression
  // roll-up; the carried gate verdict, gates, and sub-scores stay identical.
  const dirty = buildRegressionMatrix({
    gateVoice: "anna",
    entries: [
      gateEntry,
      { ...cleanVoice, probes: { jump: 0, overload: 0, clip: 1, underrun: 0, inputDrop: 0 } },
    ],
  });
  assert.equal(dirty.gate.status, clean.gate.status);
  assert.deepEqual(dirty.gate.gates, gateGates);
  assert.deepEqual(dirty.gate.subScores, gateSubScores);
  assert.equal(dirty.results.find((r) => r.voice === "lola")?.status, "FAIL");
  assert.equal(dirty.gates.find((g) => g.name === "regression:lola")?.status, "FAIL");
  assert.equal(dirty.gates.find((g) => g.name === "matrix")?.status, "FAIL");
  assert.ok(
    !dirty.gates.some((gate) => gateGates.some((carried) => carried.name === gate.name)),
    "gate rows are carried, not copied into the matrix's own gates",
  );

  // A red gate voice stays red no matter how clean the regression rows are.
  const red = buildRegressionMatrix({
    gateVoice: "anna",
    entries: [
      { ...gateEntry, gates: [{ name: "barge-in-cut", status: "FAIL" as const, detail: "cut 1841ms exceeds 1500ms" }] },
      cleanVoice,
    ],
  });
  assert.equal(red.gate.status, "FAIL");
  assert.deepEqual(red.gate.failing, ["barge-in-cut"]);
  assert.match(formatMatrixTable(red), /GATE\s+anna\s+gate anna: FAIL/);
  assert.equal(red.gates.find((g) => g.name === "matrix")?.status, "PASS");

  // Without a carried gate artifact there is no verdict to invent.
  const unmeasured = buildRegressionMatrix({ gateVoice: "anna", entries: [cleanVoice] });
  assert.equal(unmeasured.gate.status, "INFO");
  assert.ok(unmeasured.gate.detail.includes("not judged"));
});

test("matrix reads gate rows only from the gate voice, never from a regression voice", () => {
  const gateGates = [{ name: "plumbing", status: "PASS" as const, detail: "eval runner finished" }];
  const lolaGates = [{ name: "timbre-probes", status: "FAIL" as const, detail: "clip 1 > 0" }];
  const matrix = buildRegressionMatrix({
    gateVoice: "anna",
    entries: [
      {
        voice: "anna",
        probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        tagLines: ["Lime 42 in the subject"],
        gates: gateGates,
      },
      {
        voice: "lola",
        probes: { jump: 0, overload: 0, clip: 0, underrun: 0, inputDrop: 0 },
        tagLines: ["Lime 42 in the subject"],
        gates: lolaGates,
      },
    ],
  });
  assert.equal(matrix.gate.voice, "anna");
  assert.equal(matrix.gate.status, "PASS");
  assert.deepEqual(matrix.gate.gates, gateGates);
  assert.ok(!matrix.gate.gates.some((gate) => gate.name === "timbre-probes"));
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
  assert.equal(info.detail, "unmeasured - provide hold/reload evidence");
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
    agentInput: { turn_detection: null },
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

test("every gate constant derives from the frozen budget table", () => {
  assert.equal(GOLDEN_SCRIPT_BUDGET_S, SCOREBOARD_BUDGETS.goldenScriptBudgetS.value);
  assert.equal(REPLY_GAP_P50_BUDGET_MS, SCOREBOARD_BUDGETS.replyGapP50Ms.value);
  assert.equal(REPLY_GAP_P95_BUDGET_MS, SCOREBOARD_BUDGETS.replyGapP95Ms.value);
  assert.equal(REAL_CUT_MAX_MS, SCOREBOARD_BUDGETS.realCutMs.value);
  assert.equal(FILLER_RESUME_TAIL_BUDGET_MS, SCOREBOARD_BUDGETS.fillerResumeTailMs.value);
  assert.equal(DEAD_AIR_MAX_MS, SCOREBOARD_BUDGETS.deadAirMaxMs.value);
  assert.equal(SILENCE_CHECK_IN_TARGET_MS, SCOREBOARD_BUDGETS.silenceCheckInTargetMs.value);
  assert.equal(SILENCE_CHECK_IN_TARGET_MS, SILENCE_CHECK_IN_MS, "the budget quotes the pipeline's check-in");
  assert.equal(DOUBLE_TALK_MAX_OVERLAP_MS, SCOREBOARD_BUDGETS.doubleTalkMaxOverlapMs.value);
  assert.equal(DOUBLE_TALK_FADE_OUT_S, SCOREBOARD_BUDGETS.doubleTalkFadeOutS.value);
  assert.equal(END_CALL_POLL_MS, SCOREBOARD_BUDGETS.endCallPollMs.value);
  assert.equal(END_CALL_SETTLE_POLLS, SCOREBOARD_BUDGETS.endCallSettlePolls.value);
  assert.equal(END_CALL_AUDIO_GRACE_MS, SCOREBOARD_BUDGETS.endCallAudioGraceMs.value);
  assert.equal(END_CALL_DRAIN_TIMEOUT_MS, SCOREBOARD_BUDGETS.endCallDrainTimeoutMs.value);
  assert.equal(GOODBYE_AUDIO_COVERAGE_MIN, SCOREBOARD_BUDGETS.goodbyeAudioCoverageMin.value);
  assert.equal(HANG_UP_AFTER_GOODBYE_MAX_MS, SCOREBOARD_BUDGETS.hangUpAfterGoodbyeMaxMs.value);
  assert.equal(TIMBRE_REFERENCE_LUFS, SCOREBOARD_BUDGETS.timbreReferenceLufs.value);
  assert.equal(TIMBRE_LUFS_TOLERANCE_DB, SCOREBOARD_BUDGETS.timbreLufsToleranceDb.value);
  assert.equal(POP_JUMP_INT16, SCOREBOARD_BUDGETS.popJumpInt16.value);
  assert.equal(HUMAN_RATERS_REQUIRED, SCOREBOARD_BUDGETS.humanRatersRequired.value);
});

test("committed budget record matches the pinned table", () => {
  const record = readBudgetRecord();
  assert.equal(record.version, 1);
  assert.match(record.note, /threshold edit/i);
  assert.deepEqual(record.budgets, PINNED_BUDGETS);
  assert.deepEqual(record.budgets, budgetValues());
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
