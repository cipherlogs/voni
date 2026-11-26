/**
 * The pool-report shape and its two queries, proved without a database.
 *
 * The shape is the artifact `scripts/browser-pool-gate.mjs` writes, so the
 * fixture here is that script's own output rather than an invented schema. The
 * reads are asserted as SQL because "newest first" and "one row per OS" are the
 * observable contract, and a live Postgres is not part of the unit suite.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  POOL_REPORT_PRODUCER,
  latestPoolReportQuery,
  parsePoolReport,
  parsePoolReportRunnerOs,
  poolReportUpsert,
  readLatestPoolReport,
  storePoolReport,
  type LatestPoolReport,
  type PoolReportInput,
  type PoolReportStore,
  type TuxlerPoolReport,
} from "./pool-report";

const CHECKED_AT = "2026-11-26T08:00:00.000Z";
const FINISHED_AT = "2026-11-26T09:00:00.000Z";

const EXITS = [
  {
    exitId: "exit-1",
    ip: "198.51.100.24",
    country: "US",
    asn: "7018",
    city: "Ashburn",
    state: "VA",
  },
  {
    exitId: null,
    ip: null,
    country: null,
    asn: null,
    city: null,
    state: null,
  },
];

/** `buildPoolReport({ gate })` followed by `mergeFinalReport`. */
const REPORT: TuxlerPoolReport = {
  enabled: true,
  minReady: 3,
  gate: {
    ok: true,
    reason: null,
    detail: null,
    attempts: 2,
    waitedMs: 4_000,
    checkedAt: CHECKED_AT,
    ready: 3,
    exits: EXITS,
    refills: 1,
    reconnects: 0,
    lastError: null,
    clientLog: null,
  },
  final: {
    ok: true,
    error: null,
    checkedAt: FINISHED_AT,
    ready: 3,
    exits: EXITS,
    refills: 2,
    reconnects: 1,
    lastError: null,
  },
};

test("the script's report parses to itself, key for key", () => {
  const parsed = parsePoolReport(REPORT);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  assert.deepEqual(parsed.value, REPORT);
});

test("a failed gate keeps its reason, its detail and the client log", () => {
  const failed = {
    ...REPORT,
    gate: {
      ...REPORT.gate,
      ok: false,
      reason: "control-unreachable",
      detail: "no health report was read",
      ready: 0,
      exits: [],
      clientLog: "relay: login refused",
    },
    final: {
      ok: false,
      error: "the control port did not answer",
      checkedAt: FINISHED_AT,
      ready: null,
      exits: [],
      refills: null,
      reconnects: null,
      lastError: null,
    },
  };

  const parsed = parsePoolReport(failed);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  assert.equal(parsed.value.gate.reason, "control-unreachable");
  assert.equal(parsed.value.gate.clientLog, "relay: login refused");
  assert.equal(parsed.value.final?.ready, null);
});

test("the first write's final half is null and still valid", () => {
  const parsed = parsePoolReport({ ...REPORT, final: null });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.final, null);
});

