/**
 * The guards the click history leans on, proved without a database: a bad
 * target is rejected before it is stored, and a page size cannot become an
 * unbounded query.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { count } from "drizzle-orm";
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
    ["All", "Grafana", "GitHub", "Oneoff"],
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

