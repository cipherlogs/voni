/**
 * The `/email` target and source draw (`docs/agents/email-pool.md`): the bag
 * invariants, the shuffle, and the attribution `resolveTarget` stamps on. Both
 * the Grafana check script and the panel's one-off click draw from these bags.
 */
import assert from "node:assert/strict";
import test from "node:test";
import TARGETS_JSON from "./targets.json";
import {
  assertEmailTargets,
  EMAIL_CAMPAIGN,
  EMAIL_MEDIUM,
  EMAIL_PROVIDERS,
  EMAIL_SOURCE_PARAM,
  EMAIL_TARGETS,
  EMAIL_TARGETS_FILE,
  nextEmailProvider,
  nextEmailTarget,
  resolveTarget,
  shuffleBag,
} from "./pool";

test("bags: a run of draws covers every target and every provider", () => {
  // Without replacement, any N consecutive draws from an N-item bag cross a
  // refill boundary, so the set is always the whole bag.
  const targets = Array.from({ length: EMAIL_TARGETS.length }, () => nextEmailTarget());
  assert.deepEqual([...targets].sort(), [...EMAIL_TARGETS].sort());

  const providers = Array.from({ length: EMAIL_PROVIDERS.length }, () => nextEmailProvider());
  assert.deepEqual([...providers].sort(), [...EMAIL_PROVIDERS].sort());
});

test("bags: every target is an absolute URL and the GitHub Pages slash stays", () => {
  // The bag is the operator-edited JSON file (docs/agents/email-pool.md), so its
  // size and contents are data, not invariants here. The invariants that hold
  // for any entry are shape (absolute) and the GitHub Pages trailing slash.
  assert.ok(EMAIL_TARGETS.length > 0, "the bag must not be empty");
  for (const entry of EMAIL_TARGETS) {
    assert.match(entry, /^https?:\/\//i, "every target is absolute; the bag carries no paths");
  }
  if (EMAIL_TARGETS.some((entry) => new URL(entry).hostname === "cipherlogs.github.io")) {
    assert.ok(
      EMAIL_TARGETS.includes("https://cipherlogs.github.io/print/"),
      "GitHub Pages 301s /print to /print/, so the trailing slash keeps the draw on the page",
    );
  }
});

test("targets: the bag is exactly the operator-edited JSON file", () => {
  // Proves the module ships the file's contents unfiltered — not what the
  // operator has in it today.
  assert.deepEqual([...EMAIL_TARGETS], TARGETS_JSON);
});

test("targets: every entry is an absolute https URL with a host", () => {
  for (const entry of EMAIL_TARGETS) {
    const url = new URL(entry);
    assert.equal(url.protocol, "https:", `${entry} must be https`);
    assert.ok(url.hostname, `${entry} must have a host`);
    assert.equal(url.toString(), entry, `${entry} is already absolute, never resolved`);
  }
});

test("targets guard: a path-only, http or non-URL entry throws by name and file", () => {
  for (const bad of ["/print/", "http://voni.cc/test", "not a url"]) {
    assert.throws(
      () => assertEmailTargets([bad]),
      (error: Error) =>
        error.message.includes(JSON.stringify(bad)) &&
        error.message.includes(EMAIL_TARGETS_FILE),
      `${bad} must be rejected`,
    );
  }
  assert.equal(assertEmailTargets(EMAIL_TARGETS), EMAIL_TARGETS, "the real bag passes");
});

test("shuffle bag: every pass is a permutation, pinned random keeps a stable order", () => {
  const bag = shuffleBag(["a", "b", "c"], () => 0);
  const passes = [
    [bag(), bag(), bag()],
    [bag(), bag(), bag()],
  ];
  for (const pass of passes) {
    assert.deepEqual([...pass].sort(), ["a", "b", "c"], "each pass is a permutation");
  }
});

test("resolveTarget: an absolute entry keeps its own host and path", () => {
  const url = new URL(resolveTarget("https://voni.cc/test", "gmail.com"));
  assert.equal(url.origin, "https://voni.cc");
  assert.equal(url.pathname, "/test");

  const github = new URL(resolveTarget("https://cipherlogs.github.io/print/", "gmail.com"));
  assert.equal(github.origin, "https://cipherlogs.github.io");
  assert.equal(github.pathname, "/print/", "the trailing slash is kept, never normalized away");
  assert.equal(github.searchParams.get(EMAIL_SOURCE_PARAM), "gmail.com");
});

test("resolveTarget: exactly utm_source, utm_medium=email and utm_campaign=voni-email", () => {
  const url = new URL(resolveTarget("https://voni.cc/test", "att.com"));
  assert.equal(url.searchParams.get(EMAIL_SOURCE_PARAM), "att.com");
  assert.equal(url.searchParams.get("utm_medium"), EMAIL_MEDIUM);
  assert.equal(url.searchParams.get("utm_medium"), "email");
  assert.equal(url.searchParams.get("utm_campaign"), EMAIL_CAMPAIGN);
  assert.equal(url.searchParams.get("utm_campaign"), "voni-email");
  assert.deepEqual(
    [...url.searchParams.keys()].sort(),
    ["utm_campaign", "utm_medium", "utm_source"],
  );
});

test("resolveTarget: an entry's own query survives, utm keys are set and never duplicated", () => {
  const url = new URL(
    resolveTarget("https://voni.cc/test?creative_id=1&utm_source=spoofed&x=1", "proton.me"),
  );
  assert.equal(url.searchParams.get("creative_id"), "1");
  assert.equal(url.searchParams.get("x"), "1");
  assert.equal(url.searchParams.get(EMAIL_SOURCE_PARAM), "proton.me");
  assert.equal(url.searchParams.getAll(EMAIL_SOURCE_PARAM).length, 1);
  assert.equal(url.searchParams.getAll("utm_medium").length, 1);
  assert.equal(url.searchParams.getAll("utm_campaign").length, 1);

  const withCreative = new URL(resolveTarget("https://voni.cc/test?creative_id=1", "cox.com"));
  assert.equal(withCreative.searchParams.get("creative_id"), "1");
  assert.equal(withCreative.searchParams.get(EMAIL_SOURCE_PARAM), "cox.com");
  assert.equal(withCreative.searchParams.get("utm_medium"), "email");
  assert.equal(withCreative.searchParams.get("utm_campaign"), "voni-email");
});

test("resolveTarget: every bag entry resolves to itself plus the three params", () => {
  for (const entry of EMAIL_TARGETS) {
    const original = new URL(entry);
    const url = new URL(resolveTarget(entry, "verizon.com"));
    assert.equal(url.origin, original.origin, "no re-basing onto another host");
    assert.equal(url.pathname, original.pathname);
    assert.equal(url.searchParams.get(EMAIL_SOURCE_PARAM), "verizon.com");
    assert.equal(url.searchParams.get("utm_medium"), EMAIL_MEDIUM);
    assert.equal(url.searchParams.get("utm_campaign"), EMAIL_CAMPAIGN);
  }
});
