import test from "node:test";
import assert from "node:assert/strict";
import { buildSkeletonArtifact, DEFAULT_GATE_VOICE, type ScoreboardArtifact } from "./scoreboard";
import type {
  RunnerEvidence,
  RunnerEvidenceLatency,
  RunnerEvidenceTurn,
} from "./runner-evidence";
import { buildInspectReport, formatInspectReport } from "./scoreboard-report";
import { summarizeEvalEvents, type EvalEvent } from "./eval-events";

const EVIDENCE: RunnerEvidence = {
  transport: "stored",
  agentId: "agent_d66c02a12f904b73a940a42032dbd36d",
  agentFingerprint: "fingerprint-abc",
  llmModel: "google/gemini-2.5-flash",
  variant: "turn-window",
  variantKey: "anna:exp",
  turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
  scenarios: [
    { name: "stop-over", passed: 1, runs: 1, wallClockMs: 27213 },
    { name: "over-talk", passed: 0, runs: 1, wallClockMs: 31768 },
  ],
  sessions: [
    {
      id: "sess_stop",
      turns: [
        { turnIndex: 1, gapMs: null, cutMs: 3500, heard: true, resume: false, aside: true },
        { turnIndex: 2, gapMs: 2210, cutMs: null, heard: true, resume: true, aside: false },
      ],
      gaps: [
        { turnIndex: 1, gapMs: null, cutMs: 3500 },
        { turnIndex: 2, gapMs: 2210, cutMs: null },
      ],
      aside: {
        sessionId: "sess_stop",
        scenario: "over-talk",
        startMs: 15370,
        endMs: null,
        cutMs: 15870,
        replyId: "reply_9",
        traceTurn: 1,
        markedOverheard: true,
        inLedger: true,
        handling: "resumed-from",
      },
      hangUp: {
        sessionId: "sess_stop",
        delayMs: 956,
        coverage: 0.9659,
        inboxNamed: true,
        narratedEnding: false,
        goodbyeTurn: 2,
        scenario: "bye-audio",
      },
    },
  ],
  playout: [
    { scenario: "stop-over", run: 1, wallClockMs: 27213 },
    { scenario: "over-talk", run: 1, wallClockMs: 31768 },
  ],
  asides: [
    {
      sessionId: "sess_stop",
      scenario: "over-talk",
      startMs: 15370,
      endMs: null,
      cutMs: 15870,
      replyId: "reply_9",
      traceTurn: 1,
      markedOverheard: true,
      inLedger: true,
      handling: "resumed-from",
    },
  ],
  hangUps: [
    {
      sessionId: "sess_stop",
      delayMs: 956,
      coverage: 0.9659,
      inboxNamed: true,
      narratedEnding: false,
      goodbyeTurn: 2,
      scenario: "bye-audio",
    },
  ],
};

function artifact(runnerEvidence: RunnerEvidence | null = EVIDENCE) {
  return buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "  ✗ stop-over #1: cut too late\n",
    exitCode: 0,
    durationMs: 1000,
    runs: 1,
    dryRun: true,
    gaps: { "greeting-cut": [5000] },
    endCallDrain: {
      goodbyeCoverage: 0.9659,
      hangUpDelayMs: 956,
      narratedEnding: false,
      inboxNamed: true,
    },
    runnerEvidence,
    codeFingerprint: { head: "f7d1d4e2abcdef", dirty: true, dirtyHash: "0".repeat(64) },
    runId: "run-test",
  });
}

