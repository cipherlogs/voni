import test from "node:test";
import assert from "node:assert/strict";
import { buildRunnerEvidence, turnRowsFromTraceExcerpt } from "./runner-evidence";
import type { EvalEvent } from "./eval-events";
import { buildSkeletonArtifact, DEFAULT_GATE_VOICE } from "./scoreboard";

const SUMMARY = `EVAL SUMMARY ${JSON.stringify({
  scenario: "suite",
  runs: 1,
  failures: 0,
  scenarios: [
    { name: "stop-over", passed: 1, runs: 1 },
    { name: "over-talk", passed: 0, runs: 1 },
  ],
  traceSessions: ["sess_stop", "sess_talk"],
  playout: [
    { scenario: "stop-over", run: 1, wallClockMs: 27213 },
    { scenario: "over-talk", run: 1, wallClockMs: 31768 },
  ],
  audioChunks: 900,
  live: true,
  transport: "stored",
  agentId: "agent_d66c02a12f904b73a940a42032dbd36d",
  agentFingerprint: "fingerprint-abc",
  llmModel: "google/gemini-2.5-flash",
})}`;

const STOP_EXCERPT = [
  "sess_stop  agent=agent_d66c02a12f904b73a940a42032dbd36d  29.0s  end=client_end",
  '0.68s  VONI    "Hi, I am Voni"  (greeting ttfa 586ms)  CUT at 3.50s',
  '2.90s  HEARD   "Wait, stop."  (2.90s–3.49s)',
  '5.70s  VONI    "Sorry"  (user_speech ttfa 1197ms gap 2210ms)',
  '9.00s  VONI    "It depends on volume"  (user_speech gap 900ms)  CUT at 11.00s',
  '10.40s  HEARD   "We are a bakery, actually."  (10.40s–10.99s)',
];

const TALK_EXCERPT = [
  "sess_talk  agent=agent_d66c02a12f904b73a940a42032dbd36d  33.7s  end=client_end",
  '0.71s  VONI    "Hi, I am Voni"  (greeting ttfa 628ms)',
];

const MARKERS = [
  'OVERHEARD ASIDE {"scenario":"over-talk","session":"sess_talk","text":"We are a bakery, actually.","agentText":"I can show you","replyId":"reply_9","startMs":15370,"endMs":null,"cutMs":15870}',
  'GOODBYE DRAIN {"scenario":"bye-audio","session":"sess_stop","turn":3,"coverage":0.9659,"inboxNamed":true,"narratedEnding":false}',
  "    hung up 956ms after the goodbye finished playing (session sess_stop)",
].join("\n");

test("buildRunnerEvidence folds identity, scenario verdicts and playout", () => {
  const evidence = buildRunnerEvidence({
    runnerStdout: `${MARKERS}\n${SUMMARY}`,
    excerpts: [
      { sessionId: "sess_stop", excerpt: STOP_EXCERPT },
      { sessionId: "sess_talk", excerpt: TALK_EXCERPT },
    ],
  });
  assert.ok(evidence);
  assert.equal(evidence.transport, "stored");
  assert.equal(evidence.agentId, "agent_d66c02a12f904b73a940a42032dbd36d");
  assert.equal(evidence.agentFingerprint, "fingerprint-abc");
  assert.equal(evidence.llmModel, "google/gemini-2.5-flash");
  assert.deepEqual(evidence.scenarios, [
    { name: "stop-over", passed: 1, runs: 1, wallClockMs: 27213 },
    { name: "over-talk", passed: 0, runs: 1, wallClockMs: 31768 },
  ]);
  assert.deepEqual(evidence.playout, [
    { scenario: "stop-over", run: 1, wallClockMs: 27213 },
    { scenario: "over-talk", run: 1, wallClockMs: 31768 },
  ]);
});

test("per-session turn rows carry gap, cut, heard/resume/aside flags", () => {
  const evidence = buildRunnerEvidence({
    runnerStdout: `${MARKERS}\n${SUMMARY}`,
    excerpts: [{ sessionId: "sess_stop", excerpt: STOP_EXCERPT }],
  });
  assert.ok(evidence);
  const stop = evidence.sessions.find((session) => session.id === "sess_stop");
  assert.ok(stop);
  assert.deepEqual(stop.gaps, [
    { turnIndex: 1, gapMs: null, cutMs: 3500 },
    { turnIndex: 2, gapMs: 2210, cutMs: null },
    { turnIndex: 3, gapMs: 900, cutMs: 11000 },
  ]);
  const [greeting, answer, cut] = stop.turns;
  assert.equal(greeting.cutMs, 3500);
  assert.equal(greeting.heard, true, "the greeting was cut under heard speech");
  assert.equal(greeting.aside, true, "the aside overlapped the greeting");
  assert.equal(answer.resume, true, "the first reply after the cut is the answer/resume");
  assert.equal(answer.gapMs, 2210);
  assert.equal(cut.cutMs, 11000);
  assert.equal(cut.resume, false);
  assert.equal(stop.hangUp?.delayMs, 956);
  assert.equal(stop.hangUp?.coverage, 0.9659);
  assert.equal(stop.hangUp?.inboxNamed, true);
  assert.equal(stop.hangUp?.goodbyeTurn, 3);
});

