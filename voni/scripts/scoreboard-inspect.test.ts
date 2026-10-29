import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CASCADE_NO_COMMIT_MARK_ABSENCE,
  CASCADE_PLATFORM_CAPTURE_ABSENCE,
  ONE_CALL_NO_P95_ABSENCE,
  buildSkeletonArtifact,
  DEFAULT_GATE_VOICE,
} from "../src/lib/demo/scoreboard";
import type { RunnerEvidence } from "../src/lib/demo/runner-evidence";

const SCRIPT = new URL("./scoreboard-inspect.mts", import.meta.url).pathname;
const ROOT = new URL("../", import.meta.url).pathname;

function run(args: string[]) {
  return spawnSync("node", ["--import", "tsx", SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH },
  });
}

const EVIDENCE: RunnerEvidence = {
  transport: "stored",
  agentId: "agent_d66c02a12f904b73a940a42032dbd36d",
  agentFingerprint: "fingerprint-abc",
  llmModel: "google/gemini-2.5-flash",
  scenarios: [{ name: "stop-over", passed: 1, runs: 1, wallClockMs: 27213 }],
  sessions: [
    {
      id: "sess_stop",
      turns: [
        {
          turnIndex: 1,
          gapMs: null,
          cutMs: 3500,
          heard: true,
          resume: false,
          aside: false,
          latency: {
            turnId: "turn-1",
            band: "post-cut",
            endpointingMs: 150,
            generationMs: 100,
            deliveryMs: 30,
            perceivedMs: 780,
          },
        },
        {
          turnIndex: 2,
          gapMs: 2210,
          cutMs: null,
          heard: true,
          resume: true,
          aside: false,
          latency: {
            turnId: "turn-2",
            band: "ordinary",
            endpointingMs: 100,
            generationMs: 200,
            deliveryMs: 40,
            perceivedMs: 840,
          },
        },
      ],
      gaps: [
        { turnIndex: 1, gapMs: null, cutMs: 3500 },
        { turnIndex: 2, gapMs: 2210, cutMs: null },
      ],
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
  playout: [{ scenario: "stop-over", run: 1, wallClockMs: 27213 }],
  asides: [],
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

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-inspect-"));
  const artifact = buildSkeletonArtifact({
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
    runnerEvidence: EVIDENCE,
    codeFingerprint: { head: "f7d1d4e2abcdef", dirty: true, dirtyHash: "0".repeat(64) },
    runId: "run-inspect",
  });
  const path = join(dir, "score.json");
  writeFileSync(path, JSON.stringify(artifact));
  return path;
}

test("inspect prints the compact triage view", () => {
  const path = writeFixture();
  const result = run(["--artifact", path]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /demo scoreboard inspect/);
  assert.match(result.stdout, /transport\s+stored/);
  assert.match(result.stdout, /scenarios \(1\)/);
  assert.match(result.stdout, /PASS stop-over\s+1\/1\s+27213ms/);
  assert.match(result.stdout, /call-trace sessions \(1\)/);
  assert.match(result.stdout, /turn\s+2\s+gap\s+2210ms/);
  assert.match(result.stdout, /end-call drain: coverage 0\.97, hang-up 956ms, inbox named/);
  assert.match(result.stdout, /failures \(2\)/);
  assert.match(result.stdout, /FAIL reply-gap/);
  assert.match(result.stdout, /✗ stop-over #1/);
});

test("inspect reads a cascade artifact through the one reader and prints the same gap rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "inspect-"));
  const path = join(dir, "cascade.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...buildSkeletonArtifact({
        voice: DEFAULT_GATE_VOICE,
        scenario: "all",
        runnerStdout: "",
        exitCode: 0,
        durationMs: 0,
        runs: 1,
        dryRun: true,
        runId: "run-cascade-inspect",
      }),
      pipeline: "cascade",
      subject: {
        agent: { kind: "demo", voice: "anna", agentId: null },
        locale: "en",
        transport: "browser",
        source: "flag",
        pipeline: "cascade",
      },
      run: {
        runId: "run-cascade-inspect",
        variant: "cascade",
        startedAt: "2026-10-29T10:00:00.000Z",
        finishedAt: "2026-10-29T10:00:03.000Z",
      },
      providers: { stt: "assemblyai-meta", llm: "meta-llama-3.3", tts: "meta-speech" },
      latency: {
        screenToFirstPartialMs: 180,
        speechCompleteToFirstTokenMs: 240,
        replyGapP50Ms: 510,
        replyGapP95Ms: { absent: ONE_CALL_NO_P95_ABSENCE },
        commitToFirstPlayoutMs: { absent: CASCADE_NO_COMMIT_MARK_ABSENCE },
      },
      cost: {
        currency: "USD",
        rateTableVersion: "rates-2026-10-29",
        legs: { stt: 0.0031, llm: 0.0024, tts: 0.0045 },
        total: 0.01,
      },
      captures: {
        reference: { path: "artifacts/reference.wav", sha256: "a".repeat(64) },
        platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
        delivered: { path: "artifacts/delivered.wav", sha256: "b".repeat(64) },
      },
      eligibility: { eligible: true },
    }),
  );

  const result = run(["--artifact", path]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pipeline\s+cascade/);
  assert.match(result.stdout, /screen latency\s+180ms/);
  assert.match(result.stdout, /think\s+240ms/);
  assert.match(result.stdout, /reply gap p50\s+510ms/);
  assert.match(result.stdout, /commit to playout\s+N\/A — the cascade has no commit mark/);
});

