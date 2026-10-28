import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GATE_VOICE,
  GOLDEN_BEATS,
  GOLDEN_SCRIPT,
  GOLDEN_SCRIPT_BUDGET_S,
  buildSkeletonArtifact,
  evaluateFillerResumeGate,
  formatGateTable,
  formatGoldenScript,
  gateVoicePlayback,
  redactTranscript,
  regressionVoices,
  resolveGateVoice,
  sha256Hex,
} from "./scoreboard";
import { judgeOverlap } from "../voice/barge-in";
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
