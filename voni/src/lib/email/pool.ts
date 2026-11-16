/**
 * The `/email` edge-worker pool: target and source selection, worker URL
 * parsing, and the fan-out to every Worker in the pool.
 *
 * The contract both halves implement is `docs/agents/email-pool.md`. This module
 * used to live in `src/proxy.ts` as the source of a 307; `/email` is a page now,
 * so nothing here may assume a redirect. The browser never picks the target:
 * callers draw it from the bags below, and `fanOutToWorkers` only accepts an
 * already-resolved absolute URL.
 */

/** Targets are edited here, never in this file: `src/lib/email/targets.json`. */
import TARGETS_JSON from "./targets.json";

/** Named in the guard's error so a bad edit points straight at the file. */
export const EMAIL_TARGETS_FILE = "src/lib/email/targets.json";

/**
 * What a Worker may be asked to fetch. Every entry is an absolute URL: the bag
 * carries no paths, so there is no origin to resolve against and no second
 * source of truth for where a target lives.
 *
 * `https://cipherlogs.github.io/print/` keeps its trailing slash because GitHub
 * Pages 301s `/print` to `/print/`, and the pool fetches with
 * `redirect: "manual"`, so a slashless target would be reported as a redirect
 * instead of a page.
 *
 * A path-only, `http` or non-URL entry would otherwise be fetched as something
 * else (or silently fetch nothing), so the guard below throws by name and by
 * file at module load: a bad edit fails loudly.
 */
export function assertEmailTargets(
  entries: readonly string[],
): readonly string[] {
  for (const entry of entries) {
    let url: URL | null = null;
    try {
      url = new URL(entry);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || !url.hostname) {
      throw new Error(
        `Invalid email target ${JSON.stringify(entry)} in ${EMAIL_TARGETS_FILE}: ` +
          "every entry must be an absolute https:// URL with a host.",
      );
    }
  }
  return entries;
}

export const EMAIL_TARGETS: readonly string[] = assertEmailTargets(TARGETS_JSON);

/** The claimed source of the visit, used only as `utm_source`. */
export const EMAIL_PROVIDERS = [
  "xfinity.com",
  "spectrum.com",
  "att.com",
  "verizon.com",
  "cox.com",
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
];

export const EMAIL_SOURCE_PARAM = "utm_source";
/** The channel the visit is attributed to, stamped on every target. */
export const EMAIL_MEDIUM = "email";
/** The campaign the visit is attributed to, stamped on every target. */
export const EMAIL_CAMPAIGN = "voni-email";

/**
 * Draw without replacement: every entry appears once per pass, in its own
 * shuffled order, then the bag refills. `random` is injectable so a test can
 * pin the order. Instances live as long as the module instance, so a cold start
 * simply begins a new shuffle.
 */
export function shuffleBag<T>(
  items: readonly T[],
  random: () => number = Math.random,
): () => T {
  let order: T[] = [];
  let cursor = 0;
  return () => {
    if (cursor >= order.length) {
      order = [...items];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      cursor = 0;
    }
    return order[cursor++];
  };
}

export const nextEmailTarget = shuffleBag(EMAIL_TARGETS);
export const nextEmailProvider = shuffleBag(EMAIL_PROVIDERS);

/**
 * One target URL with the claimed attribution stamped on as `utm_source`,
 * `utm_medium` and `utm_campaign`. The source is drawn from the same no-repeat
 * bag as the target.
 *
 * The entry is absolute and keeps its own host, path and query; the three params
 * are `set`, never appended, so an entry's own query keys survive and no utm key
 * is duplicated. A non-absolute entry throws here, at the boundary, rather than
 * being silently resolved against some origin.
 */
export function resolveTarget(
  entry: string,
  source: string = nextEmailProvider(),
): string {
  const url = new URL(entry);
  url.searchParams.set(EMAIL_SOURCE_PARAM, source);
  url.searchParams.set("utm_medium", EMAIL_MEDIUM);
  url.searchParams.set("utm_campaign", EMAIL_CAMPAIGN);
  return url.toString();
}

