/**
 * Reading the running client's `/health` from the console.
 *
 * The client binds loopback in the runner, so the console cannot assume it is
 * there. The address comes from `TUXLER_CONTROL_URL`; when that is unset the
 * honest answer is "no client is configured", and when it is set but silent the
 * answer is "the client is down" — never a thrown error and never a fabricated
 * empty pool. Both are states the card can show, because an operator who cannot
 * tell "not running" from "no US supply" will chase the wrong problem.
 *
 * This is the one request the console makes to the client, and it is a plain
 * `GET /health`: the control API's read-only endpoint. Nothing here calls
 * `/acquire`, `/release` or anything that spends a change or moves an exit.
 */
import { secret } from "@/lib/env";
import {
  PROXY_HEALTH_URL_ENV,
  type ProxyBucketView,
  type ProxyExitView,
  type ProxyFailureView,
  type ProxyHealthData,
  type ProxyHealthRead,
} from "./proxy-policy";

export { PROXY_HEALTH_URL_ENV } from "./proxy-policy";

const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_STATES = new Set(["starting", "connected", "failed", "stopped"]);

export interface ProxyHealthReadOptions {
  /** Where the address lives; injectable so a test never needs a real env. */
  readEnv?: (name: string) => Promise<string | undefined>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseExit(value: unknown): ProxyExitView | null {
  if (!isRecord(value)) return null;
  const ip = asString(value.ip);
  if (ip === null) return null;
  const asn =
    asString(value.asn) ??
    (typeof value.asn === "number" && Number.isFinite(value.asn)
      ? String(value.asn)
      : null);
  return {
    ip,
    // A pooled exit is US by construction; a report that omits the country is
    // still a US exit, not an unknown one.
    country: asString(value.country) ?? "US",
    asn,
    city: asString(value.city),
    state: asString(value.state),
  };
}

function parseBucket(value: unknown): ProxyBucketView | null {
  if (!isRecord(value)) return null;
  return {
    clientIpHash: asString(value.clientIpHash),
    depth: typeof value.depth === "number" ? value.depth : undefined,
    parentId: asString(value.parentId),
    used: asNumber(value.used),
    limit: asNumber(value.limit),
    remaining: asNumber(value.remaining),
    resetAt: asString(value.resetAt),
  };
}

function parseFailure(value: unknown): ProxyFailureView | null {
  if (!isRecord(value)) return null;
  const reason = asString(value.reason);
  if (reason === null) return null;
  return { reason, message: asString(value.message) ?? "" };
}

/**
 * The report, or `null` when the body cannot be one.
 *
 * A malformed *exit* is dropped, because losing one bad row is better than
 * showing no pool at all; a missing session or a non-array pool means the body
 * is not this client's report, so there is nothing honest to render.
 */
export function parseHealthReport(value: unknown): ProxyHealthData | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.session)) return null;
  const state = asString(value.session.state);
  if (state === null || !HEALTH_STATES.has(state)) return null;
  if (!Array.isArray(value.pool)) return null;
  if (!Array.isArray(value.buckets)) return null;

  const pool = value.pool
    .map(parseExit)
    .filter((exit): exit is ProxyExitView => exit !== null);
  const buckets = value.buckets
    .map(parseBucket)
    .filter((bucket): bucket is ProxyBucketView => bucket !== null);
  const account = isRecord(value.account)
    ? {
        tier: asString(value.account.tier) ?? "unknown",
        premium:
          typeof value.account.premium === "boolean"
            ? value.account.premium
            : null,
        clientIp: asString(value.account.clientIp),
      }
    : null;

  return {
    ok: value.ok === true,
    ready: value.ready === true,
    pool,
    buckets,
    reconnects: asNumber(value.reconnects) ?? 0,
    lastError: parseFailure(value.lastError),
    account,
    session: {
      state: state as ProxyHealthData["session"]["state"],
      handshakeMs: asNumber(value.session.handshakeMs),
      silentForMs: asNumber(value.session.silentForMs),
    },
  };
}

/**
 * The `/health` URL for a configured control address, or `null` when the address
 * is not something this console may call.
 *
 * A URL with a username or password is refused rather than fetched: the client's
 * API never needs one, and a credential in a URL is the kind of thing that ends
 * up in a log.
 */
function healthUrl(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/health`;
  return url.toString();
}

export async function readProxyHealth(
  options: ProxyHealthReadOptions = {},
): Promise<ProxyHealthRead> {
  const readEnv = options.readEnv ?? ((name: string) => secret(name));
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;

  const configured = (await readEnv(PROXY_HEALTH_URL_ENV))?.trim() ?? "";
  if (configured === "") return { state: "unconfigured" };

  const url = healthUrl(configured);
  if (url === null) {
    return {
      state: "unreachable",
      message: "The configured client address is not an http(s) address.",
    };
  }

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        state: "unreachable",
        message: `The client did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      };
    }
    return { state: "unreachable", message: "The client could not be reached." };
  }

  if (!response.ok) {
    return {
      state: "unreachable",
      message: "The client's health endpoint answered with an error.",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      state: "unreachable",
      message: "The client answered with something that is not a health report.",
    };
  }

  const health = parseHealthReport(body);
  if (health === null) {
    return {
      state: "unreachable",
      message: "The client answered with something that is not a health report.",
    };
  }

  return { state: "reported", health };
}
