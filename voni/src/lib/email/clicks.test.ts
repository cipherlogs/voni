/**
 * The guards the click history leans on, proved without a database: a bad
 * target is rejected before it is stored, and a page size cannot become an
 * unbounded query.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AFFILIATE_CLICK_DEFAULT_LIMIT,
  AFFILIATE_CLICK_MAX_LIMIT,
  affiliateClicksPage,
  assertClickTarget,
  clampClickLimit,
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
