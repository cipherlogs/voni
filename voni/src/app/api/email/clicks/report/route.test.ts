/**
 * The Grafana click-report intake, exercised as a handler: every case calls
 * `POST` with a constructed `Request` and stubs only the database write, so the
 * auth gate, the body cap and the error mapping are the real code paths.
 *
 * One source-text assertion survives on purpose: the ordering of the auth call
 * against the write cannot be observed from a stubbed writer that is never
 * reached.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ClickReportInput } from "@/lib/email/click-report";
import { POST } from "./route";
import { setClickReportWriter } from "./writer";

const SECRET = "test-report-secret";
const ENDPOINT = "https://voni.cc/api/email/clicks/report";
const MAX_BODY_BYTES = 4096;

const RAN_AT = new Date().toISOString();
const VALID = {
  target:
    "https://cipherlogs.github.io/print/?utm_source=gmail.com&utm_medium=email&utm_campaign=voni-email",
  source: "gmail.com",
  finalUrl: null,
  status: 200,
  ms: 320,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
  device: "desktop" as const,
  browser: "chromium",
  ranAt: RAN_AT,
};
const PARSED: ClickReportInput = { ...VALID, ranAt: new Date(RAN_AT) };

process.env.EMAIL_CLICK_REPORT_SECRET = SECRET;
test.after(() => {
  delete process.env.EMAIL_CLICK_REPORT_SECRET;
});
// The seam defaults to the real writer; each test restores it.
test.afterEach(() => setClickReportWriter());

function postRequest({
  body = JSON.stringify(VALID),
  secret = SECRET,
  headers = {},
}: {
  body?: string;
  secret?: string | null;
  headers?: Record<string, string>;
} = {}): Request {
  const sent = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(headers)) sent.set(name, value);
  if (secret !== null) sent.set("x-voni-click-secret", secret);
  return new Request(ENDPOINT, { method: "POST", body, headers: sent });
}

function recordWrites(): ClickReportInput[] {
  const calls: ClickReportInput[] = [];
  setClickReportWriter(async (input) => {
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
  const response = await POST(postRequest({ body: '{"target": ' }));

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
      // Reaching a read would prove the cap ran too late; the route's own read
      // would then turn this into a 400 rather than the 413 below.
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
        "content-length": String(MAX_BODY_BYTES + 1),
      },
      duplex: "half",
    } as RequestInit),
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, reason: "too_large" });
  assert.equal(calls.length, 0);
});

test("a valid report is stored once, in the shape the parser produced", async () => {
  const calls = recordWrites();
  const response = await POST(postRequest());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], PARSED);
});

test("a failed write is a 502 and logs a fixed string, never the error message", async () => {
  setClickReportWriter(async () => {
    // Mirrors assertClickTarget: the message quotes the target it refused.
    throw new Error(`Invalid affiliate click target ${JSON.stringify(VALID.target)}`);
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
  assert.deepEqual(logged, [["email click report not stored"]]);
  assert.ok(
    !logged.flat().some((entry) => String(entry).includes("cipherlogs.github.io")),
    "a URL from the payload never reaches the logs",
  );
});

test("the auth check runs before the write in the route source", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
    "utf8",
  );
  const authorized = source.indexOf("isClickReportAuthorized(");
  const written = source.indexOf("persistClickReport(");

  assert.ok(authorized >= 0, "the route calls the shared auth check");
  assert.ok(written >= 0, "the route calls the writer");
  assert.ok(
    authorized < written,
    "auth is decided before the write; moving it below would leave an open endpoint",
  );
});
