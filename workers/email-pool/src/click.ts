/**
 * Outbound click: build the pool request headers and perform one fetch against
 * an already-validated target, following the whole redirect chain so the
 * report describes where the click actually landed.
 */

export interface PoolEnv {
  POOL_SECRET?: string;
  POOL_USER_AGENT?: string;
  POOL_INDEX?: string;
  /** Optional explicit override; deploy sets the instance name, index is enough. */
  POOL_WORKER_ID?: string;
  [key: string]: unknown;
}

export const CLICK_TIMEOUT_MS = 8_000;

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface ClickBase {
  worker: string;
  colo: string;
  ms: number;
  target: string;
}

/** The target answered. `finalUrl` is where the redirect chain ended. */
export interface ClickObservation extends ClickBase {
  ok: boolean;
  status: number;
  finalUrl: string;
  redirected: boolean;
  reason: string | null;
}

/** The fetch never produced a response, so there is no finalUrl to report. */
export interface ClickFailure extends ClickBase {
  ok: false;
  status: null;
  reason: "timeout" | "fetch_failed";
  detail: string;
}

export type ClickResult = ClickObservation | ClickFailure;

export interface RunClickOptions {
  fetch: typeof fetch;
  /** Cloudflare colo code for this worker instance. */
  colo?: string;
  timeoutMs?: number;
}

/**
 * Instance name derived from POOL_INDEX, matching the deploy naming scheme:
 * POOL_INDEX=0 -> "email-pool-01".
 */
export function poolWorkerId(env: PoolEnv): string {
  if (typeof env.POOL_WORKER_ID === "string" && env.POOL_WORKER_ID !== "") {
    return env.POOL_WORKER_ID;
  }
  const parsed = Number.parseInt(env.POOL_INDEX ?? "0", 10);
  const index = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  return `email-pool-${String(index + 1).padStart(2, "0")}`;
}

/** Exactly the header set in the contract. */
export function buildTargetHeaders(
  workerId: string,
  env: PoolEnv,
): Record<string, string> {
  const userAgent =
    typeof env.POOL_USER_AGENT === "string" && env.POOL_USER_AGENT.trim() !== ""
      ? env.POOL_USER_AGENT.trim()
      : DEFAULT_USER_AGENT;

  return {
    "user-agent": userAgent,
    referer: "https://voni.cc/email",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "x-pool-worker": workerId,
  };
}

function isTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

export async function runClick(
  url: URL,
  env: PoolEnv,
  options: RunClickOptions,
): Promise<ClickResult> {
  const worker = poolWorkerId(env);
  const colo = options.colo ?? "UNKNOWN";
  const target = url.toString();
  const timeoutMs = options.timeoutMs ?? CLICK_TIMEOUT_MS;
  const started = Date.now();

  let response: Response;
  try {
    response = await options.fetch(target, {
      method: "GET",
      // follow the chain so status/finalUrl describe the landing page, not hop
      // one; the timeout signal covers the whole chain.
      redirect: "follow",
      headers: buildTargetHeaders(worker, env),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      worker,
      colo,
      ok: false,
      status: null,
      ms: Date.now() - started,
      target,
      reason: isTimeoutError(error) ? "timeout" : "fetch_failed",
      detail: errorDetail(error),
    };
  }

  const ms = Date.now() - started;
  const ok = response.status >= 200 && response.status < 400;
  // A followed landing page may be huge and we only want its status, so drop
  // the body without buffering it.
  const finalUrl = response.url !== "" ? response.url : target;

  try {
    await response.body?.cancel();
  } catch {
    // Body already consumed or locked; irrelevant for the observation.
  }

  return {
    worker,
    colo,
    ok,
    status: response.status,
    ms,
    target,
    finalUrl,
    redirected: response.redirected,
    reason: ok ? null : "http_error",
  };
}