test("the report maps run identity, scenario verdicts, gates and sub-scores", () => {
  const report = buildInspectReport(artifact());
  assert.equal(report.run.voice, DEFAULT_GATE_VOICE);
  assert.equal(report.run.runId, "run-test");
  assert.equal(report.run.schemaVersion, 4);
  assert.equal(report.run.transport, "stored");
  assert.equal(report.run.agentId, "agent_d66c02a12f904b73a940a42032dbd36d");
  assert.equal(report.run.llmModel, "google/gemini-2.5-flash");
  assert.equal(report.run.variant, "turn-window");
  assert.equal(report.run.variantKey, "anna:exp");
  assert.deepEqual(report.run.turnWindows, {
    min_silence: 400,
    max_silence: 640,
    interruption_delay: 0,
  });
  assert.deepEqual(report.run.code, { head: "f7d1d4e2abcdef", dirty: true });
  assert.deepEqual(report.scenarios, EVIDENCE.scenarios);
  assert.equal(report.gates.length, artifact().gates.length);
  assert.equal(report.gates.find((gate) => gate.name === "reply-gap")?.status, "FAIL");
  assert.deepEqual(
    report.subScores.map((sub) => sub.name),
    ["responsiveness", "barge-in", "overheard", "naturalness", "voice"],
  );
});

test("sessions carry turn rows and the --session filter removes the rest", () => {
  const report = buildInspectReport(artifact());
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].id, "sess_stop");
  assert.equal(report.sessions[0].turns[1].resume, true);
  const filtered = buildInspectReport(artifact(), { sessionId: "sess_other" });
  assert.deepEqual(filtered.sessions, []);
  assert.deepEqual(filtered.hangUps, []);
});

test("drain, aside and hang-up numbers come from evidence", () => {
  const report = buildInspectReport(artifact());
  assert.equal(report.drain.goodbyeCoverage, 0.9659);
  assert.equal(report.drain.hangUpDelayMs, 956);
  assert.equal(report.drain.inboxNamed, true);
  const aside = report.overTalkAside;
  assert.ok(aside);
  assert.equal(aside.sessionId, "sess_stop");
  assert.equal(aside.handling, "resumed-from");
  assert.doesNotMatch(JSON.stringify(report), /bakery/i);
  assert.equal(report.hangUps[0].delayMs, 956);
  assert.deepEqual(report.playout, EVIDENCE.playout);
});

test("only the last failures are reported: failing gates plus runner ✗ lines", () => {
  const report = buildInspectReport(artifact());
  assert.ok(report.failures.some((line) => line.startsWith("FAIL reply-gap")));
  assert.ok(report.failures.some((line) => line.includes("✗ stop-over #1")));
  assert.ok(report.failures.length <= 5);
});

test("the console formatter is compact and carries identity, turns, drain and failures", () => {
  const text = formatInspectReport(buildInspectReport(artifact()));
  assert.match(text, /demo scoreboard inspect/);
  assert.match(text, /transport\s+stored/);
  assert.match(text, /agent\s+agent_d66c/);
  assert.match(text, /variant\s+turn-window\s+anna:exp/);
  assert.match(text, /windows min 400 \/ max 640 \/ interruption_delay 0/);
  assert.match(text, /scenarios \(2\)/);
  assert.match(text, /FAIL over-talk\s+0\/1\s+31768ms/);
  assert.match(text, /call-trace sessions \(1\)/);
  assert.match(text, /turn\s+1\s+gap\s+—ms\s+cutAt\s+3500ms\s+heard ✓\s+resume ·\s+aside ✓/);
  assert.match(text, /end-call drain: coverage 0\.97, hang-up 956ms, inbox named/);
  assert.match(text, /over-talk aside: session sess_stop/);
  assert.match(text, /hang-ups:/);
  assert.match(text, /FAIL reply-gap/);
  // Compact means no redacted transcript dump, only the failure line.
  assert.equal(text.split("\n").filter((line) => line.includes("✗")).length, 1);
});