/**
 * `POOL_WORKER_URLS` is a comma-separated list of Worker origins. Blank entries,
 * non-http(s) schemes, unparseable values and duplicates are dropped rather
 * than throwing: a half-configured pool should still report the workers it can
 * reach, and "not configured" is decided by the caller on an empty result.
 */
export function parseWorkerUrls(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const normalized = trimmed;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

/** Contract 200 body from one Worker. */
export type WorkerReport = {
  worker: string;
  ok: true;
  status: number | null;
  ms: number;
  colo: string | null;
  target: string;
  location: string | null;
  reason: null;
};

/** Contract failure body from one Worker: the minimum both halves agreed on. */
export type WorkerFailure = {
  worker: string;
  ok: false;
  reason: string;
};

export type WorkerResult = WorkerReport | WorkerFailure;

export type FanOutInput = {
  urls: string[];
  secret: string;
  /** Absolute URL, already carrying the three utm params. */
  target: string;
  visitId: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type FanOutResult = {
  target: string;
  source: string | null;
  visitId: string;
  workers: WorkerResult[];
};

const DEFAULT_TIMEOUT_MS = 8_000;

function sourceOf(target: string): string | null {
  try {
    return new URL(target).searchParams.get(EMAIL_SOURCE_PARAM);
  } catch {
    return null;
  }
}

/**
 * Best-effort worker name when the response body is unusable. A deployed pool
 * member is `<name>.<account>.workers.dev`, so the first label is the name the
 * Worker reports too; a local `wrangler dev` URL keeps its port so two ports on
 * one host stay distinguishable.
 */
export function workerIdFromUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname;
    if (host === "localhost" || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)) {
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return `${host}:${port}`;
    }
    return host.split(".")[0] || host;
  } catch {
    return raw;
  }
}

function isTimeout(cause: unknown): boolean {
  const name = (cause as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function callOneWorker(
  input: FanOutInput,
  url: string,
  doFetch: typeof globalThis.fetch,
): Promise<WorkerResult> {
  const endpoint = `${url}/click`;
  const started = Date.now();
  const fallbackId = workerIdFromUrl(url);

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pool-secret": input.secret,
      },
      body: JSON.stringify({ url: input.target, visitId: input.visitId }),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    // A dead worker must not take the pool report with it: every member is
    // reported separately, so the page can show the ones that answered.
    return {
      worker: fallbackId,
      ok: false,
      reason: isTimeout(cause) ? "timeout" : "fetch_failed",
    };
  }

  const elapsed = Date.now() - started;
  const body = asRecord(await response.json().catch(() => null));
  const worker = asString(body?.worker) ?? fallbackId;

  if (response.status === 401) {
    return { worker, ok: false, reason: "unauthorized" };
  }
  if (!response.ok) {
    return {
      worker,
      ok: false,
      reason: asString(body?.reason) ?? "fetch_failed",
    };
  }

  return {
    worker,
    ok: true,
    status: asNumber(body?.status),
    ms: asNumber(body?.ms) ?? elapsed,
    colo: asString(body?.colo),
    target: asString(body?.target) ?? input.target,
    location: asString(body?.location),
    reason: null,
  };
}

/**
 * Ask every Worker in parallel to fetch `target`, and never throw: a member that
 * times out, refuses the secret or dies mid-request is one failed row in the
 * report, while the rest still land. The browser cannot reach this with its own
 * URL — the caller resolves the target server-side.
 */
export async function fanOutToWorkers(
  input: FanOutInput,
): Promise<FanOutResult> {
  const doFetch = input.fetch ?? globalThis.fetch;
  const settled = await Promise.allSettled(
    input.urls.map((url) => callOneWorker(input, url, doFetch)),
  );

  const workers: WorkerResult[] = settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : {
          worker: workerIdFromUrl(input.urls[index] ?? ""),
          ok: false as const,
          reason: "fetch_failed",
        },
  );

  return {
    target: input.target,
    source: sourceOf(input.target),
    visitId: input.visitId,
    workers,
  };
}
