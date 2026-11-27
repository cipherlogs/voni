/**
 * The live poll as a handler: a locked request gets no data, an unlocked one
 * gets the snapshot, and a failed read is a fixed 502 rather than a snapshot
 * with invented zeros. The database is stubbed at the read seam; the gate,
 * the response headers and the JSON are the real code paths.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  buildLiveSnapshot,
  setLiveSnapshotDeps,
  type LiveSnapshotDeps,
} from "@/lib/email/live";
import { PAGE_COOKIE, pagePasswordDigest } from "@/lib/email/page-gate";
import { GET } from "./route";

const PASSWORD = "test-email-page-password";
const ENDPOINT = "https://voni.cc/api/email/live";
const NOW = new Date("2026-11-27T12:00:00.000Z");

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
  "utf8",
);

process.env.EMAIL_PAGE_PASSWORD = PASSWORD;
test.after(() => {
  delete process.env.EMAIL_PAGE_PASSWORD;
});
test.afterEach(() => setLiveSnapshotDeps());

function get(cookie?: string): NextRequest {
  const headers = new Headers({ accept: "application/json" });
  if (cookie !== undefined) {
    headers.set("cookie", `${PAGE_COOKIE}=${cookie}`);
  }
  return new NextRequest(ENDPOINT, { headers });
}

/** Complete deps that record every read, so "never reached" is observable. */
function deps(
  reads: string[],
  overrides: Partial<LiveSnapshotDeps> = {},
): LiveSnapshotDeps {
  const note = (name: string, result: unknown) => async () => {
    reads.push(name);
    return result;
  };
  const base: LiveSnapshotDeps = {
    now: () => NOW,
    readClicks: async (since) => {
      reads.push(`clicks:${since.toISOString()}`);
      return [
        { ranAt: new Date(NOW.getTime() - 60_000), status: 200, runnerOs: "ubuntu" },
        { ranAt: new Date(NOW.getTime() - 120_000), status: null, runnerOs: "windows" },
      ];
    },
    readFailures: async (since) => {
      reads.push(`failures:${since.toISOString()}`);
      return [{ reason: "no-us-exit", count: 1 }];
    },
    readNewestByOs: note("newest", { ubuntu: NOW }) as LiveSnapshotDeps["readNewestByOs"],
    readPoolReports: note("pools", [
      {
        os: "ubuntu",
        receivedAt: new Date("2026-11-27T11:59:00.000Z"),
        report: {
          enabled: true,
          minReady: 5,
          gate: {
            ok: true,
            reason: null,
            detail: null,
            attempts: 1,
            waitedMs: 1_000,
            checkedAt: "2026-11-27T11:59:00.000Z",
            ready: 4,
            exits: [],
            refills: 0,
            reconnects: 0,
            lastError: null,
            clientLog: null,
          },
          final: null,
        },
      },
    ]) as LiveSnapshotDeps["readPoolReports"],
    readSource: note("source", {
      enabled: true,
      lastDispatchedAt: new Date("2026-11-27T11:00:00.000Z"),
    }) as LiveSnapshotDeps["readSource"],
  };
  return { ...base, ...overrides };
}

test("a missing gate cookie is 401 and no read is attempted", async () => {
  const reads: string[] = [];
  setLiveSnapshotDeps(deps(reads));

  const response = await GET(get());

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    reason: "unauthorized",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(reads, [], "a locked request must not touch the pipeline");
});

test("a wrong gate cookie is the same 401, still with no read", async () => {
  const reads: string[] = [];
  setLiveSnapshotDeps(deps(reads));

  const response = await GET(get(pagePasswordDigest("not-the-password")));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    reason: "unauthorized",
  });
  assert.deepEqual(reads, []);
});

test("an unset page password locks the route even for the matching digest", async () => {
  const saved = process.env.EMAIL_PAGE_PASSWORD;
  const cookie = pagePasswordDigest(PASSWORD);
  delete process.env.EMAIL_PAGE_PASSWORD;
  const reads: string[] = [];
  setLiveSnapshotDeps(deps(reads));

  try {
    const response = await GET(get(cookie));
    assert.equal(response.status, 401);
    assert.deepEqual(reads, []);
  } finally {
    process.env.EMAIL_PAGE_PASSWORD = saved;
  }
});

test("the unlocked response is the snapshot, with the contract's shape", async () => {
  const reads: string[] = [];
  setLiveSnapshotDeps(deps(reads));

  const response = await GET(get(pagePasswordDigest(PASSWORD)));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "byOs",
    "enabled",
    "exits",
    "failures",
    "lastDispatchAt",
    "now",
    "windows",
  ]);
  assert.equal(body.now, NOW.toISOString());
  assert.equal(body.enabled, true);
  assert.equal(body.lastDispatchAt, "2026-11-27T11:00:00.000Z");
  assert.deepEqual(
    (body.windows as { minutes: number }[]).map((window) => window.minutes),
    [5, 60, 1440],
  );
  assert.deepEqual(
    (body.byOs as { os: string }[]).map((row) => row.os),
    ["ubuntu", "windows", "macos"],
  );
  assert.deepEqual(body.failures, [{ reason: "no-us-exit", count: 1 }]);
  assert.deepEqual(body.exits, [
    {
      os: "ubuntu",
      receivedAt: "2026-11-27T11:59:00.000Z",
      ok: true,
      ready: 4,
      liveExitLimit: 5,
    },
  ]);
});

test("the body is the fold of the reads, with the panel's ok/failed split", async () => {
  const reads: string[] = [];
  const stub = deps(reads);
  setLiveSnapshotDeps(stub);

  const response = await GET(get(pagePasswordDigest(PASSWORD)));
  const body = await response.json();

  const [clicks, failures, newestByOs, poolReports, source] = await Promise.all([
    stub.readClicks(new Date(NOW.getTime() - 24 * 60 * 60_000)),
    stub.readFailures(new Date(NOW.getTime() - 24 * 60 * 60_000)),
    stub.readNewestByOs(),
    stub.readPoolReports(),
    stub.readSource(),
  ]);
  const expected = buildLiveSnapshot({
    now: NOW,
    clicks,
    failures,
    newestByOs,
    poolReports,
    source,
  });

  assert.deepEqual(body, JSON.parse(JSON.stringify(expected)));
  const five = (body.windows as { minutes: number; ok: number; failed: number }[]).find(
    (window) => window.minutes === 5,
  );
  assert.deepEqual(five, { minutes: 5, total: 2, ok: 1, failed: 1 });
});

test("a failed read is a fixed 502 and the payload never reaches the log", async () => {
  setLiveSnapshotDeps(
    deps([], {
      readSource: async () => {
        throw new Error("row 198.51.100.24 refused");
      },
    }),
  );

  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  let response: Response;
  try {
    response = await GET(get(pagePasswordDigest(PASSWORD)));
  } finally {
    console.error = original;
  }

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, reason: "not_read" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(logged, [["email live snapshot read failed"]]);
  assert.ok(
    !logged.flat().some((entry) => String(entry).includes("198.51.100.24")),
    "a value from the failed read stays out of the logs",
  );
});

test("the route exposes GET only and carries no route segment config", () => {
  const exported = [
    ...SOURCE.matchAll(
      /\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g,
    ),
  ].map((match) => match[1]);

  assert.deepEqual(exported, ["GET"]);
  for (const name of ["dynamic", "revalidate", "fetchCache", "runtime"]) {
    assert.doesNotMatch(
      SOURCE,
      new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${name}\\b`),
    );
  }
});