test("the aside is timing/flags only: no caller words enter runnerEvidence", () => {
  const evidence = buildRunnerEvidence({
    runnerStdout: `${MARKERS}\n${SUMMARY}`,
    excerpts: [
      { sessionId: "sess_stop", excerpt: STOP_EXCERPT },
      { sessionId: "sess_talk", excerpt: TALK_EXCERPT },
    ],
  });
  assert.ok(evidence);
  const aside = evidence.asides.find((row) => row.sessionId === "sess_talk");
  assert.ok(aside, "the OVERHEARD ASIDE marker is recorded");
  assert.equal(aside.cutMs, 15870);
  assert.equal(aside.markedOverheard, true);
  assert.equal(aside.scenario, "over-talk");
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /bakery/i);
  assert.doesNotMatch(serialized, /Wait, stop/i);
  assert.doesNotMatch(serialized, /caller/i);
});

test("an unmeasured run yields null, never an empty evidence object", () => {
  assert.equal(buildRunnerEvidence({ runnerStdout: "(dry run: eval runner skipped)" }), null);
  assert.equal(buildRunnerEvidence({ runnerStdout: "", excerpts: [] }), null);
});

test("an older summary without identity reports unknown/null, never a guess", () => {
  const summary = `EVAL SUMMARY ${JSON.stringify({
    scenario: "stop-over",
    runs: 1,
    failures: 0,
    scenarios: [{ name: "stop-over", passed: 1, runs: 1 }],
    traceSessions: [],
    playout: [],
    audioChunks: 1,
    live: true,
  })}`;
  const evidence = buildRunnerEvidence({ runnerStdout: summary });
  assert.ok(evidence);
  assert.equal(evidence.transport, "unknown");
  assert.equal(evidence.agentId, null);
  assert.equal(evidence.llmModel, null);
  assert.equal(evidence.scenarios[0].wallClockMs, null);
});

test("turn parsing tolerates package-manager header lines and non-trace rows", () => {
  const turns = turnRowsFromTraceExcerpt([
    "> voni@0.1.0 call:trace",
    "> node --env-file=.dev.vars --import tsx scripts/call-trace.mts sess_x",
    "sess_x  agent=inline  8.3s  end=client_end",
    "0.71s  VONI    \"Hi\"  (greeting ttfa 626ms)",
    "",
    "hang-up: session ended 300ms after the goodbye reply ended",
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0], {
    turnIndex: 1,
    gapMs: null,
    cutMs: null,
    heard: false,
    resume: false,
    aside: false,
  });
});

/**
 * One call's client receipt marks and Call trace for the split (ticket 03).
 * The client clock is exactly 1000ms behind the trace clock, so every expected
 * duration is a worked subtraction rather than a recomputation.
 */
const SPLIT_EXCERPT = [
  "sess_split  agent=agent_d66c  5.0s  end=client_end",
  '0.50s  HEARD   "Hi, this is the caller."  (0.50s–1.00s)',
  '1.20s  VONI    "Sure, let me help."  (user_speech ttfa 300ms gap 200ms)',
];

const SPLIT_MARKS: EvalEvent[] = [
  { atMs: 100, type: "turn.user_final", sessionId: "sess_split", turnId: "turn-1", callMs: 100 },
  { atMs: 200, type: "turn.reply_start", sessionId: "sess_split", turnId: "turn-1", replyId: "reply_1", callMs: 200 },
  { atMs: 500, type: "reply.first_audio", sessionId: "sess_split", turnId: "turn-1", replyId: "reply_1", callMs: 500, anchor: true },
];