test("an artifact without runnerEvidence still shows its merged Call-trace turns", () => {
  const fallback = artifact(null);
  fallback.callTrace = {
    sessionId: "sess_fallback",
    excerptSha256: "abc",
    excerpt: [
      '0.71s  VONI    "Hi"  (greeting ttfa 626ms)  CUT at 3.57s',
      '2.99s  HEARD   "Wait, stop."  (2.99s–3.56s)',
      '5.77s  VONI    "Sorry"  (user_speech ttfa 2200ms gap 2209ms)',
    ],
  };
  const report = buildInspectReport(fallback);
  assert.equal(report.run.transport, "unknown");
  assert.equal(report.run.agentId, null);
  assert.equal(report.run.variant, null, "an old artifact's variant is unknown, never guessed");
  assert.equal(report.run.variantKey, null);
  assert.equal(report.run.turnWindows, null);
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].id, "sess_fallback");
  assert.deepEqual(
    report.sessions[0].turns.map((turn) => [turn.turnIndex, turn.gapMs, turn.cutMs]),
    [
      [1, null, 3570],
      [2, 2209, null],
    ],
  );
  assert.equal(report.sessions[0].turns[1].resume, true);
  assert.equal(report.scenarios.length, 0);
});

test("an event summary is included in the report only when supplied", () => {
  const events: EvalEvent[] = [
    { atMs: 10, type: "scenario.start", scenario: "stop-over", run: 1 },
    { atMs: 20, type: "cut", sessionId: "sess_stop", cutMs: 1448 },
    { atMs: 30, type: "tool.call", sessionId: "sess_stop", name: "end_call" },
    { atMs: 40, type: "hangup", sessionId: "sess_stop", delayMs: 956 },
  ];
  const plain = buildInspectReport(artifact());
  assert.equal(plain.events, undefined);
  const report = buildInspectReport(artifact(), { events: summarizeEvalEvents(events) });
  assert.equal(report.events?.total, 4);
  const text = formatInspectReport(report);
  assert.match(text, /events \(4 lines\)/);
  assert.match(text, /counts: scenario\.start 1, cut 1, tool\.call 1, hangup 1/);
  assert.match(text, /cut\s+sess_stop cut 1448ms/);
});

test("an artifact written before the split field still validates and inspects", () => {
  // The split is additive: a schema-4 artifact from before ticket 03 carries
  // runnerEvidence but no per-turn latency, and reads exactly as it did.
  const prior = JSON.parse(JSON.stringify(artifact())) as ScoreboardArtifact;
  for (const session of prior.runnerEvidence?.sessions ?? []) {
    for (const turn of session.turns) delete turn.latency;
  }
  assert.equal(prior.schemaVersion, 4);
  const report = buildInspectReport(prior);
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].turns.some((turn) => "latency" in turn), false);
  const text = formatInspectReport(report);
  assert.match(text, /turn\s+2\s+gap\s+2210ms/);
  assert.match(text, /ordinary\s+unmeasured/);
  assert.match(text, /post-cut\s+unmeasured/);
  assert.deepEqual(
    report.latency.bands.map((band) => [
      band.band,
      band.measured.endpointing.medianMs,
      band.perceived.medianMs,
    ]),
    [
      ["ordinary", null, null],
      ["post-cut", null, null],
    ],
  );
});

const ORDINARY_SPLITS: RunnerEvidenceLatency[] = [
  { turnId: "turn-1", band: "ordinary", endpointingMs: 100, generationMs: 100, deliveryMs: 20, perceivedMs: 720 },
  { turnId: "turn-2", band: "ordinary", endpointingMs: 200, generationMs: 200, deliveryMs: 40, perceivedMs: 940 },
  { turnId: "turn-3", band: "ordinary", endpointingMs: 300, generationMs: 700, deliveryMs: 60, perceivedMs: 1560 },
];
const POST_CUT_SPLITS: RunnerEvidenceLatency[] = [
  { turnId: "turn-4", band: "post-cut", endpointingMs: 150, generationMs: 100, deliveryMs: 30, perceivedMs: 780 },
  { turnId: "turn-5", band: "post-cut", endpointingMs: 250, generationMs: 300, deliveryMs: 45, perceivedMs: 1095 },
  { turnId: "turn-6", band: "post-cut", endpointingMs: 500, generationMs: 900, deliveryMs: 70, perceivedMs: 1970 },
];

