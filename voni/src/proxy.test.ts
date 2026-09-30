import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

function location(url: string): string | null {
  const response = proxy(new NextRequest(url));
  return response.headers.get("location");
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