test("inspect refuses an unknown schema version instead of casting it blindly", () => {
  const dir = mkdtempSync(join(tmpdir(), "inspect-"));
  const path = join(dir, "future.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 99,
      voice: "anna",
      runId: "run-future",
      recordedAt: "2026-10-29T10:00:00.000Z",
      gates: [],
      subScores: [],
      beats: {},
      replyGap: { p50Ms: null, p95Ms: null, samples: 0 },
      endCallDrain: {},
    }),
  );
  const result = run(["--artifact", path]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /schemaVersion/);
  assert.match(result.stderr, /99/);
});

test("--json prints the same compact structure", () => {
  const path = writeFixture();
  const result = run(["--artifact", path, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    run: { transport: string; agentId: string; code: { dirty: boolean } };
    scenarios: { name: string }[];
    sessions: { id: string; turns: { turnIndex: number }[] }[];
    gates: { name: string; status: string }[];
    failures: string[];
  };
  assert.equal(report.run.transport, "stored");
  assert.equal(report.run.agentId, "agent_d66c02a12f904b73a940a42032dbd36d");
  assert.equal(report.run.code.dirty, true);
  assert.deepEqual(report.scenarios.map((row) => row.name), ["stop-over"]);
  assert.equal(report.sessions[0].turns.length, 2);
  assert.ok(report.gates.some((gate) => gate.name === "reply-gap" && gate.status === "FAIL"));
});

test("--json exposes the per-turn split and the per-band summary", () => {
  const path = writeFixture();
  const result = run(["--artifact", path, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    sessions: {
      turns: {
        latency?: {
          band: string;
          endpointingMs: number;
          generationMs: number;
          deliveryMs: number;
          perceivedMs: number;
        };
      }[];
    }[];
    latency: {
      bands: {
        band: string;
        count: number;
        measured: { endpointing: { medianMs: number; p95Ms: number } };
        perceived: { medianMs: number; p95Ms: number; reportOnly: boolean };
      }[];
    };
  };
  assert.deepEqual(report.sessions[0].turns[0].latency, {
    turnId: "turn-1",
    band: "post-cut",
    endpointingMs: 150,
    generationMs: 100,
    deliveryMs: 30,
    perceivedMs: 780,
  });
  const ordinary = report.latency.bands.find((band) => band.band === "ordinary");
  assert.ok(ordinary);
  assert.equal(ordinary.count, 1);
  assert.deepEqual(ordinary.measured.endpointing, { count: 1, medianMs: 100, p95Ms: 100 });
  assert.deepEqual(ordinary.perceived, {
    count: 1,
    medianMs: 840,
    p95Ms: 840,
    reportOnly: true,
  });
});

test("--session narrows the Call-trace rows and an unknown id exits 1", () => {
  const path = writeFixture();
  const filtered = run(["--artifact", path, "--session", "sess_stop", "--json"]);
  assert.equal(filtered.status, 0, filtered.stderr);
  const report = JSON.parse(filtered.stdout) as { sessions: { id: string }[]; hangUps: unknown[] };
  assert.deepEqual(report.sessions.map((session) => session.id), ["sess_stop"]);
  assert.equal(report.hangUps.length, 1);

  const unknown = run(["--artifact", path, "--session", "sess_nope"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no Call-trace session sess_nope/);
});

test("--events summarizes the eval JSONL compactly", () => {
  const path = writeFixture();
  const events = join(mkdtempSync(join(tmpdir(), "scoreboard-events-")), "events.jsonl");
  writeFileSync(
    events,
    [
      { atMs: 10, type: "scenario.start", scenario: "stop-over", run: 1 },
      { atMs: 20, type: "session.ready", sessionId: "sess_stop" },
      { atMs: 30, type: "cut", sessionId: "sess_stop", cutMs: 1448, overlapMs: 0 },
      { atMs: 40, type: "tool.call", sessionId: "sess_stop", name: "end_call" },
      { atMs: 50, type: "hangup", sessionId: "sess_stop", delayMs: 956 },
      { atMs: 60, type: "scenario.end", scenario: "stop-over", run: 1, passed: true },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  const result = run(["--artifact", path, "--events", events]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /events \(6 lines\)/);
  assert.match(result.stdout, /counts: scenario\.start 1, session\.ready 1, cut 1, tool\.call 1, hangup 1, scenario\.end 1/);
  assert.match(result.stdout, /cut\s+sess_stop cut 1448ms overlap 0ms/);
  assert.match(result.stdout, /hangup\s+sess_stop 956ms/);
});

test("a missing artifact is a clear error with exit 1", () => {
  const result = run(["--artifact", "/tmp/definitely-not-a-scoreboard.json"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read artifact/);
  assert.match(result.stderr, /definitely-not-a-scoreboard\.json/);
  assert.doesNotMatch(result.stdout, /demo scoreboard inspect/);
});

test("an unreadable artifact and a broken event stream exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-broken-"));
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{");
  const result = run(["--artifact", broken]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not JSON/);

  const path = writeFixture();
  const events = join(dir, "events.jsonl");
  writeFileSync(events, "not json\n");
  const badEvents = run(["--artifact", path, "--events", events]);
  assert.equal(badEvents.status, 1);
  assert.match(badEvents.stderr, /events .*:1: not valid JSON/);
});

test("a missing --artifact prints usage instead of a blank report", () => {
  const result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--artifact <path> is required/);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /scoreboard:inspect/);
});
