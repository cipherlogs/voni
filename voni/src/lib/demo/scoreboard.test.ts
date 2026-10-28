import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRealCutGate,
  DEFAULT_GATE_VOICE,
  evaluateRealCut,
  extractRealCutEvidence,
  GOLDEN_BEATS,
  GOLDEN_SCRIPT,
  GOLDEN_SCRIPT_BUDGET_S,
  buildSkeletonArtifact,
  formatGateTable,
  formatGoldenScript,
  gateVoicePlayback,
  isRealCutExpected,
  REAL_CUT_MAX_MS,
  redactTranscript,
  regressionVoices,
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
  assert.equal(artifact.schemaVersion, 2);
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
