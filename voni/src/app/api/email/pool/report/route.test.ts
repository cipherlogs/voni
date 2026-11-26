/**
 * The pool-report intake, exercised as a handler: every case calls `POST` with a
 * constructed `Request` and stubs only the database write, so the auth gate, the
 * body cap, the OS header and the error mapping are the real code paths.
 *
 * A few source-text assertions remain on purpose: exports and route segment
 * config are module shape, and the ordering of the auth call against the write
 * cannot be observed from a stubbed writer that is never reached.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { PoolReportInput } from "@/lib/email/pool-report";
import { POST } from "./route";
import { setPoolReportWriter } from "./writer";

const SECRET = "test-pool-report-secret";
const ENDPOINT = "https://voni.cc/api/email/pool/report";
const MAX_BODY_BYTES = 64 * 1024;

const RAW_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
  "utf8",
);

/** Comments blanked out, lengths kept, so prose about an export is not code. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const newline = src.indexOf("\n", i);
      const stop = newline < 0 ? src.length : newline;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close < 0 ? src.length : close + 2;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const SOURCE = stripComments(RAW_SOURCE);

/** Exactly what `buildPoolReport` + `finalSnapshot` write. */
const EXITS = [
  {
    exitId: "exit-1",
    ip: "198.51.100.24",
    country: "US",
    asn: "7018",
    city: "Ashburn",
    state: "VA",
  },
];

const REQUESTED_AT = "2026-11-26T08:00:00.000Z";
const FINISHED_AT = "2026-11-26T09:00:00.000Z";

const VALID = {
  enabled: true,
  minReady: 3,
  gate: {
    ok: true,
    reason: null,
    detail: null,
    attempts: 1,
    waitedMs: 1_200,
    checkedAt: REQUESTED_AT,
    ready: 3,
    exits: EXITS,
    refills: 1,
    reconnects: 0,
    lastError: null,
    clientLog: null,
  },
  final: {
    ok: true,
    error: null,
    checkedAt: FINISHED_AT,
    ready: 3,
    exits: EXITS,
    refills: 2,
    reconnects: 0,
    lastError: null,
  },
};

const PARSED: PoolReportInput = {
  producer: "github",
  runnerOs: "ubuntu",
  report: {
    enabled: true,
    minReady: 3,
    gate: {
      ok: true,
      reason: null,
      detail: null,
      attempts: 1,
      waitedMs: 1_200,
      checkedAt: REQUESTED_AT,
      ready: 3,
      exits: EXITS,
      refills: 1,
      reconnects: 0,
      lastError: null,
      clientLog: null,
    },
    final: {
      ok: true,
      error: null,
      checkedAt: FINISHED_AT,
      ready: 3,
      exits: EXITS,
      refills: 2,
      reconnects: 0,
      lastError: null,
    },
  },
};

process.env.EMAIL_CLICK_REPORT_SECRET = SECRET;
test.after(() => {
  delete process.env.EMAIL_CLICK_REPORT_SECRET;
});
// The seam defaults to the real writer; each test restores it.
test.afterEach(() => setPoolReportWriter());

function postRequest({
  body = JSON.stringify(VALID),
  secret = SECRET,
  os = "ubuntu",
  headers = {},
}: {
  body?: string;
  secret?: string | null;
  os?: string | null;
  headers?: Record<string, string>;
} = {}): Request {
  const sent = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(headers)) sent.set(name, value);
  if (secret !== null) sent.set("x-voni-click-secret", secret);
  if (os !== null) sent.set("x-voni-runner-os", os);
  return new Request(ENDPOINT, { method: "POST", body, headers: sent });
}

function recordWrites(): PoolReportInput[] {
  const calls: PoolReportInput[] = [];
  setPoolReportWriter(async (input) => {
    calls.push(input);
  });
  return calls;
}

test("a missing secret header is 401 and never reaches the writer", async () => {
  const calls = recordWrites();
  const response = await POST(postRequest({ secret: null }));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 0);
});

test("a wrong secret header is the same 401 as a missing one", async () => {
  const calls = recordWrites();
  const response = await POST(postRequest({ secret: "not-the-secret" }));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, reason: "unauthorized" });
  assert.equal(calls.length, 0);
});

test("an unset secret is a 503 that names nothing", async () => {
  const saved = process.env.EMAIL_CLICK_REPORT_SECRET;
  delete process.env.EMAIL_CLICK_REPORT_SECRET;
  try {
    const response = await POST(postRequest({ secret: null }));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      reason: "not_configured",
    });
  } finally {
    process.env.EMAIL_CLICK_REPORT_SECRET = saved;
  }
});

test("unparsable JSON is a 400 with a machine-readable reason", async () => {
  const calls = recordWrites();
  const response = await POST(postRequest({ body: '{"enabled": ' }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, reason: "bad_json" });
  assert.equal(calls.length, 0);
});

