import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GATE_VOICE,
  GOLDEN_BEATS,
  GOLDEN_SCRIPT,
  GOLDEN_SCRIPT_BUDGET_S,
  REPLY_GAP_P50_BUDGET_MS,
  REPLY_GAP_P95_BUDGET_MS,
  buildSkeletonArtifact,
  formatGateTable,
  formatGoldenScript,
  gateVoicePlayback,
  meaningBasedEndOfTurnGate,
  parseTraceGaps,
  percentile,
  redactTranscript,
  regressionVoices,
  replyGapGate,
  replyGapMs,
  resolveGateVoice,
  sha256Hex,
} from "./scoreboard";
import { DEMO_VOICE_IDS } from "./voni-agent";
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
  });
  assert.equal(artifact.schemaVersion, 3);
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

test("skeleton gates never fail: runner crash is plumbing INFO, not FAIL", () => {
  const artifact = buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "greeting-cut",
    runnerStdout: "",
    exitCode: 1,
    durationMs: 10,
    runs: 1,
  });
  assert.ok(artifact.gates.every((g) => g.status !== "FAIL"));
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