test("a marked turn carries the split, band and report-only perceived number", () => {
  const evidence = buildRunnerEvidence({
    runnerStdout: "",
    excerpts: [{ sessionId: "sess_split", excerpt: SPLIT_EXCERPT }],
    marks: SPLIT_MARKS,
  });

  assert.ok(evidence);
  const turn = evidence.sessions[0].turns[0];
  assert.equal(turn.turnIndex, 1);
  assert.deepEqual(turn.latency, {
    turnId: "turn-1",
    endpointingMs: 100,
    generationMs: 100,
    deliveryMs: 300,
    band: "ordinary",
    perceivedMs: 1_000,
  });
  // Timings and identifiers only: the trace's words never enter the evidence.
  assert.doesNotMatch(JSON.stringify(evidence), /this is the caller|let me help/i);
});

test("a turn whose client marks never completed has no split, never a zero", () => {
  const excerpt = [
    ...SPLIT_EXCERPT,
    '2.00s  HEARD   "And one more thing."  (2.00s–2.40s)',
    '2.60s  VONI    "Go on."  (user_speech ttfa 250ms gap 200ms)',
  ];
  const marks: EvalEvent[] = [
    ...SPLIT_MARKS,
    { atMs: 1_600, type: "turn.user_final", sessionId: "sess_split", turnId: "turn-2", callMs: 1_600 },
  ];
  const evidence = buildRunnerEvidence({
    runnerStdout: "",
    excerpts: [{ sessionId: "sess_split", excerpt }],
    marks,
  });

  assert.ok(evidence);
  const [first, second] = evidence.sessions[0].turns;
  assert.ok(first.latency, "the marked turn keeps its split");
  assert.equal(second.latency, undefined, "the unmarked turn has no sample");
});

test("a caller turn cut short before its reply does not shift the next turn's marks", () => {
  const excerpt = [
    "sess_cut  agent=agent_d66c  6.0s  end=client_end",
    '0.50s  HEARD   "First, cut off."  (0.50s–1.00s)',
    '1.20s  VONI    "Sure."  (user_speech ttfa 300ms gap 200ms)  CUT at 3.10s',
    '2.50s  HEARD   "Second."  (2.50s–3.00s)',
    '3.40s  VONI    "Right."  (user_speech ttfa 200ms gap 400ms)',
  ];
  const marks: EvalEvent[] = [
    // turn-1's reply never started: only its final transcript arrived.
    { atMs: 900, type: "turn.user_final", sessionId: "sess_cut", turnId: "turn-1", callMs: 900 },
    { atMs: 500, type: "turn.user_final", sessionId: "sess_cut", turnId: "turn-2", callMs: 500 },
    { atMs: 700, type: "turn.reply_start", sessionId: "sess_cut", turnId: "turn-2", replyId: "reply_2", callMs: 700 },
    { atMs: 1_000, type: "reply.first_audio", sessionId: "sess_cut", turnId: "turn-2", replyId: "reply_2", callMs: 1_000, anchor: true },
  ];
  const evidence = buildRunnerEvidence({
    runnerStdout: "",
    excerpts: [{ sessionId: "sess_cut", excerpt }],
    marks,
  });

  assert.ok(evidence);
  const [first, second] = evidence.sessions[0].turns;
  assert.equal(first.latency, undefined);
  assert.deepEqual(second.latency, {
    turnId: "turn-2",
    endpointingMs: 100,
    generationMs: 200,
    deliveryMs: 300,
    band: "post-cut",
    perceivedMs: 1_100,
  });
});

test("the split rides in evidence without moving a single gate or reply-gap sample", () => {
  const evidence = buildRunnerEvidence({
    runnerStdout: "",
    excerpts: [{ sessionId: "sess_split", excerpt: SPLIT_EXCERPT }],
    marks: SPLIT_MARKS,
  });
  assert.ok(evidence);
  assert.ok(evidence.sessions[0].turns[0].latency);

  const withoutSplit = JSON.parse(JSON.stringify(evidence)) as typeof evidence;
  for (const session of withoutSplit.sessions) {
    for (const turn of session.turns) delete turn.latency;
  }

  const input = {
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 1_000,
    runs: 1,
    gaps: { "real-cut-answered": [1_800, 2_200] },
    traceGaps: [{ gapMs: 2_210, turnIndex: 2, sessionId: "sess_split" }],
    endCallDrain: {
      goodbyeCoverage: 0.96,
      hangUpDelayMs: 900,
      narratedEnding: false,
      inboxNamed: true,
    },
  };
  const withField = buildSkeletonArtifact({ ...input, runnerEvidence: evidence });
  const withoutField = buildSkeletonArtifact({ ...input, runnerEvidence: withoutSplit });

  assert.ok(withField.replyGap.samples >= 3, "the run has reply-gap samples to compare");
  assert.deepEqual(withField.gates, withoutField.gates);
  assert.deepEqual(withField.replyGap, withoutField.replyGap);
  assert.deepEqual(withField.beats, withoutField.beats);
});
