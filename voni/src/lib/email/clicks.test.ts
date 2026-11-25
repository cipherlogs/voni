/**
 * The guards the click history leans on, proved without a database: a bad
 * target is rejected before it is stored, and a page size cannot become an
 * unbounded query.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { count, getTableColumns } from "drizzle-orm";
import { db } from "@/lib/db";
import { affiliateClicks } from "@/lib/db/schema";
import {
  AFFILIATE_CLICK_DEFAULT_LIMIT,
  AFFILIATE_CLICK_MAX_LIMIT,
  affiliateClicksPage,
  assertClickTarget,
  clampClickLimit,
  clickSourceChips,
  clickStatsWhere,
  parseClickSource,
  recordAffiliateClick,
  runnerClicksSincePage,
  summariseRunnerClicks,
  type RunnerClickSample,
} from "./clicks";

test("target guard: absolute http(s) URLs pass unchanged", () => {
  for (const target of [
    "https://voni.cc/test",
    "https://www.glizzitrium.com/BCMPW39K/CZ562T2/?creative_id=1",
    "http://localhost:3000/email",
  ]) {
    assert.equal(assertClickTarget(target), target, "the stored value is the value visited");
  }
});

test("target guard: path-only, non-http schemes and garbage throw by value", () => {
  for (const bad of [
    "/print/",
    "//voni.cc/test",
    "javascript:alert(1)",
    "mailto:ops@voni.cc",
    "ftp://voni.cc/test",
    "not a url",
    "",
  ]) {
    assert.throws(
      () => assertClickTarget(bad),
      (error: Error) =>
        error.message.includes(JSON.stringify(bad)) &&
        error.message.includes("absolute http(s) URL"),
      `${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("attribution: a row written without a pool reads as no proxy", () => {
  const columns = getTableColumns(affiliateClicks);
  assert.equal(columns.exitIp.notNull, false, "an exit address is an observation, not a requirement");
  assert.equal(columns.exitCountry.notNull, false);
  assert.equal(columns.exitAsn.notNull, false);
  assert.equal(
    columns.proxyKind.default,
    "none",
    "the default is the backfill: every pre-pool row is a direct click",
  );
  assert.equal(columns.proxyKind.notNull, true);
  assert.equal(columns.failureReason.notNull, false);
});

test("target guard: a rejected target never reaches the insert", async () => {
  await assert.rejects(
    recordAffiliateClick({
      target: "/print/",
      source: "gmail.com",
      finalUrl: null,
      status: null,
      ms: null,
      userAgent: null,
      device: null,
      browser: null,
      producer: "grafana",
      runnerOs: null,
      passId: null,
      exitIp: null,
      exitCountry: null,
      exitAsn: null,
      proxyKind: "none",
      failureReason: null,
      ranAt: new Date(),
    }),
    /absolute http\(s\) URL/,
  );
});

test("limit: defaults to 50, accepts in-range values", () => {
  assert.equal(AFFILIATE_CLICK_DEFAULT_LIMIT, 50);
  assert.equal(clampClickLimit(undefined), 50);
  assert.equal(clampClickLimit(10), 10);
  assert.equal(clampClickLimit(199), 199);
  assert.equal(clampClickLimit(200), 200);
});

test("limit: clamps to the 200 cap and never below one row", () => {
  assert.equal(AFFILIATE_CLICK_MAX_LIMIT, 200);
  assert.equal(clampClickLimit(201), 200);
  assert.equal(clampClickLimit(10_000), 200);
  assert.equal(clampClickLimit(0), 1);
  assert.equal(clampClickLimit(-5), 1);
  assert.equal(clampClickLimit(3.9), 3, "a fractional page size truncates");
});

test("limit: non-finite input falls back to the default page, not a giant query", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(clampClickLimit(bad), AFFILIATE_CLICK_DEFAULT_LIMIT);
  }
});

test("history rows carry the producer and runner OS", () => {
  const { sql } = affiliateClicksPage(10).toSQL();

  assert.match(sql, /select .*"producer"/);
  assert.match(sql, /select .*"runner_os"/);
});

test("history is newest first and a producer filter narrows it, still newest first", () => {
  const { sql } = affiliateClicksPage(10, "github").toSQL();

  assert.match(
    sql,
    /where\s+"affiliate_clicks"\."producer"\s*=\s*\$\d+/i,
    "the filter is a producer predicate, so the (producer, ran_at desc) index can serve it",
  );
  assert.match(
    sql,
    /order by\s+"affiliate_clicks"\."ran_at"\s+desc/i,
    "the newest click in the narrowed set comes first",
  );
  assert.match(sql, /\blimit\s+\$\d+/i);
});

test("an unfiltered history has no producer predicate", () => {
  const { sql } = affiliateClicksPage(10).toSQL();

  assert.doesNotMatch(sql, /where\s+.*"producer"\s*=/i);
});

test("source chips: All first, then one per stored producer, each a link", () => {
  const chips = clickSourceChips(null);

  assert.deepEqual(
    chips.map((chip) => chip.value),
    ["all", "grafana", "github", "oneoff"],
  );
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ["All", "Grafana", "GitHub", "One-off"],
  );
  assert.deepEqual(
    chips.map((chip) => chip.href),
    ["/email", "/email?source=grafana", "/email?source=github", "/email?source=oneoff"],
  );
  assert.deepEqual(
    chips.map((chip) => chip.active),
    [true, false, false, false],
    "the absent filter is All, and exactly one chip is the open view",
  );
});

test("source chips mark the resolved producer, not every chip", () => {
  for (const producer of ["grafana", "github", "oneoff"] as const) {
    const active = clickSourceChips(producer).filter((chip) => chip.active);
    assert.equal(active.length, 1);
    assert.equal(active[0]!.value, producer);
    assert.equal(active[0]!.href, `/email?source=${producer}`);
  }
});

test("click-source parsing: absent, empty or unknown is All", () => {
  for (const raw of [undefined, "", "all", "unknown", "graf ana", "all "]) {
    assert.equal(parseClickSource(raw), null, `${JSON.stringify(raw)} is All`);
  }
  assert.equal(parseClickSource([]), null);
});

test("click-source parsing: known producers, normalised and first repeat", () => {
  assert.equal(parseClickSource("grafana"), "grafana");
  assert.equal(parseClickSource("github"), "github");
  assert.equal(parseClickSource("oneoff"), "oneoff");
  assert.equal(parseClickSource(" GitHub "), "github", "case does not make it unknown");
  assert.equal(
    parseClickSource(["github", "oneoff"]),
    "github",
    "a repeated parameter keeps the first value, like Next's own convention",
  );
  assert.equal(parseClickSource(["nonsense", "oneoff"]), null, "the first value decides");
});

test("stats predicate: the trailing window, and a producer filter only when asked", () => {
  const since = new Date("2026-11-01T00:00:00.000Z");

  const all = db
    .select({ total: count() })
    .from(affiliateClicks)
    .where(clickStatsWhere(since))
    .toSQL();
  assert.match(all.sql, /"affiliate_clicks"\."ran_at"\s*>=\s*\$\d+/i);
  assert.doesNotMatch(all.sql, /"producer"\s*=/i, "All must not narrow the window");

  const grafana = db
    .select({ total: count() })
    .from(affiliateClicks)
    .where(clickStatsWhere(since, "grafana"))
    .toSQL();
  assert.match(grafana.sql, /"affiliate_clicks"\."ran_at"\s*>=\s*\$\d+/i);
  assert.match(
    grafana.sql,
    /"affiliate_clicks"\."producer"\s*=\s*\$\d+/i,
    "a narrowed card/table stats read is served by the (producer, ran_at) index",
  );
  assert.deepEqual(grafana.params.slice(1), ["grafana"]);
});

/**
 * The GitHub card's two cuts. The card shows one row per OS (`targets x/x` is
 * the shared targets that OS landed on) and one row per base target split by
 * OS, so "macOS never lands on target 3" is a visible gap rather than an
 * average. Both are this pure fold; the database read only supplies rows.
 */
