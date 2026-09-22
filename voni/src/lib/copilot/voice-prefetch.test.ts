import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupePrefetch,
  getSessionPrefetchRoutes,
  prefetchCandidates,
} from "./voice-prefetch";
import { NAVIGABLE_ROUTES } from "./app-manifest";

test("session prefetch covers static routes, operator gated", () => {
  const all = getSessionPrefetchRoutes(true);
  assert.deepEqual([...all].sort(), [...NAVIGABLE_ROUTES].sort());
  const signedIn = getSessionPrefetchRoutes(false);
  assert.ok(!signedIn.includes("/operator"));
  assert.ok(signedIn.includes("/settings"));
});

test("dedupe keeps prefetch silent on repeats", () => {
  const seen = new Set(["/settings"]);
  assert.deepEqual(dedupePrefetch(["/settings", "/jobs"], seen), ["/jobs"]);
});

test("prefetchCandidates never throws and marks seen", async () => {
  const seen = new Set<string>();
  const warmed: string[] = [];
  await prefetchCandidates((r) => void warmed.push(r), ["/settings", "/jobs"], seen);
  assert.deepEqual(warmed, ["/settings", "/jobs"]);
  assert.ok(seen.has("/settings") && seen.has("/jobs"));
  warmed.length = 0;
  await prefetchCandidates((r) => void warmed.push(r), ["/settings"], seen);
  assert.deepEqual(warmed, []);
});

test("prefetch failure falls back to normal nav", async () => {
  const seen = new Set<string>();
  await prefetchCandidates(
    () => {
      throw new Error("offline");
    },
    ["/settings"],
    seen,
  );
  assert.ok(seen.has("/settings"));
});
