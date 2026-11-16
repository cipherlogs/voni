import { test } from "node:test";
import assert from "node:assert/strict";

import { isAuthorized, timingSafeEqual } from "../src/auth.ts";

const SECRET = "pool-secret-abc123";

function clickRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://email-pool-01.example.workers.dev/click", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ url: "https://voni.cc/test", visitId: "abc" }),
  });
}

test("missing secret header is unauthorized", () => {
  assert.equal(isAuthorized(clickRequest(), { POOL_SECRET: SECRET }), false);
});

test("empty secret header is unauthorized", () => {
  assert.equal(
    isAuthorized(clickRequest({ "x-pool-secret": "" }), { POOL_SECRET: SECRET }),
    false,
  );
});

test("wrong secret is unauthorized", () => {
  assert.equal(
    isAuthorized(clickRequest({ "x-pool-secret": "pool-secret-abc124" }), {
      POOL_SECRET: SECRET,
    }),
    false,
  );
  assert.equal(
    isAuthorized(clickRequest({ "x-pool-secret": "short" }), { POOL_SECRET: SECRET }),
    false,
  );
});

test("correct secret is authorized", () => {
  assert.equal(
    isAuthorized(clickRequest({ "x-pool-secret": SECRET }), { POOL_SECRET: SECRET }),
    true,
  );
});

test("unconfigured POOL_SECRET closes the endpoint", () => {
  assert.equal(isAuthorized(clickRequest({ "x-pool-secret": "" }), {}), false);
  assert.equal(isAuthorized(clickRequest({ "x-pool-secret": "anything" }), {}), false);
});

test("timingSafeEqual compares equal and differing content", () => {
  assert.equal(timingSafeEqual(SECRET, SECRET), true);
  assert.equal(timingSafeEqual(SECRET, `${SECRET}x`), false);
  assert.equal(timingSafeEqual(SECRET, "pool-secret-abc124"), false);
  assert.equal(timingSafeEqual("", ""), true);
});
