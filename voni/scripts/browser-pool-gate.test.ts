/**
 * The pool gate: the one thing between a dispatched Segment and a Click.
 *
 * The workflow refuses to click unless this reports at least three ready US
 * exits, so its rules are checked here rather than trusted to a shell step. Two
 * promises matter more than the rest: the wait is bounded, and a refusal names
 * why — a gate that hangs or that fails without a sentence is a run nobody can
 * diagnose. Nothing in the report may carry the account.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  POOL_GATE_MIN_READY,
  POOL_GATE_POLL_MS,
  POOL_GATE_TIMEOUT_MS,
  POOL_REPORT_PATH,
  attachClientLog,
  buildPoolReport,
  evaluatePoolGate,
  finalSnapshot,
  mergeFinalReport,
  MAX_CLIENT_LOG_CHARS,
  readClientLogTail,
  redactCredentials,
  waitForPoolGate,
  writePoolReport,
} from "./browser-pool-gate.mjs";

const VONI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(VONI, "scripts", "browser-pool-gate.mjs");

const EXIT = (n: number) => ({
  exitId: `exit-${n}`,
  ip: `198.51.100.${n}`,
  country: "US",
  asn: "7018",
  city: "Dallas",
  state: "Texas",
});

const THREE = [EXIT(11), EXIT(12), EXIT(13)];

function health(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    ready: 3,
    pool: THREE,
    buckets: [
      {
        clientIpHash: "0123456789abcdef",
        used: 4,
        limit: 10,
        remaining: 6,
        resetAt: "2026-11-26T13:26:00.000Z",
      },
    ],
    reconnects: 0,
    refills: 5,
    lastError: null,
    account: { tier: "free", premium: false, clientIp: "203.0.113.9" },
    session: { state: "connected", frames: ["LIMITS_INFO"] },
    ...overrides,
  };
}

/** A clock the test moves, so a bounded wait is checked without waiting. */
function fakeClock() {
  let ms = 1_000;
  return {
    now: () => ms,
    sleep: async (delay: number) => {
      ms += delay;
    },
    at: () => ms,
  };
}

/** A control port that answers from a list, one entry per request. */
function scriptedClient(replies: Array<Record<string, unknown> | Error | number>) {
  let index = 0;
  const fetcher = (async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply instanceof Error) throw reply;
    if (typeof reply === "number") return new Response("no", { status: reply });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => index };
}

test("three ready US exits are a gate a Click may pass", () => {
  const verdict = evaluatePoolGate(health());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.ready, 3);
  assert.equal(verdict.exits.length, 3);
  assert.equal(verdict.refills, 5);
});

