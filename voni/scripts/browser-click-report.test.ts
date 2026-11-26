/**
 * The click report's retry policy, proved with an injected fetch.
 *
 * A lost report used to stay silent for five hours and then fail the whole
 * segment: one transient timeout threw away every click of the window. These
 * cases pin the boundary — a transient fault is retried, a rejected body is
 * not, and a row that never lands is still only a recorded miss, never a
 * reason to stop clicking. Nothing here reaches the network.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { postReport } from "./browser-click.mjs";

const REPORT = {
  target: "https://example.com/abc",
  status: 200,
  ms: 120,
};

interface Attempt {
  url: string;
  body: string;
}

function fakeResponse(status: number, text = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

function harness(replies: Array<ReturnType<typeof fakeResponse> | Error>) {
  const calls: Attempt[] = [];
  const waits: number[] = [];
  return {
    calls,
    waits,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      const reply = replies[calls.length - 1];
      if (reply === undefined) throw new Error("no fake reply for this attempt");
      if (reply instanceof Error) throw reply;
      return reply as unknown as Response;
    },
    sleepImpl: async (ms: number) => {
      waits.push(ms);
    },
  };
}

test("a report stored on the first attempt is not retried", async () => {
  const fake = harness([fakeResponse(200)]);

  const result = await postReport(REPORT, "secret", fake);

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.waits, []);
  assert.equal(fake.calls[0]!.url, "https://voni.cc/api/email/clicks/report");
});

test("a 5xx is retried after a wait, and a later success stores the row", async () => {
  const fake = harness([fakeResponse(500, "upstream"), fakeResponse(200)]);

  const result = await postReport(REPORT, "secret", fake);

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.waits, [1_000], "the first retry waits one second");
});

test("a 429 is transient too, and the third attempt can still store it", async () => {
  const fake = harness([fakeResponse(429), fakeResponse(408), fakeResponse(200)]);

  const result = await postReport(REPORT, "secret", fake);

  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.waits, [1_000, 3_000]);
});

test("a 400 is the intake rejecting the body: retrying cannot fix it", async () => {
  const fake = harness([fakeResponse(400, "bad target")]);

  const result = await postReport(REPORT, "secret", fake);

  assert.equal(result.ok, false);
  assert.equal(fake.calls.length, 1, "a rejected body is never sent twice");
  assert.deepEqual(fake.waits, []);
  assert.match(result.detail ?? "", /HTTP 400/);
  assert.match(result.detail ?? "", /1 attempt, not retried/);
});

test("all attempts failing records the count and the last error, and does not throw", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  const fake = harness([timeout, fakeResponse(503), timeout]);

  const result = await postReport(REPORT, "secret", fake);

  assert.equal(result.ok, false, "a lost row is a result, not an exception");
  assert.equal(result.attempts, 3);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.waits, [1_000, 3_000]);
  assert.match(result.detail ?? "", /The operation was aborted due to timeout/);
  assert.match(result.detail ?? "", /3 attempts/);
});