const sampledAt = new Date("2026-11-23T08:00:00.000Z");

test("runner summary: counts by OS, folds stamps, and only shared targets count", () => {
  const rows: RunnerClickSample[] = [
    {
      runnerOs: "ubuntu",
      target: "https://a.example/one?utm_source=gmail.com&utm_medium=email",
      status: 200,
      passId: "pass-ubuntu-1",
      ranAt: sampledAt,
    },
    {
      runnerOs: "ubuntu",
      target: "https://a.example/one",
      status: null,
      passId: "pass-ubuntu-1",
      ranAt: sampledAt,
    },
    {
      runnerOs: "ubuntu",
      target: "https://b.example/two",
      status: 302,
      passId: "pass-ubuntu-1",
      ranAt: sampledAt,
    },
    // Still a click, but no longer a shared target, so it cannot inflate 2/2.
    {
      runnerOs: "ubuntu",
      target: "https://c.example/three",
      status: 200,
      passId: "pass-ubuntu-1",
      ranAt: sampledAt,
    },
    {
      runnerOs: "macos",
      target: "https://a.example/one",
      status: 200,
      passId: "pass-macos-1",
      ranAt: sampledAt,
    },
    // Grafana / one-off rows carry no OS and must not become a fourth bucket.
    {
      runnerOs: null,
      target: "https://a.example/one",
      status: 200,
      passId: null,
      ranAt: sampledAt,
    },
  ];

  const summary = summariseRunnerClicks(rows, [
    "https://a.example/one",
    "https://b.example/two",
  ]);

  assert.equal(summary.total, 5, "the non-runner row is not counted");

  assert.deepEqual(summary.byOs, [
    {
      os: "ubuntu",
      clicks: 4,
      failed: 1,
      targets: ["https://a.example/one", "https://b.example/two"],
      pass: {
        id: "pass-ubuntu-1",
        ranAt: sampledAt,
        hits: 2,
        total: 2,
        conclusion: "complete",
      },
    },
    { os: "windows", clicks: 0, failed: 0, targets: [], pass: null },
    {
      os: "macos",
      clicks: 1,
      failed: 0,
      targets: ["https://a.example/one"],
      pass: {
        id: "pass-macos-1",
        ranAt: sampledAt,
        hits: 1,
        total: 2,
        conclusion: "partial",
      },
    },
  ]);

  // Every clicked base URL, including one no longer shared, split by OS.
  assert.deepEqual(summary.byTarget, [
    {
      target: "https://a.example/one",
      clicks: 3,
      byOs: { ubuntu: 2, windows: 0, macos: 1 },
    },
    {
      target: "https://b.example/two",
      clicks: 1,
      byOs: { ubuntu: 1, windows: 0, macos: 0 },
    },
    {
      target: "https://c.example/three",
      clicks: 1,
      byOs: { ubuntu: 1, windows: 0, macos: 0 },
    },
  ]);
});