test("unknown keys are dropped, so the stored report has one shape", () => {
  const parsed = parsePoolReport({
    ...REPORT,
    gate: { ...REPORT.gate, extra: "not part of the report" },
    upstream: "not part of the report",
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal("upstream" in parsed.value, false);
  assert.equal("extra" in parsed.value.gate, false);
});

test("malformed shapes are refused with a reason, never thrown", () => {
  const cases: Array<[unknown, string]> = [
    [null, "not_object"],
    [[], "not_object"],
    ["a report", "not_object"],
    [{ ...REPORT, enabled: false }, "not_enabled"],
    [{ ...REPORT, minReady: 0 }, "bad_min_ready"],
    [{ ...REPORT, gate: null }, "bad_gate"],
    [{ ...REPORT, gate: { ...REPORT.gate, checkedAt: "yesterday" } }, "bad_gate"],
    [{ ...REPORT, gate: { ...REPORT.gate, ready: -1 } }, "bad_gate"],
    [
      { ...REPORT, gate: { ...REPORT.gate, exits: [{ ip: "198.51.100.24" }] } },
      "bad_gate",
    ],
    [{ ...REPORT, gate: { ...REPORT.gate, lastError: "boom" } }, "bad_gate"],
    [{ ...REPORT, final: { ok: "yes" } }, "bad_final"],
    [{ ...REPORT, final: { ...REPORT.final, ready: -2 } }, "bad_final"],
  ];

  for (const [raw, reason] of cases) {
    const parsed = parsePoolReport(raw);
    assert.equal(parsed.ok, false, `${JSON.stringify(raw)} was accepted`);
    if (parsed.ok) continue;
    assert.equal(parsed.reason, reason);
  }
});

test("a runner OS is the click intake's own allowlist, normalised", () => {
  assert.equal(parsePoolReportRunnerOs("ubuntu"), "ubuntu");
  assert.equal(parsePoolReportRunnerOs(" macOS "), "macos");
  assert.equal(parsePoolReportRunnerOs("linux"), null);
  assert.equal(parsePoolReportRunnerOs(""), null);
  assert.equal(parsePoolReportRunnerOs(null), null);
});

test("a valid report upserts on (producer, runner_os) and replaces the report", () => {
  const receivedAt = new Date("2026-11-26T10:00:00.000Z");
  const input: PoolReportInput = {
    producer: POOL_REPORT_PRODUCER,
    runnerOs: "ubuntu",
    report: REPORT,
  };

  const { sql, params } = poolReportUpsert(input, receivedAt).toSQL();

  assert.match(sql, /insert into "tuxler_pool_reports"/i);
  assert.match(
    sql,
    /on conflict \("producer"\s*,\s*"runner_os"\) do update set/i,
    "the conflict target is the unique pair, so one OS keeps one row",
  );
  assert.match(sql, /"received_at"\s*=\s*\$\d+/i, "the arrival time is rewritten");
  assert.match(sql, /"report"\s*=\s*\$\d+/i, "the report is replaced, not appended");
  assert.deepEqual(params.slice(0, 3), [
    "github",
    "ubuntu",
    "2026-11-26T10:00:00.000Z",
  ]);
  // The driver serialises jsonb, so the stored document is compared parsed.
  assert.deepEqual(JSON.parse(String(params[3])), REPORT);
});

test("the newest report is read first, and narrowed by OS when asked", () => {
  const all = latestPoolReportQuery().toSQL();
  assert.match(all.sql, /from "tuxler_pool_reports"/i);
  assert.match(all.sql, /"producer"\s*=\s*\$\d+/i);
  assert.doesNotMatch(
    all.sql,
    /"runner_os"\s*=\s*\$\d+/i,
    "the newest row overall is not narrowed by OS",
  );
  assert.match(
    all.sql,
    /order by "tuxler_pool_reports"\."received_at" desc/i,
    "newest first is what the card renders",
  );
  assert.match(all.sql, /limit\s+\$\d+/i);
  assert.deepEqual(all.params, ["github", 1]);

  const ubuntu = latestPoolReportQuery("ubuntu").toSQL();
  assert.match(ubuntu.sql, /"runner_os"\s*=\s*\$\d+/i);
  assert.match(ubuntu.sql, /order by .*"received_at" desc/i);
  assert.deepEqual(ubuntu.params, ["github", "ubuntu", 1]);
});

test("the store seam writes what it is given and reads the newest row back", async () => {
  // The fake keeps the same contract the SQL above proves: keyed by the pair,
  // and `latest` answers the greatest `receivedAt` (or that OS's newest).
  const rows = new Map<string, LatestPoolReport>();
  let clock = Date.parse("2026-11-26T10:00:00.000Z");
  const store: PoolReportStore = {
    async upsert(input) {
      clock += 1_000;
      rows.set(`${input.producer}:${input.runnerOs}`, {
        runnerOs: input.runnerOs,
        receivedAt: new Date(clock),
        report: input.report,
      });
    },
    async latest(runnerOs) {
      return (
        [...rows.values()]
          .filter((row) => runnerOs === undefined || row.runnerOs === runnerOs)
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0] ??
        null
      );
    },
  };

  await storePoolReport(
    { producer: "github", runnerOs: "ubuntu", report: REPORT },
    store,
  );
  await storePoolReport(
    { producer: "github", runnerOs: "macos", report: REPORT },
    store,
  );

  const newest = await readLatestPoolReport(undefined, store);
  assert.deepEqual(newest, rows.get("github:macos"));

  const ubuntu = await readLatestPoolReport("ubuntu", store);
  assert.equal(ubuntu?.runnerOs, "ubuntu");

  // A second push replaces the row instead of adding one.
  await storePoolReport(
    { producer: "github", runnerOs: "ubuntu", report: { ...REPORT, minReady: 5 } },
    store,
  );
  assert.equal(rows.size, 2);
  assert.equal((await readLatestPoolReport("ubuntu", store))?.report.minReady, 5);
});

test("no report yet is null, not an empty row", async () => {
  const store: PoolReportStore = {
    async upsert() {},
    async latest() {
      return null;
    },
  };

  assert.equal(await readLatestPoolReport(undefined, store), null);
});
