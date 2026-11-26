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
  readLatestPoolReport,
  type PoolReportStore,
  type TuxlerPoolExit,
  type TuxlerPoolReport,
} from "./pool-report";
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

export interface ProxyHealthOrReportOptions extends ProxyHealthReadOptions {
  /** The stored reports; injectable so a test never needs a database. */
  store?: PoolReportStore;
}

/** The sentence the unreachable read adds when no stored report exists either. */
export const NO_POOL_REPORT_MESSAGE = "No Segment has reported a pool yet.";

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
    refills: asNumber(value.refills),
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

/** One report exit in the card's shape. An exit with no address cannot be shown. */
function reportExit(exit: TuxlerPoolExit): ProxyExitView | null {
  if (exit.ip === null) return null;
  return {
    ip: exit.ip,
    // A pooled exit is US by construction; a report that omits the country is
    // still a US exit, not an unknown one.
    country: exit.country ?? "US",
    asn: exit.asn,
    city: exit.city,
    state: exit.state,
  };
}

/** Refusals that mean the control port or the session was the problem. */
const CLIENT_DOWN_GATE_REASONS = new Set([
  "control-unreachable",
  "bad-control-url",
  "client-not-ready",
]);

/**
 * A stored Segment report, in the shape the card already renders.
 *
 * The artifact records `final` after the clicks and `gate` before them, so
 * `final` is the newer observation: it wins when it actually read `/health`.
 * `finalSnapshot` writes `ok: false` and null counts when that read failed, and
 * that half is not an observation — the gate half then answers every field.
 *
 * `buckets` stays empty because the artifact carries no per-bucket snapshot.
 * An empty list is the card's "unknown", never "0 of 0 changes".
 */
export function healthFromPoolReport(report: TuxlerPoolReport): ProxyHealthData {
  const gate = report.gate;
  const final = report.final !== null && report.final.ok ? report.final : null;

  const ready = final?.ready ?? gate.ready;
  const exits = final?.exits ?? gate.exits;
  const refills = final?.refills ?? gate.refills;
  const reconnects = final?.reconnects ?? gate.reconnects;
  const failure = final?.lastError ?? gate.lastError;

  // The report carries no session state. A gate refusal that names the control
  // port is evidence the client was not there; every other refusal is a pool
  // or quota problem the card should keep telling apart from a dead client.
  const connected =
    final !== null ||
    gate.ok ||
    !CLIENT_DOWN_GATE_REASONS.has(gate.reason ?? "");

  return {
    ok: final?.ok === true || gate.ok,
    ready: ready > 0,
    pool: exits
      .map(reportExit)
      .filter((exit): exit is ProxyExitView => exit !== null),
    buckets: [],
    refills,
    reconnects,
    lastError: parseFailure(failure),
    account: null,
    session: { state: connected ? "connected" : "failed" },
  };
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

  return { state: "reported", source: "live", health };
}

/**
 * The live client when one answers, else the newest Segment report.
 *
 * The pool client lives on a GitHub runner's loopback, so production has no
 * address that can reach it. The workflow pushes each Segment's report instead;
 * this read is what keeps the card honest about which one it is showing:
 *
 * - a live `/health` answer always wins, because it is the pool right now;
 * - `unconfigured` and `unreachable` fall back to the newest stored report,
 *   mapped into the same shape so every verdict rule is reused;
 * - with neither, an unconfigured live read stays unconfigured and the
 *   unreachable one keeps its failure plus the plain note that no Segment has
 *   reported.
 *
 * The report is read with no OS filter: the card is one console, so the newest
 * push across every runner answers. Staleness is the card's judgement; the read
 * never pretends an old report is live.
 */
export async function readProxyHealthOrReport(
  options: ProxyHealthOrReportOptions = {},
): Promise<ProxyHealthRead> {
  const live = await readProxyHealth(options);
  if (live.state === "reported") return live;

  const latest = await readLatestPoolReport(undefined, options.store);
  if (latest !== null) {
    return {
      state: "reported",
      source: "report",
      health: healthFromPoolReport(latest.report),
      receivedAt: latest.receivedAt,
      runnerOs: latest.runnerOs,
    };
  }

  if (live.state === "unconfigured") {
    return { state: "unconfigured" };
  }
  return {
    state: "unreachable",
    message: `${live.message} ${NO_POOL_REPORT_MESSAGE}`,
  };
}
