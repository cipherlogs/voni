import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GATE_VOICE,
  GOLDEN_BEATS,
  GOLDEN_SCRIPT,
  GOLDEN_SCRIPT_BUDGET_S,
  buildSkeletonArtifact,
  classifyOverheard,
  evaluateOverheardRecall,
  formatGateTable,
  formatGoldenScript,
  formatOverheardReport,
  gateVoicePlayback,
  overheardFromTraceExcerpt,
  redactTranscript,
  regressionVoices,
  resolveGateVoice,
  sha256Hex,
  type OverheardAside,
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