function splitTurn(turnIndex: number, latency?: RunnerEvidenceLatency): RunnerEvidenceTurn {
  return {
    turnIndex,
    gapMs: 2000,
    cutMs: null,
    heard: true,
    resume: false,
    aside: false,
    ...(latency ? { latency } : {}),
  };
}

function reportWithTurns(turns: RunnerEvidenceTurn[]) {
  const evidence: RunnerEvidence = {
    ...EVIDENCE,
    sessions: [{ ...EVIDENCE.sessions[0], turns }],
  };
  return buildInspectReport(artifact(evidence));
}

test("each turn row carries its split and band, and unmeasured turns say so", () => {
  const report = reportWithTurns([
    splitTurn(1, ORDINARY_SPLITS[0]),
    splitTurn(2),
    splitTurn(3, POST_CUT_SPLITS[0]),
  ]);
  const text = formatInspectReport(report);
  assert.match(
    text,
    /split\s+ordinary\s+endpointing 100ms\s+generation 100ms\s+delivery 20ms\s+perceived 720ms\s+\(report-only\)/,
  );
  assert.match(
    text,
    /split\s+post-cut\s+endpointing 150ms\s+generation 100ms\s+delivery 30ms\s+perceived 780ms\s+\(report-only\)/,
  );
  assert.match(text, /split\s+unmeasured/);
  // The machine output carries the same per-turn fields, unchanged.
  assert.deepEqual(report.sessions[0].turns[0].latency, ORDINARY_SPLITS[0]);
  assert.deepEqual(report.sessions[0].turns[2].latency, POST_CUT_SPLITS[0]);
  assert.equal(report.sessions[0].turns[1].latency, undefined);
});

test("the band summary gives count, median and p95 for each duration and perceived", () => {
  const report = reportWithTurns([
    ...ORDINARY_SPLITS.map((split, index) => splitTurn(index + 1, split)),
    ...POST_CUT_SPLITS.map((split, index) => splitTurn(index + 4, split)),
  ]);
  assert.deepEqual(report.latency.bands, [
    {
      band: "ordinary",
      count: 3,
      measured: {
        endpointing: { count: 3, medianMs: 200, p95Ms: 300 },
        generation: { count: 3, medianMs: 200, p95Ms: 700 },
        delivery: { count: 3, medianMs: 40, p95Ms: 60 },
      },
      perceived: { count: 3, medianMs: 940, p95Ms: 1560, reportOnly: true },
    },
    {
      band: "post-cut",
      count: 3,
      measured: {
        endpointing: { count: 3, medianMs: 250, p95Ms: 500 },
        generation: { count: 3, medianMs: 300, p95Ms: 900 },
        delivery: { count: 3, medianMs: 45, p95Ms: 70 },
      },
      perceived: { count: 3, medianMs: 1095, p95Ms: 1970, reportOnly: true },
    },
  ]);

  const text = formatInspectReport(report);
  assert.match(text, /latency split \(perceived is report-only, never gated\)/);
  assert.match(text, /ordinary \(n=3\)/);
  assert.match(text, /endpointing\s+count 3\s+median 200ms\s+p95 300ms/);
  assert.match(text, /generation\s+count 3\s+median 200ms\s+p95 700ms/);
  assert.match(text, /delivery\s+count 3\s+median 40ms\s+p95 60ms/);
  assert.match(text, /perceived\s+count 3\s+median 940ms\s+p95 1560ms\s+\(report-only\)/);
  assert.match(text, /post-cut \(n=3\)/);
  assert.match(text, /endpointing\s+count 3\s+median 250ms\s+p95 500ms/);
});