test("fewer than three exits is a refusal that says how short it is", () => {
  const verdict = evaluatePoolGate(health({ ready: 2, pool: THREE.slice(0, 2) }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "short-of-exits");
  assert.equal(verdict.retryable, true, "a refill may still fill the pool");
  assert.match(verdict.detail ?? "", /2 of 3/);
});

test("an exit the runner could not use is refused, never counted", () => {
  const verdict = evaluatePoolGate(
    health({
      ready: 4,
      pool: [...THREE, { ...EXIT(14), country: "DE" }],
    }),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "no-us-exit");
  assert.equal(verdict.retryable, false, "waiting cannot turn a German exit into a US one");
});

test("a client that failed is named at once, not waited on", () => {
  const verdict = evaluatePoolGate(
    health({
      ok: false,
      ready: 0,
      pool: [],
      lastError: { reason: "credential-missing", message: "no relay credential configured" },
      session: { state: "failed", frames: [] },
    }),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "credential-missing");
  assert.equal(verdict.retryable, false);
});

test("an exhausted account is quota-spent, not a thin supply", () => {
  const verdict = evaluatePoolGate(
    health({
      ready: 1,
      pool: THREE.slice(0, 1),
      buckets: [
        { clientIpHash: null, used: 10, limit: 10, remaining: 0, resetAt: "2026-11-26T13:26:00.000Z" },
      ],
    }),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "quota-spent");
  assert.equal(verdict.retryable, false);
});

test("the wait polls until the third exit arrives, then stops", async () => {
  const clock = fakeClock();
  const client = scriptedClient([
    health({ ready: 0, pool: [] }),
    health({ ready: 1, pool: THREE.slice(0, 1) }),
    health(),
  ]);

  const verdict = await waitForPoolGate({
    controlUrl: "http://127.0.0.1:41000",
    timeoutMs: 60_000,
    pollMs: 1_000,
    fetcher: client.fetcher,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.attempts, 3, "it stopped on the first passing report");
  assert.equal(client.calls(), 3, "and asked the control port no more times");
  assert.ok(verdict.waitedMs < 60_000);
});

test("the wait is bounded and keeps the last reason, which is the report's why", async () => {
  const clock = fakeClock();
  const client = scriptedClient([health({ ready: 1, pool: THREE.slice(0, 1) })]);

  const verdict = await waitForPoolGate({
    controlUrl: "http://127.0.0.1:41000",
    timeoutMs: 5_000,
    pollMs: 1_000,
    fetcher: client.fetcher,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "short-of-exits");
  assert.match(verdict.detail ?? "", /1 of 3/);
  assert.equal(verdict.waitedMs, 5_000, "the bound is the timeout, not a lucky poll");
  assert.ok(verdict.attempts >= 5);
});

test("a control port that never answers is a bounded refusal too", async () => {
  const clock = fakeClock();
  const client = scriptedClient([new Error("connect ECONNREFUSED 127.0.0.1:41000")]);

  const verdict = await waitForPoolGate({
    controlUrl: "http://127.0.0.1:41000",
    timeoutMs: 3_000,
    pollMs: 1_000,
    fetcher: client.fetcher,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "control-unreachable");
  assert.match(verdict.detail ?? "", /ECONNREFUSED/);
  assert.equal(verdict.waitedMs, 3_000);
});

test("the report names every exit, its city and ASN, the refills and the failure", () => {
  const verdict = evaluatePoolGate(health());
  const report = buildPoolReport({ gate: { ...verdict, attempts: 2, waitedMs: 4_000 } });

  assert.equal(report.minReady, POOL_GATE_MIN_READY);
  assert.equal(report.gate.ok, true);
  assert.equal(report.gate.attempts, 2);
  assert.equal(report.gate.waitedMs, 4_000);
  assert.equal(report.gate.refills, 5);
  assert.deepEqual(
    report.gate.exits.map((exit: { ip: string; city: string; asn: string }) => [
      exit.ip,
      exit.city,
      exit.asn,
    ]),
    THREE.map((exit) => [exit.ip, exit.city, exit.asn]),
  );

  const refused = buildPoolReport({
    gate: evaluatePoolGate(health({ ready: 0, pool: [] })),
  });
  assert.equal(refused.gate.ok, false);
  assert.equal(refused.gate.reason, "short-of-exits");
  assert.match(refused.gate.detail, /0 of 3/, "a failed gate says why");
  assert.deepEqual(refused.final, null, "a gate that failed has no run to report on");
});

test("no credential reaches the report or the file it is written to", () => {
  const account = "operator@example.test";
  const password = "correct-horse-battery";
  const env = { TUXLER_USERNAME: account, TUXLER_PASSWD: password };

  const verdict = evaluatePoolGate(
    health({
      ok: false,
      ready: 0,
      pool: [],
      lastError: { reason: "connect-failed", message: `login failed for ${account}` },
    }),
  );
  const report = buildPoolReport({ gate: verdict, env });
  const text = JSON.stringify(report);

  assert.ok(!text.includes(account), "the report carried the account");
  assert.ok(!text.includes(password), "the report carried the password");
  assert.match(text, /\[redacted\]/);

  const dir = mkdtempSync(join(tmpdir(), "pool-report-"));
  try {
    const path = join(dir, "pool-report.json");
    writePoolReport(path, report);
    const written = readFileSync(path, "utf8");
    assert.ok(!written.includes(account));
    assert.ok(!written.includes(password));
    assert.equal(JSON.parse(written).gate.reason, "connect-failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(redactCredentials(`a ${account} b`, env), "a [redacted] b");
  assert.equal(
    redactCredentials("198.51.100.11 and 7018", env),
    "198.51.100.11 and 7018",
    "an exit address and an ASN are the proof, not a credential",
  );
});

test("a final snapshot adds the run's counts and keeps the gate's verdict", () => {
  const gate = buildPoolReport({ gate: evaluatePoolGate(health()) });
  const final = finalSnapshot(
    health({ ready: 4, pool: [EXIT(21), EXIT(22), EXIT(23), EXIT(24)], refills: 17, reconnects: 1 }),
    null,
    "2026-11-25T12:00:00.000Z",
  );

  const merged = mergeFinalReport(gate, final);
  assert.equal(merged.gate.ok, true, "the gate's verdict is not rewritten by the end state");
  assert.equal(merged.final.refills, 17);
  assert.equal(merged.final.reconnects, 1);
  assert.equal(merged.final.exits.length, 4);
  assert.equal(merged.final.checkedAt, "2026-11-25T12:00:00.000Z");

  const lost = finalSnapshot(undefined, "the control port did not answer", "2026-11-25T12:00:01.000Z");
  const stillMerged = mergeFinalReport(gate, lost);
  assert.equal(stillMerged.final.ok, false);
  assert.match(stillMerged.final.error, /did not answer/);
});

test("the gate is three exits, a three-minute bound and a report beside the screenshots", () => {
  assert.equal(POOL_GATE_MIN_READY, 3);
  assert.equal(POOL_GATE_TIMEOUT_MS, 180_000);
  assert.ok(POOL_GATE_POLL_MS > 0 && POOL_GATE_POLL_MS < POOL_GATE_TIMEOUT_MS);
  assert.equal(POOL_REPORT_PATH, "pool-report.json");
});

function runGate(
  env: Record<string, string>,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["TUXLER_ENABLED", "TUXLER_CONTROL_URL"]) delete childEnv[name];
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: VONI,
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("the gate refuses to run at all while the flag is off", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-off-"));
  try {
    const path = join(dir, "pool-report.json");
    const result = runGate({ TUXLER_ENABLED: "false" }, ["--report", path]);
    assert.equal(result.status, 2, "the workflow skips this step; a manual run must not pass");
    assert.match(result.stderr, /TUXLER_ENABLED/);
    assert.throws(() => readFileSync(path, "utf8"), "a disabled gate writes no report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gate with no control address fails fast and writes the reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-nourl-"));
  try {
    const path = join(dir, "pool-report.json");
    const result = runGate({ TUXLER_ENABLED: "true" }, ["--report", path]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TUXLER_CONTROL_URL/);
    const report = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(report.gate.ok, false);
    assert.equal(report.gate.reason, "bad-control-url");
    assert.equal(report.gate.ready, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate cannot click, because it holds no browser", () => {
  const text = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(text, /playwright|chromium|newContext/i, "the gate is not a click path");
  // The account is read once, only so a report can scrub it; it is never printed.
  assert.doesNotMatch(text, /console\.[a-z]+\([^)]*TUXLER_(?:USERNAME|PASSWD|PASSWORD|EMAIL)/);
});

test("a gate that could not reach the client carries the client's own reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-log-"));
  const account = "operator@example.test";
  const env = { TUXLER_USERNAME: account, TUXLER_PASSWD: "correct-horse-battery" };
  try {
    const log = join(dir, "tuxler-client.log");
    writeFileSync(
      log,
      [
        `tuxler-proxy: serving 127.0.0.1:41000`,
        `{"ok":false,"lastError":{"reason":"credential-missing","message":"login for ${account} was refused"}}`,
        `tuxler-proxy: relay closed the session`,
      ].join("\n"),
    );

    const tail = readClientLogTail(log, 2);
    assert.ok(tail !== null);
    assert.match(tail, /relay closed/, "the tail keeps the last lines, not the whole file");
    assert.doesNotMatch(tail, /serving 127\.0\.0\.1:41000/, "the earliest lines are dropped");
    assert.equal(readClientLogTail(join(dir, "absent.log")), null, "no log is not an error");

    const report = buildPoolReport({
      gate: { ...evaluatePoolGate(null), clientLog: tail },
      env,
    });
    const text = JSON.stringify(report);
    assert.match(text, /relay closed the session/, "the client's reason is in the artifact");
    assert.ok(!text.includes(account), "the account is not");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gate that ran short of exits carries the client's own reason too", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-short-log-"));
  const account = "operator@example.test";
  const env = { TUXLER_USERNAME: account, TUXLER_PASSWD: "correct-horse-battery" };
  try {
    const log = join(dir, "tuxler-client.log");
    writeFileSync(
      log,
      [
        `tuxler-proxy: serving 127.0.0.1:41000`,
        `tuxler-proxy: login for ${account} accepted`,
        `tuxler-proxy: refill returned 1 exit, 2 short of the gate`,
      ].join("\n"),
    );

    const verdict = evaluatePoolGate(health({ ready: 1, pool: THREE.slice(0, 1) }));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "short-of-exits", "the port opened; only the pool was thin");

    const report = buildPoolReport({ gate: attachClientLog(verdict, log), env });
    assert.equal(report.gate.reason, "short-of-exits");
    assert.match(
      report.gate.clientLog ?? "",
      /2 short of the gate/,
      "a thin pool quotes the client's log, not only an unreachable port",
    );
    assert.ok(
      !JSON.stringify(report).includes(account),
      "the tail is redacted like the rest of the report",
    );
    assert.match(report.gate.clientLog, /login for \[redacted\] accepted/);

    const passed = attachClientLog(evaluatePoolGate(health()), log);
    assert.ok(!("clientLog" in passed), "a passing gate reads no log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a huge client log is quoted by its end, not rejected as one oversized field", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-log-cap-"));
  try {
    const log = join(dir, "tuxler-client.log");
    const inventory = Array.from({ length: 40 }, (_, at) => `refill #${at} ${"x".repeat(900)}`);
    writeFileSync(log, [...inventory, "refill #40 reason=limit the bucket is spent"].join("\n"));

    const tail = readClientLogTail(log);
    assert.ok(tail !== null);
    assert.ok(
      tail.length <= MAX_CLIENT_LOG_CHARS,
      "the quote stays inside the report parser's field cap",
    );
    assert.match(tail, /the bucket is spent/, "the end of the log is the part kept");

    const report = buildPoolReport({
      gate: attachClientLog(evaluatePoolGate(health({ ready: 0, pool: [] })), log),
      env: {},
    });
    assert.ok(
      JSON.stringify(report).length < 16_000,
      "an oversized quote would make the whole gate record unparseable",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report path the workflow uploads is written, even from a failed gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-write-"));
  try {
    const path = join(dir, POOL_REPORT_PATH);
    writePoolReport(path, buildPoolReport({ gate: evaluatePoolGate(null) }));
    const report = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(report.gate.ok, false);
    assert.equal(report.gate.reason, "control-unreachable");
    writeFileSync(path, JSON.stringify({ ...report, gate: { ...report.gate, reason: "quota-spent" } }));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).gate.reason, "quota-spent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
