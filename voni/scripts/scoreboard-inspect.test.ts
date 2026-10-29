import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildSkeletonArtifact, DEFAULT_GATE_VOICE } from "../src/lib/demo/scoreboard";
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
  assert.match(result.stderr, /does not exist/);
  assert.doesNotMatch(result.stdout, /demo scoreboard inspect/);
});

test("an unreadable artifact and a broken event stream exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-broken-"));
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{");
  const result = run(["--artifact", broken]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/);

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