test("runner summary: an OS that never reported is empty, not a zeroed success", () => {
  const summary = summariseRunnerClicks(
    [
      {
        runnerOs: "ubuntu",
        target: "https://a.example/one",
        status: 200,
        passId: "pass-ubuntu-1",
        ranAt: sampledAt,
      },
    ],
    ["https://a.example/one"],
  );

  const windows = summary.byOs.find((row) => row.os === "windows");
  assert.deepEqual(windows, {
    os: "windows",
    clicks: 0,
    failed: 0,
    targets: [],
    pass: null,
  });
  assert.equal(summary.total, 1);
});

test("history rows carry the pass id the runner wrote", () => {
  const { sql } = affiliateClicksPage(10).toSQL();
  assert.match(sql, /select .*"pass_id"/, "the column is read back, not just stored");
});

test("runner summary: coverage is the most recent pass, measured alone", () => {
  const t1 = new Date("2026-11-23T08:00:00.000Z");
  const t2 = new Date("2026-11-23T08:01:00.000Z");
  const rows: RunnerClickSample[] = [
    // Pass A covered all three targets, one of them with no response.
    { runnerOs: "ubuntu", target: "https://a.example/one", status: 200, passId: "pass-a", ranAt: t1 },
    { runnerOs: "ubuntu", target: "https://b.example/two", status: null, passId: "pass-a", ranAt: t1 },
    { runnerOs: "ubuntu", target: "https://c.example/three", status: 200, passId: "pass-a", ranAt: t1 },
    // Pass B, newer, only landed on one of them. A rolling window would carry
    // A's hits forward; a pass basis must not.
    { runnerOs: "ubuntu", target: "https://a.example/one", status: 200, passId: "pass-b", ranAt: t2 },
  ];

  const summary = summariseRunnerClicks(rows, [
    "https://a.example/one",
    "https://b.example/two",
    "https://c.example/three",
  ]);
  const ubuntu = summary.byOs.find((row) => row.os === "ubuntu");

  assert.deepEqual(ubuntu?.pass, {
    id: "pass-b",
    ranAt: t2,
    hits: 1,
    total: 3,
    conclusion: "partial",
  });
  assert.deepEqual(
    ubuntu?.targets,
    ["https://a.example/one", "https://b.example/two", "https://c.example/three"],
    "the rolling target list is unchanged; only the pass number is new",
  );
});