test("a declared oversize body is refused before it is read", async () => {
  const calls = recordWrites();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(VALID)));
    },
    pull(controller) {
      // Reaching a read would prove the cap ran too late.
      controller.error(new Error("the body must not be read"));
    },
  });

  const response = await POST(
    new Request(ENDPOINT, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-voni-click-secret": SECRET,
        "x-voni-runner-os": "ubuntu",
        "content-length": String(MAX_BODY_BYTES + 1),
      },
      duplex: "half",
    } as RequestInit),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, reason: "too_large" });
  assert.equal(calls.length, 0);
});

test("a chunked body over the cap is a 413 and is never fully buffered", async () => {
  const calls = recordWrites();
  const chunk = new Uint8Array(1024).fill(0x20);
  const totalChunks = 96;
  let pulled = 0;
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalChunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });

  const response = await POST(
    new Request(ENDPOINT, {
      method: "POST",
      body,
      // No content-length: the declared-length fast path cannot see this one.
      headers: {
        "content-type": "application/json",
        "x-voni-click-secret": SECRET,
        "x-voni-runner-os": "ubuntu",
      },
      duplex: "half",
    } as RequestInit),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, reason: "too_large" });
  assert.equal(calls.length, 0);
  assert.equal(cancelled, true, "the read is cancelled at the cap");
  assert.ok(
    pulled <= MAX_BODY_BYTES / chunk.byteLength + 2,
    `the handler read ${pulled} chunks: the cap is a memory bound, not a check after the fact`,
  );
});

test("a report without a runner OS is refused and nothing is written", async () => {
  const calls = recordWrites();
  const response = await POST(postRequest({ os: null }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    reason: "bad_runner_os",
  });
  assert.equal(calls.length, 0);
});

test("an OS outside the allowlist is refused and nothing is written", async () => {
  const calls = recordWrites();
  const response = await POST(postRequest({ os: "linux" }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    reason: "bad_runner_os",
  });
  assert.equal(calls.length, 0);
});

test("a malformed report shape is a 400 with a reason, never a throw", async () => {
  const calls = recordWrites();
  const response = await POST(
    postRequest({ body: JSON.stringify({ ...VALID, gate: "not a gate" }) }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, reason: "bad_gate" });
  assert.equal(calls.length, 0);
});

test("a report from a pool that was never enabled is refused", async () => {
  const calls = recordWrites();
  const response = await POST(
    postRequest({ body: JSON.stringify({ ...VALID, enabled: false }) }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, reason: "not_enabled" });
  assert.equal(calls.length, 0);
});

test("a valid report is stored once, as producer github for that runner OS", async () => {
  const calls = recordWrites();
  const response = await POST(postRequest());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], PARSED);
});

test("a failed gate's report is stored on its own OS row", async () => {
  const calls = recordWrites();
  const failed = {
    ...VALID,
    gate: {
      ...VALID.gate,
      ok: false,
      reason: "short-of-exits",
      detail: "only 1 of 3 exits are ready",
      ready: 1,
      attempts: 90,
      waitedMs: 180_000,
      clientLog: null,
    },
    final: null,
  };
  const response = await POST(postRequest({ body: JSON.stringify(failed), os: "macos" }));

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runnerOs, "macos");
  assert.equal(calls[0].report.gate.ok, false);
  assert.equal(calls[0].report.gate.reason, "short-of-exits");
  assert.equal(calls[0].report.final, null);
});

test("a failed write is a 502 and logs a fixed string, never the payload", async () => {
  setPoolReportWriter(async () => {
    // A driver error can quote the row it refused.
    throw new Error(`insert failed for ${JSON.stringify(EXITS[0].ip)}`);
  });

  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  let response: Response;
  try {
    response = await POST(postRequest());
  } finally {
    console.error = original;
  }

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, reason: "not_stored" });
  assert.deepEqual(logged, [["tuxler pool report not stored"]]);
  assert.ok(
    !logged.flat().some((entry) => String(entry).includes("198.51.100.24")),
    "a value from the payload never reaches the logs",
  );
});

test("the route exports POST and nothing else", () => {
  const exported = [
    ...SOURCE.matchAll(
      /\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g,
    ),
  ].map((match) => match[1]);

  assert.deepEqual(
    exported,
    ["POST"],
    "a second export (a GET, a helper) would widen the surface this route was reviewed for",
  );
  assert.doesNotMatch(SOURCE, /\bexport\s+default\b/);
  assert.doesNotMatch(SOURCE, /\bexport\s*\{/);
  assert.doesNotMatch(SOURCE, /\bexport\s*\*/);
});

test("the route carries no route segment config", () => {
  for (const name of ["dynamic", "revalidate", "fetchCache", "runtime"]) {
    assert.doesNotMatch(
      SOURCE,
      new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${name}\\b`),
      `exporting ${name} would be rejected under cacheComponents, or change the runtime`,
    );
  }
});

test("the auth check runs before the write in the route source", () => {
  const authorized = SOURCE.indexOf("isClickReportAuthorized(");
  const written = SOURCE.indexOf("persistPoolReport(");

  assert.ok(authorized >= 0, "the route calls the shared auth check");
  assert.ok(written >= 0, "the route calls the writer");
  assert.ok(
    authorized < written,
    "auth is decided before the write; moving it below would leave an open endpoint",
  );
});
