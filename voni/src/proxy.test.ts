import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  EMAIL_PROVIDERS,
  EMAIL_SOURCE_PARAM,
  EMAIL_TARGETS,
  proxy,
  shuffleBag,
} from "./proxy";

function responseFor(url: string) {
  return proxy(new NextRequest(url));
}

function location(url: string): string | null {
  return responseFor(url).headers.get("location");
}

test("split hosts: landing keeps /, app paths move to the app host", () => {
  process.env.LANDING_HOST = "voni.cc";
  process.env.BETTER_AUTH_URL = "https://app.voni.cc";
  try {
    assert.equal(location("https://voni.cc/"), null);
    assert.equal(location("https://voni.cc/login?x=1"), "https://app.voni.cc/login?x=1");
    assert.equal(location("https://voni.cc/agents/7"), "https://app.voni.cc/agents/7");
    assert.equal(location("https://www.voni.cc/"), "https://voni.cc/");
    assert.equal(location("https://www.voni.cc/signup"), "https://app.voni.cc/signup");
    assert.equal(location("https://app.voni.cc/"), "https://app.voni.cc/dashboard");
    assert.equal(location("https://app.voni.cc/login"), null);
  } finally {
    delete process.env.LANDING_HOST;
    delete process.env.BETTER_AUTH_URL;
  }
});

test("no LANDING_HOST: one host serves everything, as before", () => {
  assert.equal(location("http://localhost:3000/"), null);
  assert.equal(location("http://localhost:3000/login"), null);
});

test("demo link: 307 to env target, no caching, query preserved", () => {
  process.env.LANDING_HOST = "voni.cc";
  process.env.BETTER_AUTH_URL = "https://app.voni.cc";
  process.env.DEMO_REDIRECT_URL = "https://www.google.com";
  try {
    for (const url of ["https://voni.cc/demo", "https://voni.cc/demo/", "https://www.voni.cc/demo", "https://www.voni.cc/demo/"]) {
      const res = responseFor(url);
      assert.equal(res.status, 307);
      assert.equal(res.headers.get("location"), "https://www.google.com/");
      assert.equal(res.headers.get("cache-control"), "no-store, no-cache, must-revalidate, max-age=0");
      assert.equal(res.headers.get("pragma"), "no-cache");
    }

    assert.equal(
      location("https://voni.cc/demo?x=1"),
      "https://www.google.com/?x=1",
    );
    // App host keeps its own routing: no public demo redirect there.
    assert.equal(location("https://app.voni.cc/demo"), null);
  } finally {
    delete process.env.LANDING_HOST;
    delete process.env.BETTER_AUTH_URL;
    delete process.env.DEMO_REDIRECT_URL;
  }
});

test("demo link: falls back to google when env is missing or invalid", () => {
  delete process.env.DEMO_REDIRECT_URL;
  assert.equal(location("http://localhost:3000/demo"), "https://www.google.com/");

  process.env.DEMO_REDIRECT_URL = "not-a-url";
  try {
    assert.equal(location("http://localhost:3000/demo"), "https://www.google.com/");
  } finally {
    delete process.env.DEMO_REDIRECT_URL;
  }
});

/** The /email redirect split into its pool target and its claimed source. */
function emailDraw(url: string): { target: string; source: string | null } {
  const destination = new URL(responseFor(url).headers.get("location") ?? "");
  const source = destination.searchParams.get(EMAIL_SOURCE_PARAM);
  destination.searchParams.delete(EMAIL_SOURCE_PARAM);
  return { target: destination.href, source };
}

test("email link: 307 to a pool target stamped with a pool provider, no caching", () => {
  process.env.LANDING_HOST = "voni.cc";
  process.env.BETTER_AUTH_URL = "https://app.voni.cc";
  const pool = new Set(EMAIL_TARGETS.map((target) => new URL(target).href));
  const providers = new Set(EMAIL_PROVIDERS);
  try {
    for (const path of ["/email", "/email/"]) {
      const res = responseFor(`https://voni.cc${path}`);
      assert.equal(res.status, 307);
      assert.equal(res.headers.get("cache-control"), "no-store, no-cache, must-revalidate, max-age=0");
      assert.equal(res.headers.get("pragma"), "no-cache");
      assert.equal(res.headers.get("expires"), "0");

      const { target, source } = emailDraw(`https://voni.cc${path}`);
      assert.equal(pool.has(target), true, `${target} is in the pool`);
      assert.equal(providers.has(source ?? ""), true, `${source} is a pool provider`);
    }

    // Incoming query is dropped, not merged into the target.
    assert.equal(new URL(responseFor("https://voni.cc/email?x=1").headers.get("location") ?? "").searchParams.has("x"), false);
    // App host keeps its own routing: no public email redirect there.
    assert.equal(location("https://app.voni.cc/email"), null);
    // www still serves the public link.
    assert.equal(responseFor("https://www.voni.cc/email").status, 307);
  } finally {
    delete process.env.LANDING_HOST;
    delete process.env.BETTER_AUTH_URL;
  }
});

test("shuffle bag: every pass covers the pool once, then reshuffles", () => {
  const bag = shuffleBag(["a", "b", "c"], () => 0);
  const passes = [
    [bag(), bag(), bag()],
    [bag(), bag(), bag()],
  ];
  for (const pass of passes) {
    // `random: () => 0` pins the order, so this is a real permutation check.
    assert.deepEqual([...pass].sort(), ["a", "b", "c"], "each pass is a permutation");
  }
});