test("runner summary: a no-response row is a miss, and conclusions are fixed", () => {
  const at = new Date("2026-11-23T08:00:00.000Z");
  const shared = ["https://a.example/one", "https://b.example/two"];

  const complete = summariseRunnerClicks(
    [
      { runnerOs: "ubuntu", target: shared[0]!, status: 200, passId: "pass-1", ranAt: at },
      { runnerOs: "ubuntu", target: shared[1]!, status: 302, passId: "pass-1", ranAt: at },
    ],
    shared,
  ).byOs.find((row) => row.os === "ubuntu");
  assert.equal(complete?.pass?.conclusion, "complete");
  assert.equal(complete?.pass?.hits, 2);

  const partial = summariseRunnerClicks(
    [
      { runnerOs: "ubuntu", target: shared[0]!, status: 200, passId: "pass-1", ranAt: at },
      { runnerOs: "ubuntu", target: shared[1]!, status: null, passId: "pass-1", ranAt: at },
    ],
    shared,
  ).byOs.find((row) => row.os === "ubuntu");
  assert.equal(partial?.pass?.conclusion, "partial");
  assert.equal(partial?.pass?.hits, 1, "status null is a click, never a hit");

  const failed = summariseRunnerClicks(
    [
      { runnerOs: "ubuntu", target: shared[0]!, status: null, passId: "pass-1", ranAt: at },
      { runnerOs: "ubuntu", target: shared[1]!, status: null, passId: "pass-1", ranAt: at },
    ],
    shared,
  ).byOs.find((row) => row.os === "ubuntu");
  assert.equal(failed?.pass?.conclusion, "failed");
  assert.equal(failed?.pass?.hits, 0);

  const neverRanPass = summariseRunnerClicks(
    [
      // A click with no pass id was written before the runner reported one.
      { runnerOs: "ubuntu", target: shared[0]!, status: 200, passId: null, ranAt: at },
    ],
    shared,
  ).byOs.find((row) => row.os === "ubuntu");
  assert.equal(neverRanPass?.pass, null, "no pass means 'Never run' in the card");
});

test("runner rows read: one producer, since a cutoff, OS known, newest first", () => {
  const since = new Date("2026-11-01T00:00:00.000Z");
  const { sql, params } = runnerClicksSincePage("github", since).toSQL();

  assert.match(
    sql,
    /"affiliate_clicks"\."producer"\s*=\s*\$\d+/i,
    "one producer's rows, served by the (producer, ran_at) index",
  );
  assert.match(sql, /"affiliate_clicks"\."ran_at"\s*>=\s*\$\d+/i);
  assert.match(sql, /"affiliate_clicks"\."runner_os"\s+is not null/i);
  assert.match(
    sql,
    /select .*"pass_id"/,
    "the pass id is selected so the card can measure the most recent pass",
  );
  assert.match(sql, /order by\s+"affiliate_clicks"\."ran_at"\s+desc/i);
  assert.equal(params[0], "github", "the producer is the first bound value");
  assert.ok(
    params.some((value) => String(value).startsWith("2026-11-01")),
    "the cutoff is bound too",
  );
});

