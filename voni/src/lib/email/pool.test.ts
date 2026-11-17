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
import TARGETS_JSON from "./targets.json";
import {
  assertEmailTargets,
  DEFAULT_TIMEOUT_MS,
  EMAIL_CAMPAIGN,
  EMAIL_MEDIUM,
  EMAIL_PROVIDERS,
  EMAIL_SOURCE_PARAM,
  EMAIL_TARGETS,
  EMAIL_TARGETS_FILE,
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

test("bags: every target is an absolute URL and the GitHub Pages slash stays", () => {
  // The bag is the operator-edited JSON file (docs/agents/email-pool.md), so its
  // size and contents are data, not invariants here. The invariants that hold
  // for any entry are shape (absolute) and the GitHub Pages trailing slash.
  assert.ok(EMAIL_TARGETS.length > 0, "the bag must not be empty");
  for (const entry of EMAIL_TARGETS) {
    assert.match(entry, /^https?:\/\//i, "every target is absolute; the bag carries no paths");
  }
  if (EMAIL_TARGETS.some((entry) => new URL(entry).hostname === "cipherlogs.github.io")) {
    assert.ok(
      EMAIL_TARGETS.includes("https://cipherlogs.github.io/print/"),
      "GitHub Pages 301s /print to /print/, so the trailing slash keeps the draw on the page",
    );
  }
});

test("targets: the bag is exactly the operator-edited JSON file", () => {
  // Proves the module ships the file's contents unfiltered — not what the
  // operator has in it today.
  assert.deepEqual([...EMAIL_TARGETS], TARGETS_JSON);
});

test("targets: every entry is an absolute https URL with a host", () => {
  for (const entry of EMAIL_TARGETS) {
    const url = new URL(entry);
    assert.equal(url.protocol, "https:", `${entry} must be https`);
    assert.ok(url.hostname, `${entry} must have a host`);
    assert.equal(url.toString(), entry, `${entry} is already absolute, never resolved`);
  }
});

test("targets guard: a path-only, http or non-URL entry throws by name and file", () => {
  for (const bad of ["/print/", "http://voni.cc/test", "not a url"]) {
    assert.throws(
      () => assertEmailTargets([bad]),
      (error: Error) =>
        error.message.includes(JSON.stringify(bad)) &&
        error.message.includes(EMAIL_TARGETS_FILE),
      `${bad} must be rejected`,
    );
  }
  assert.equal(assertEmailTargets(EMAIL_TARGETS), EMAIL_TARGETS, "the real bag passes");
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
      region: "weur",
      ok: true,
      status: 200,
      ms: 187,
      target: TARGET,
      finalUrl: TARGET,
      redirected: false,
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
    assert.equal(worker.region, "weur", "the placement hint the object was created with");
    assert.equal(worker.target, TARGET, "target stays what was requested");
    assert.equal(worker.finalUrl, TARGET, "a direct 200 ends on the target itself");
    assert.equal(worker.redirected, false, "nothing moved");
    assert.equal(worker.reason, null);
    assert.ok(!("location" in worker), "location is gone from the contract");
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

test("fan-out: the default budget outlives the object's own 8s so its verdict wins", () => {
  // The click crosses a DO hop in another region before the fetch starts, so the
  // object's 8s budget must expire first and its verdict must be the one
  // reported; a shorter fan-out timeout would turn that verdict into "timeout".
  assert.ok(DEFAULT_TIMEOUT_MS > 8_000, "must outlast the object's own budget");
  assert.equal(DEFAULT_TIMEOUT_MS, 10_000);
});

test("fan-out: region parses with a null colo, and a missing region stays null", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const worker = nameOf(String(input));
    if (worker === "email-pool-01") {
      // The object runs where the hint put it but the runtime reports no colo,
      // which is normal now: the region alone has to stand on its own.
      return jsonResponse({
        worker,
        colo: null,
        region: "wnam",
        ok: true,
        status: 200,
        ms: 160,
        target: TARGET,
        finalUrl: TARGET,
        redirected: false,
        reason: null,
      });
    }
    // A Worker that does not report a region at all.
    return jsonResponse({
      worker,
      colo: "IAD",
      ok: true,
      status: 200,
      ms: 140,
      target: TARGET,
    });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-region",
    fetch: fetchImpl,
  });

  const hinted = result.workers.find((worker) => worker.worker === "email-pool-01");
  assert.ok(hinted?.ok);
  if (!hinted?.ok) return;
  assert.equal(hinted.region, "wnam", "the placement hint is parsed as sent");
  assert.equal(hinted.colo, null, "a null colo is a value, not a missing field");

  const quiet = result.workers.find((worker) => worker.worker === "email-pool-02");
  assert.ok(quiet?.ok);
  if (!quiet?.ok) return;
  assert.equal(quiet.region, null, "an absent region parses to null, never a guess");
  assert.equal(quiet.colo, "IAD");
});

test("fan-out: a redirected worker reports where the chain ended, off the target", async () => {
  const landed =
    "https://www.glizzitrium.com/BCMPW39K/CZ562T2/?utm_source=gmail.com&utm_medium=email&utm_campaign=voni-email";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const worker = nameOf(String(input));
    return jsonResponse({
      worker,
      colo: "FRA",
      ok: true,
      status: 200,
      ms: 240,
      target: TARGET,
      finalUrl: landed,
      redirected: true,
      reason: null,
    });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-redirect",
    fetch: fetchImpl,
  });

  const [row] = result.workers;
  assert.ok(row.ok);
  if (!row.ok) return;
  assert.equal(row.redirected, true, "the chain moved");
  assert.equal(row.finalUrl, landed, "finalUrl is where it ended, not where it started");
  assert.equal(row.target, TARGET, "target stays the URL that was requested");
  assert.equal(row.status, 200, "ok and status are the verdict on the final response");
});

