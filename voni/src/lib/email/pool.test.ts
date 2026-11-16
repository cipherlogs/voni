/**
 * The `/email` pool contract (`docs/agents/email-pool.md`): target and source
 * draw, worker URL parsing, and a fan-out where one dead worker never hides the
 * rest. The route half is proved by its signature — it takes no request, so a
 * malicious body has nothing to influence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { POST } from "@/app/api/email-pool/route";
import {
  EMAIL_CAMPAIGN,
  EMAIL_MEDIUM,
  EMAIL_PROVIDERS,
  EMAIL_SOURCE_PARAM,
  EMAIL_TARGETS,
  fanOutToWorkers,
  nextEmailProvider,
  nextEmailTarget,
  parseWorkerUrls,
  resolveTarget,
  shuffleBag,
  workerIdFromUrl,
} from "./pool";

const URLS = [
  "https://email-pool-01.workers.dev",
  "https://email-pool-02.workers.dev",
  "https://email-pool-03.workers.dev",
];

const TARGET = resolveTarget("https://voni.cc/test", "gmail.com");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nameOf(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

test("bags: a run of draws covers every target and every provider", () => {
  // Without replacement, any N consecutive draws from an N-item bag cross a
  // refill boundary, so the set is always the whole bag.
  const targets = Array.from({ length: EMAIL_TARGETS.length }, () => nextEmailTarget());
  assert.deepEqual([...targets].sort(), [...EMAIL_TARGETS].sort());

  const providers = Array.from({ length: EMAIL_PROVIDERS.length }, () => nextEmailProvider());
  assert.deepEqual([...providers].sort(), [...EMAIL_PROVIDERS].sort());
});

test("bags: two targets, both absolute URLs", () => {
  assert.equal(EMAIL_TARGETS.length, 2);
  assert.deepEqual([...EMAIL_TARGETS], [
    "https://cipherlogs.github.io/print/",
    "https://voni.cc/test",
  ]);
  const paths: readonly string[] = EMAIL_TARGETS;
  for (const entry of paths) {
    assert.match(entry, /^https?:\/\//i, "every target is absolute; the bag carries no paths");
  }
  assert.ok(
    paths.includes("https://cipherlogs.github.io/print/"),
    "GitHub Pages 301s /print to /print/, so the trailing slash stays",
  );
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

test("parseWorkerUrls: trims, de-dupes, drops garbage and non-http schemes", () => {
  assert.deepEqual(parseWorkerUrls(undefined), []);
  assert.deepEqual(parseWorkerUrls(null), []);
  assert.deepEqual(parseWorkerUrls("   ,  ,"), []);
  assert.deepEqual(
    parseWorkerUrls(
      " https://email-pool-01.workers.dev/ , https://email-pool-01.workers.dev ," +
        "not a url, ftp://workers.example, mailto:ops@voni.cc, , http://localhost:8787 ",
    ),
    ["https://email-pool-01.workers.dev", "http://localhost:8787"],
  );
});

test("worker id: first label for a workers.dev host, host:port for local dev", () => {
  assert.equal(workerIdFromUrl("https://email-pool-01.workers.dev"), "email-pool-01");
  assert.equal(workerIdFromUrl("http://localhost:8787"), "localhost:8787");
  assert.equal(workerIdFromUrl("http://127.0.0.1:8789"), "127.0.0.1:8789");
});

test("fan-out: every worker reported in the contract 200 shape, secret and body sent", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const worker = nameOf(String(input));
    return jsonResponse({
      worker,
      colo: "FRA",
      ok: true,
      status: 200,
      ms: 187,
      target: TARGET,
      location: null,
      reason: null,
    });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-1",
    fetch: fetchImpl,
  });

  assert.equal(result.target, TARGET);
  assert.equal(result.source, "gmail.com");
  assert.equal(result.visitId, "visit-1");
  assert.equal(result.workers.length, 3);
  for (const worker of result.workers) {
    assert.equal(worker.ok, true);
    if (!worker.ok) continue;
    assert.equal(worker.status, 200);
    assert.equal(worker.ms, 187);
    assert.equal(worker.colo, "FRA");
    assert.equal(worker.location, null);
    assert.equal(worker.reason, null);
  }

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://email-pool-01.workers.dev/click");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>)["x-pool-secret"],
    "dev-pool-secret",
  );
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    url: TARGET,
    visitId: "visit-1",
  });
  assert.ok(calls[0].init?.signal instanceof AbortSignal, "a timeout signal is always attached");
});

test("fan-out: one worker answers 401 and the rest still land", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).includes("email-pool-02")) {
      return jsonResponse({ ok: false, reason: "unauthorized" }, 401);
    }
    const worker = nameOf(String(input));
    return jsonResponse({ worker, colo: "FRA", ok: true, status: 200, ms: 120 });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-2",
    fetch: fetchImpl,
  });

  const failed = result.workers.filter((worker) => !worker.ok);
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0], {
    worker: "email-pool-02",
    ok: false,
    reason: "unauthorized",
  });
  assert.equal(result.workers.filter((worker) => worker.ok).length, 2);
});

test("fan-out: one worker times out and is reported as timeout", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).includes("email-pool-03")) {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    const worker = nameOf(String(input));
    return jsonResponse({ worker, colo: "IAD", ok: true, status: 200, ms: 90 });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-3",
    fetch: fetchImpl,
  });

  assert.deepEqual(
    result.workers.find((worker) => worker.worker === "email-pool-03"),
    { worker: "email-pool-03", ok: false, reason: "timeout" },
  );
  assert.equal(result.workers.filter((worker) => worker.ok).length, 2);
});

test("fan-out: a network throw is one failed row, never a thrown promise", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).includes("email-pool-01")) {
      throw new TypeError("fetch failed");
    }
    const worker = nameOf(String(input));
    return jsonResponse({ worker, colo: "SIN", ok: true, status: 204, ms: 300 });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-4",
    fetch: fetchImpl,
  });

  assert.equal(result.workers.length, 3);
  assert.deepEqual(
    result.workers.find((worker) => worker.worker === "email-pool-01"),
    { worker: "email-pool-01", ok: false, reason: "fetch_failed" },
  );
  assert.equal(result.workers.filter((worker) => worker.ok).length, 2);
});

test("fan-out: a worker with an unusable body still gets a name from its URL", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const worker = nameOf(String(input));
    if (worker === "email-pool-02") return new Response("<html>bad gateway</html>", { status: 502 });
    return jsonResponse({ ok: true, status: 200, ms: 55, colo: "FRA", target: TARGET });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-5",
    fetch: fetchImpl,
  });

  assert.deepEqual(
    result.workers.find((worker) => worker.worker === "email-pool-02"),
    { worker: "email-pool-02", ok: false, reason: "fetch_failed" },
  );
});

test("route: takes no request at all, so the browser cannot choose the target", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../app/api/email-pool/route.ts"),
    "utf8",
  );
  assert.equal(POST.length, 0, "POST() declares no parameters");
  assert.doesNotMatch(source, /request\.(json|text|formData)\(/);
  assert.doesNotMatch(source, /searchParams/);
  assert.doesNotMatch(source, /EMAIL_TARGET_ORIGIN/, "the bag is absolute, so there is no origin");
  assert.match(source, /nextEmailTarget\(\)/);
});

test("route: a missing pool config is a 503 that names the env vars", async () => {
  const saved = {
    POOL_SECRET: process.env.POOL_SECRET,
    POOL_WORKER_URLS: process.env.POOL_WORKER_URLS,
  };
  delete process.env.POOL_SECRET;
  delete process.env.POOL_WORKER_URLS;
  try {
    const response = await POST();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as {
      ok: boolean;
      reason: string;
      message: string;
    };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "not_configured");
    assert.match(body.message, /POOL_SECRET/);
    assert.match(body.message, /POOL_WORKER_URLS/);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