test("perceived sits beside the measured numbers, not inside them", () => {
  const report = reportWithTurns(ORDINARY_SPLITS.map((split, index) => splitTurn(index + 1, split)));
  const band = report.latency.bands[0];
  assert.deepEqual(Object.keys(band.measured).sort(), ["delivery", "endpointing", "generation"]);
  assert.equal(band.perceived.reportOnly, true);
  assert.equal("reportOnly" in band.measured.endpointing, false);
  // Serialized machine output uses the same split, so ticket 11 can extend it.
  const json = JSON.parse(JSON.stringify(report)) as typeof report;
  assert.equal(json.latency.bands[0].perceived.reportOnly, true);
});

test("empty and partial marks are unmeasured, never zero-filled samples", () => {
  const partial = {
    turnId: "turn-1",
    band: "ordinary",
    endpointingMs: 100,
    generationMs: 100,
  } as unknown as RunnerEvidenceLatency;
  const empty = reportWithTurns([]);
  const report = reportWithTurns([splitTurn(1, partial), splitTurn(2)]);

  for (const candidate of [empty, report]) {
    for (const band of candidate.latency.bands) {
      assert.equal(band.count, 0);
      assert.deepEqual(band.measured.endpointing, { count: 0, medianMs: null, p95Ms: null });
      assert.deepEqual(band.perceived, {
        count: 0,
        medianMs: null,
        p95Ms: null,
        reportOnly: true,
      });
    }
    const text = formatInspectReport(candidate);
    assert.match(text, /ordinary\s+unmeasured/);
    assert.match(text, /post-cut\s+unmeasured/);
  }
  // A turn that carries a partial split still prints unmeasured beside its row.
  assert.match(formatInspectReport(report), /split\s+unmeasured/);
});

test("something that is not a scoreboard artifact throws instead of printing a blank report", () => {
  assert.throws(() => buildInspectReport({} as never), /missing voice\/runId/);
  assert.throws(() => buildInspectReport(null as never), /not a scoreboard artifact/);
});

test("the adoption block lists every gate compactly and labels production end-of-turn neutrally", () => {
  const base = artifact();
  const report = buildInspectReport(base);
  const statuses = base.gates.map((gate) => gate.status);
  assert.deepEqual(report.adoption.gates, {
    total: statuses.length,
    pass: statuses.filter((status) => status === "PASS").length,
    info: statuses.filter((status) => status === "INFO").length,
    fail: statuses.filter((status) => status === "FAIL").length,
    failing: base.gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.name),
  });
  const text = formatInspectReport(report);
  assert.match(text, /adoption inputs \(evidence only, never a verdict\)/);
  // Every gate row is still present in the report, so the tally never hides one.
  for (const gate of base.gates) {
    assert.match(text, new RegExp(`^  ${gate.status}\\s+${gate.name}$`, "m"));
  }
  assert.match(
    text,
    new RegExp(
      `gates\\s+${statuses.length}: ${report.adoption.gates.pass} PASS, ` +
        `${report.adoption.gates.info} INFO, ${report.adoption.gates.fail} FAIL`,
    ),
  );
  // The split is reused from the band summary, never printed twice.
  assert.equal(text.match(/latency split \(perceived is report-only, never gated\)/g)?.length, 1);
  assert.match(text, /split\s+latency split above \(per-band; perceived is report-only\)/);
  // No artifact end-of-turn experiment means production, labelled neutrally: the
  // gate row above carries whether production pacing actually held.
  assert.equal(report.adoption.endOfTurn.mode, "production");
  assert.deepEqual(report.adoption.endOfTurn.turnWindows, null);
  assert.match(
    text,
    /end-of-turn\s+production \(no experiment evidence; see the end-of-turn gate row\)/,
  );
  assert.doesNotMatch(text, /experimental/);
  // Never an automated verdict word.
  assert.doesNotMatch(text, /\bsafe\b/i);
  assert.doesNotMatch(JSON.stringify(report), /\bsafe\b/i);
});