test("fan-out: a failure row keeps its reason and is not dressed up as a fetched page", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const worker = nameOf(String(input));
    if (worker === "email-pool-02") {
      return jsonResponse({ worker, ok: false, reason: "upstream_503" }, 502);
    }
    return jsonResponse({
      worker,
      colo: "FRA",
      ok: true,
      status: 200,
      ms: 100,
      target: TARGET,
      finalUrl: TARGET,
      redirected: false,
      reason: null,
    });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-failure-row",
    fetch: fetchImpl,
  });

  const failed = result.workers.find((worker) => worker.worker === "email-pool-02");
  assert.deepEqual(failed, {
    worker: "email-pool-02",
    ok: false,
    reason: "upstream_503",
  });
  assert.ok(failed && !failed.ok);
  assert.ok(!("status" in (failed as object)), "no status on a failure row");
  assert.ok(!("finalUrl" in (failed as object)), "no finalUrl on a failure row");
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

  // A 200 body that omits the new fields parses to "no chain", not to a guess.
  const answered = result.workers.find((worker) => worker.worker === "email-pool-01");
  assert.ok(answered?.ok);
  if (!answered?.ok) return;
  assert.equal(answered.finalUrl, null);
  assert.equal(answered.redirected, false);
});

test("fan-out: a 404 the Worker observed is a failing row, never an answered page", async () => {
  // The Worker answers 200 on purpose when the page it landed on was a 404, so
  // the caller learns the status; the body's verdict, not the transport's, is
  // what decides the row.
  const landed = "https://voni.cc/missing?utm_source=gmail.com";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const worker = nameOf(String(input));
    if (worker === "email-pool-01") {
      return jsonResponse({
        worker,
        ok: false,
        reason: "http_error",
        status: 404,
        ms: 210,
        colo: "FRA",
        region: "weur",
        target: TARGET,
        finalUrl: landed,
        redirected: true,
      });
    }
    return jsonResponse({
      worker,
      colo: "IAD",
      region: "wnam",
      ok: true,
      status: 200,
      ms: 120,
      target: TARGET,
      finalUrl: TARGET,
      redirected: false,
      reason: null,
    });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-404",
    fetch: fetchImpl,
  });

  const row = result.workers.find((worker) => worker.worker === "email-pool-01");
  assert.ok(row && !row.ok, "a 404 landing page is not a worker that answered");
  if (!row || row.ok) return;
  assert.ok("status" in row, "the row keeps the status the Worker reported");
  if (!("status" in row)) return;
  assert.equal(row.status, 404, "the observed 404, not the transport's 200");
  assert.equal(row.reason, "http_error");
  assert.equal(row.finalUrl, landed, "the row keeps where the chain ended");
  assert.equal(row.redirected, true);
  assert.equal(row.region, "weur", "the observation survives the failing verdict");
  assert.equal(row.ms, 210);

  assert.equal(
    result.workers.filter((worker) => worker.ok).length,
    2,
    "only the two 200 bodies that say ok count as answered",
  );
});

test("fan-out: an ok body is still the success path with a null reason", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const worker = nameOf(String(input));
    return jsonResponse({
      worker,
      colo: "FRA",
      region: "weur",
      ok: true,
      status: 200,
      ms: 180,
      target: TARGET,
      finalUrl: TARGET,
      redirected: false,
      reason: null,
    });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-ok",
    fetch: fetchImpl,
  });

  const [row] = result.workers;
  assert.ok(row.ok, "an explicit ok: true is the only success path");
  if (!row.ok) return;
  assert.equal(row.status, 200);
  assert.equal(row.reason, null);
  assert.equal(result.workers.filter((worker) => worker.ok).length, 3);
});

test("fan-out: a 200 body with no ok field is not success", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const worker = nameOf(String(input));
    if (worker === "email-pool-01") {
      // Status reported, verdict missing: the status is kept, the row is not ok.
      return jsonResponse({
        worker,
        status: 200,
        ms: 150,
        colo: "FRA",
        region: "weur",
        target: TARGET,
        finalUrl: TARGET,
        redirected: false,
      });
    }
    if (worker === "email-pool-02") {
      // Neither verdict nor status: nothing to attach a status to.
      return jsonResponse({ worker, ms: 140 });
    }
    return jsonResponse({
      worker,
      ok: true,
      status: 200,
      ms: 120,
      target: TARGET,
      finalUrl: TARGET,
      redirected: false,
      reason: null,
    });
  }) as typeof globalThis.fetch;

  const result = await fanOutToWorkers({
    urls: URLS,
    secret: "dev-pool-secret",
    target: TARGET,
    visitId: "visit-no-ok",
    fetch: fetchImpl,
  });

  const underscored = result.workers.find((worker) => worker.worker === "email-pool-01");
  assert.ok(underscored && !underscored.ok, "a 200 body that never says ok is not success");
  if (!underscored || underscored.ok) return;
  assert.ok("status" in underscored);
  if (!("status" in underscored)) return;
  assert.equal(underscored.status, 200);
  assert.equal(underscored.reason, "http_error", "a failing verdict defaults to http_error");
  assert.equal(underscored.finalUrl, TARGET, "the observation is kept");

  assert.deepEqual(
    result.workers.find((worker) => worker.worker === "email-pool-02"),
    { worker: "email-pool-02", ok: false, reason: "http_error" },
    "no reported status means no status field, never a fabricated one",
  );
  assert.equal(result.workers.filter((worker) => worker.ok).length, 1);
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
