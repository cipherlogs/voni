import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

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

/**
 * `/email` is a page now, not a redirect: the pool that used to feed a 307
 * lives in `src/lib/email/pool.ts`. The proxy must let it through untouched.
 */
test("email page: the proxy no longer redirects /email", () => {
  process.env.LANDING_HOST = "voni.cc";
  process.env.BETTER_AUTH_URL = "https://app.voni.cc";
  try {
    for (const path of ["/email", "/email/"]) {
      const res = responseFor(`https://voni.cc${path}`);
      assert.equal(res.headers.get("location"), null, `${path} is not a redirect`);
      assert.equal(res.status, 200);
    }
    // Host gating is untouched: the app host keeps its own routing.
    assert.equal(location("https://app.voni.cc/email"), null);
    // And the proxy is not even invoked for the page.
    assert.equal(config.matcher.includes("/email"), false);
    assert.equal(config.matcher.includes("/email/"), false);
  } finally {
    delete process.env.LANDING_HOST;
    delete process.env.BETTER_AUTH_URL;
  }
});