test("a variant artifact labels end-of-turn experimental, never a production pass", () => {
  const variant = artifact();
  variant.endOfTurn = {
    experimental: true,
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
    productionTurnDetection: null,
  };
  const report = buildInspectReport(variant);
  assert.deepEqual(report.adoption.endOfTurn, {
    mode: "experimental",
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
    productionTurnDetection: null,
  });
  const text = formatInspectReport(report);
  assert.match(
    text,
    /end-of-turn\s+experimental turn-window \(anna:exp; min_silence 400, max_silence 640, interruption_delay 0\) — evidence, not a production pass/,
  );
  assert.doesNotMatch(text, /end-of-turn\s+production \(no experiment evidence/);
  assert.doesNotMatch(text, /\bsafe\b/i);
});

function heard(atS: number, text: string): string {
  return `${atS.toFixed(2)}s  HEARD   "${text}"  (${atS.toFixed(2)}s–${(atS + 1).toFixed(2)}s)`;
}

function artifactWithTraces(
  sessions: { id: string; excerpt: string[] }[],
  edit?: (artifact: ScoreboardArtifact) => void,
): ScoreboardArtifact {
  const art = artifact(null);
  art.callTrace = {
    sessionId: sessions[0].id,
    excerptSha256: "abc",
    excerpt: sessions[0].excerpt,
    sessions: sessions.map((session) => ({
      sessionId: session.id,
      excerptSha256: "abc",
      excerpt: session.excerpt,
    })),
  };
  edit?.(art);
  return art;
}

test("fragment risk names tag, email and number turn ends with their session and caller turn", () => {
  const base = artifactWithTraces([
    { id: "sess_tag", excerpt: [heard(1, "So the tag is Lime 4")] },
    { id: "sess_mail", excerpt: [heard(1, "send it to hi at voni dot")] },
    { id: "sess_num", excerpt: [heard(1, "my number is 7")] },
  ]);
  base.emailInvite = { tag: "Lime 42" } as unknown as ScoreboardArtifact["emailInvite"];
  const report = buildInspectReport(base);
  assert.equal(report.adoption.fragmentRisk.status, "risk");
  assert.deepEqual(report.adoption.fragmentRisk.findings, [
    { kind: "tag", sessionId: "sess_tag", turn: 1 },
    { kind: "email", sessionId: "sess_mail", turn: 1 },
    { kind: "number", sessionId: "sess_num", turn: 1 },
  ]);
  const text = formatInspectReport(report);
  assert.match(text, /fragment\s+risk: tag at sess_tag caller turn 1; email at sess_mail caller turn 1; number at sess_num caller turn 1/);
  assert.doesNotMatch(text, /\bsafe\b/i);
});

test("a whole tag, whole spoken email and whole number are clear", () => {
  const base = artifactWithTraces([
    {
      id: "sess_whole",
      excerpt: [
        heard(1, "the tag is Lime 42"),
        heard(6, "email me at andres at casaverde dot p t"),
        heard(11, "my number is 42"),
      ],
    },
  ]);
  base.emailInvite = { tag: "Lime 42" } as unknown as ScoreboardArtifact["emailInvite"];
  const report = buildInspectReport(base);
  assert.equal(report.adoption.fragmentRisk.status, "clear");
  assert.deepEqual(report.adoption.fragmentRisk.findings, []);
  assert.match(formatInspectReport(report), /fragment\s+clear: no caller turn ended inside the tag, email or a number/);
});

test("fragment risk reads the artifact's own tag and says unmeasured without caller evidence", () => {
  const custom = artifactWithTraces([{ id: "sess_tag", excerpt: [heard(1, "the tag is Lotus 8")] }]);
  custom.emailInvite = { tag: "Lotus 82" } as unknown as ScoreboardArtifact["emailInvite"];
  const tagged = buildInspectReport(custom);
  assert.deepEqual(tagged.adoption.fragmentRisk.findings, [
    { kind: "tag", sessionId: "sess_tag", turn: 1 },
  ]);

  const noEvidence = buildInspectReport(artifact(null));
  assert.equal(noEvidence.adoption.fragmentRisk.status, "unmeasured");
  assert.deepEqual(noEvidence.adoption.fragmentRisk.findings, []);
  assert.match(formatInspectReport(noEvidence), /fragment\s+unmeasured: no caller transcript evidence/);
});

test("a redacted ledger line without a merged turn still names the risk, with no invented turn", () => {
  const art = artifact(null);
  art.transcripts = {
    sha256: "abc",
    redacted: ['heard: "the tag is Lime 4"'],
  };
  const report = buildInspectReport(art);
  assert.deepEqual(report.adoption.fragmentRisk.findings, [
    { kind: "tag", sessionId: null, turn: null },
  ]);
  assert.match(formatInspectReport(report), /fragment\s+risk: tag at an unnamed caller turn/);
});

test("an incomplete clause continued by the next caller turn is named; a finished one is clear", () => {
  const continued = artifactWithTraces([
    {
      id: "sess_inc",
      excerpt: [heard(1, "I was going to"), heard(4, "the price is on the site")],
    },
  ]);
  const report = buildInspectReport(continued);
  assert.equal(report.adoption.incompleteClause.status, "risk");
  assert.deepEqual(report.adoption.incompleteClause.findings, [
    { sessionId: "sess_inc", turn: 1, nextTurn: 2 },
  ]);
  assert.match(formatInspectReport(report), /incomplete\s+risk: sess_inc caller turn 1 → 2/);

  const finished = artifactWithTraces([
    {
      id: "sess_done",
      excerpt: [heard(1, "We run a dental clinic in Lisbon."), heard(4, "What is the price?")],
    },
  ]);
  const clear = buildInspectReport(finished);
  assert.equal(clear.adoption.incompleteClause.status, "clear");
  assert.deepEqual(clear.adoption.incompleteClause.findings, []);
  assert.match(
    formatInspectReport(clear),
    /incomplete\s+clear: no turn ended on a clause the next turn continues/,
  );
});

test("incomplete-clause and interrupted inputs print unmeasured when the artifact has no evidence", () => {
  const report = buildInspectReport(artifact(null));
  assert.equal(report.adoption.incompleteClause.status, "unmeasured");
  assert.equal(report.adoption.interruptedTurns, null);
  const text = formatInspectReport(report);
  assert.match(text, /incomplete\s+unmeasured: no caller transcript evidence/);
  assert.match(text, /interrupted\s+unmeasured: no Call-trace turn evidence/);
  assert.doesNotMatch(text, /\bsafe\b/i);
});

test("the interrupted-turn count comes from Call trace CUT rows and can be a measured zero", () => {
  const evidence = buildInspectReport(artifact());
  assert.equal(evidence.adoption.interruptedTurns, 1);
  assert.match(formatInspectReport(evidence), /interrupted\s+1 turn cut/);

  const uncut = artifactWithTraces([
    {
      id: "sess_uncut",
      excerpt: [heard(1, "What is the price?"), '5.00s  VONI    "It starts at"  (user_speech ttfa 900ms gap 850ms)'],
    },
  ]);
  const zero = buildInspectReport(uncut);
  assert.equal(zero.adoption.interruptedTurns, 0);
  assert.match(formatInspectReport(zero), /interrupted\s+0 turns cut/);
});

test("a complete answer that ends on a pronoun is not an incomplete clause", () => {
  const art = artifactWithTraces([
    {
      id: "sess_refusal",
      excerpt: [
        heard(1, "What kind of business do I run? I don't want to tell you."),
        heard(6, "No. I'm not telling you anything."),
      ],
    },
  ]);
  const report = buildInspectReport(art);
  assert.equal(report.adoption.incompleteClause.status, "clear");
});
