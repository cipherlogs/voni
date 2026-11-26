/**
 * The proxy card's rules: what the country and the pool target are allowed to be,
 * and how a health report becomes an operator sentence.
 *
 * This module is deliberately free of I/O so the client card can import it. The
 * read itself lives in `proxy-health.ts` and the database boundary in
 * `proxy-settings.ts`; neither of those is allowed to grow a second rule about
 * what counts as a US exit or a valid pool target.
 *
 * The country is not a setting in the "preference" sense. The client refuses an
 * exit that is not US, so the page has nothing to offer but US; a request that
 * names anything else is a client that does not match this console, and the
 * action refuses it. The pool target is a preference, but a bounded one: the
 * client never holds more than eight exits, and five is the size its plan fills
 * to.
 */

/** The only provider the runner uses today. */
export const PROXY_PROVIDER = "tuxler";
/** The only country the client serves. Not a default — a constraint. */
export const PROXY_COUNTRY = "US";
/** Below this the pool cannot absorb a replacement without a refill. */
export const PROXY_POOL_MIN = 3;
/** The client's hard ceiling (`POOL_MAX`). */
export const PROXY_POOL_MAX = 8;
/** What the pool fills to until the operator chooses another size. */
export const PROXY_POOL_TARGET_DEFAULT = 5;
/** Where the console finds the running client's control API. */
export const PROXY_HEALTH_URL_ENV = "TUXLER_CONTROL_URL";

export type ProxyCountry = typeof PROXY_COUNTRY;

export interface ProxySettings {
  readonly country: ProxyCountry;
  readonly poolTarget: number;
}

/** One ready exit, as `/health` reports it. */
export interface ProxyExitView {
  ip: string;
  country: string;
  asn: string | null;
  city: string | null;
  state: string | null;
}

/** One address the relay meters changes against. Depth 0 is the root. */
export interface ProxyBucketView {
  clientIpHash: string | null;
  depth?: number;
  parentId?: string | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export interface ProxyFailureView {
  reason: string;
  message: string;
}

/** The part of `/health` the card reads. Extra fields from the client are ignored. */
export interface ProxyHealthData {
  ok: boolean;
  ready: boolean;
  pool: ProxyExitView[];
  buckets: ProxyBucketView[];
  reconnects: number;
  lastError: ProxyFailureView | null;
  account: { tier: string; premium: boolean | null; clientIp: string | null } | null;
  session: {
    state: "starting" | "connected" | "failed" | "stopped";
    handshakeMs?: number | null;
    silentForMs?: number | null;
  };
}

/** What the server read, before it becomes a sentence. */
export type ProxyHealthRead =
  | { state: "unconfigured" }
  | { state: "unreachable"; message: string }
  | { state: "reported"; health: ProxyHealthData };

export type ProxyStatus = "ok" | "client-down" | "short-of-exits" | "out-of-quota";

/**
 * One ASN, one spelling. The pool reports digits, Team Cymru reports `AS7018`,
 * and a table cell must not show both forms for one network: `null` (nothing
 * reported) stays `null` so each surface can say so in its own words.
 */
export function asnLabel(asn: string | null | undefined): string | null {
  if (asn === null || asn === undefined) return null;
  const trimmed = asn.trim();
  if (trimmed === "") return null;
  return trimmed.toUpperCase().startsWith("AS") ? trimmed.toUpperCase() : `AS${trimmed}`;
}

export interface ProxyVerdict {
  status: ProxyStatus;
  headline: string;
  detail: string;
}

export const PROXY_STATUS_LABELS: Record<ProxyStatus, string> = {
  ok: "Ready",
  "client-down": "Client down",
  "short-of-exits": "Short of exits",
  "out-of-quota": "Out of quota",
};

/**
 * The country a submitted form names, or `null` when it is not US.
 *
 * Case and surrounding whitespace are not a different country, so `us` is the
 * same answer; `USA`, `GB`, an empty field and anything that is not a string are
 * not, and must never be mapped to a country the client would then serve.
 */
export function parseProxyCountry(value: unknown): ProxyCountry | null {
  if (typeof value !== "string") return null;
  return value.trim().toUpperCase() === PROXY_COUNTRY ? PROXY_COUNTRY : null;
}

/**
 * The pool size a submitted form names, or `null` when it is outside 3–8.
 *
 * A whole number only: the pool counts exits, so `3.5` is not a size. The
 * default is applied by the reader, never by a refusal — a submitted out-of-range
 * value is a refusal, not a quiet reset to five.
 */
export function parseProxyPoolTarget(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed)) return null;
  if (parsed < PROXY_POOL_MIN || parsed > PROXY_POOL_MAX) return null;
  return parsed;
}

/** The target the client should fill to, defaulting only when nothing valid was stored. */
export function resolveProxyPoolTarget(value: unknown): number {
  return parseProxyPoolTarget(value) ?? PROXY_POOL_TARGET_DEFAULT;
}

/**
 * What a stored row means.
 *
 * The country is always US: a hand-edited `GB` is not a country this console can
 * pass down, so it reads as the constraint rather than as a choice. A stored
 * target outside the range is not a pool size either, so it falls back to five —
 * the reader's default, not a rewrite of the row.
 */
export function resolveProxySettings(
  row: { proxyCountry?: string | null; proxyPoolTarget?: number | null } | null | undefined,
): ProxySettings {
  return {
    country: PROXY_COUNTRY,
    poolTarget: resolveProxyPoolTarget(row?.proxyPoolTarget),
  };
}

/**
 * The last failure in operator words.
 *
 * `lastError.reason` is a protocol-side name (`no-us-exit`, `quota-spent`, …).
 * An operator reading the console needs the fact, not the code; an unknown
 * reason must not be echoed as if the operator could act on it, so it becomes a
 * plain sentence with the code left out.
 */
const FAILURE_WORDS: Record<string, string> = {
  "no-us-exit": "no US exit",
  "quota-spent": "quota spent",
  "relay-silent": "relay silent",
  "not-ready": "the pool is not ready",
  "credential-missing": "no account credential",
  "connect-failed": "the relay could not be reached",
  "redirect-failed": "the relay would not redirect the session",
  "conformance-failed": "the relay's probe checks failed",
  "echo-failed": "the relay's echo check failed",
  "second-connection-failed": "the relay's second connection failed",
  "login-rejected": "the relay refused the login",
  "socket-closed": "the relay closed the session",
  "not-us": "the exit was not in the US",
  hosting: "the exit was a hosting address",
  "lookup-failed": "the exit's owner could not be checked",
  "name-lookup-failed": "the exit's owner did not answer",
  limit: "quota spent",
  "not-entitled": "the account is not entitled to changes",
  "no-change": "the relay did not return an exit",
  "not-available": "no exit was available",
  overloaded: "the relay was overloaded",
  "exit-unavailable": "the exit was unavailable",
  "bad-exit": "the client returned an unusable exit",
  incomplete: "the relay's reply was incomplete",
  unrecognised: "the relay's reply was not understood",
  "listener-failed": "the exit's local port could not be opened",
};

export function failureWords(reason: string | null | undefined): string {
  if (reason === null || reason === undefined || reason === "") {
    return "no failure reported";
  }
  return FAILURE_WORDS[reason] ?? "the client reported a failure";
}

function everyBucketSpent(buckets: ProxyBucketView[]): boolean {
  if (buckets.length === 0) return false;
  return buckets.every(
    (bucket) => bucket.remaining !== null && bucket.remaining <= 0,
  );
}

function nextReset(buckets: ProxyBucketView[]): string | null {
  let earliest: number | null = null;
  for (const bucket of buckets) {
    if (bucket.resetAt === null) continue;
    const at = Date.parse(bucket.resetAt);
    if (Number.isNaN(at)) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  if (earliest === null) return null;
  return `${new Date(earliest).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function describeCities(pool: ProxyExitView[]): string {
  const cities = [
    ...new Set(
      pool
        .map((exit) => exit.city)
        .filter((city): city is string => city !== null && city !== ""),
    ),
  ];
  if (cities.length === 0) return "The exits did not report a city.";
  return `Cities: ${cities.join(", ")}.`;
}

/**
 * One sentence an operator can act on, drawn from the read.
 *
 * The order is deliberate: a dead client is not "short of exits", because no
 * amount of supply fixes it; an exhausted bucket is not "short of exits" either,
 * because the pool cannot spend its way out; and only then does a live client
 * below its target count as thin supply.
 */
export function describeProxyHealth(read: ProxyHealthRead, target: number): ProxyVerdict {
  const wanted = resolveProxyPoolTarget(target);

  if (read.state === "unconfigured") {
    return {
      status: "client-down",
      headline: "The client is not connected",
      detail:
        `No proxy client address is configured, so there is no pool to read. ` +
        `Set ${PROXY_HEALTH_URL_ENV} to the running client's control address. ` +
        `A click without a US exit fails rather than falling back to a direct connection.`,
    };
  }

  if (read.state === "unreachable") {
    return {
      status: "client-down",
      headline: "The client is down",
      detail:
        `${read.message} A click without a US exit fails rather than falling ` +
        `back to a direct connection.`,
    };
  }

  const health = read.health;
  const ready = health.pool.length;

  if (health.session.state !== "connected") {
    const why =
      health.lastError === null
        ? ""
        : ` It reports ${failureWords(health.lastError.reason)}.`;
    return {
      status: "client-down",
      headline: "The client is down",
      detail: `The relay session is ${
        health.session.state === "starting" ? "still starting" : "not running"
      }.${why}`,
    };
  }

  if (health.lastError?.reason === "quota-spent" || everyBucketSpent(health.buckets)) {
    const reset = nextReset(health.buckets);
    return {
      status: "out-of-quota",
      headline: "Out of quota",
      detail:
        `Every change bucket is spent, so no refill can start` +
        `${reset === null ? "" : ` until ${reset}`}. Ready exits keep serving; ` +
        `the pool cannot replace them.`,
    };
  }

  const failure =
    health.lastError === null
      ? ""
      : ` Last failure: ${failureWords(health.lastError.reason)}.`;

  if (ready === 0) {
    return {
      status: "short-of-exits",
      headline: "Short of exits",
      detail:
        `No US exit is ready.${failure} A click waits up to ten seconds, then ` +
        `fails rather than falling back.`,
    };
  }

  if (ready < wanted) {
    return {
      status: "short-of-exits",
      headline: `Short of exits: ${ready} of ${wanted} ready`,
      detail: `The pool fills to ${wanted}; a refill starts below three.${failure}`,
    };
  }

  return {
    status: "ok",
    headline: `${ready} of ${wanted} exits ready`,
    detail: describeCities(health.pool),
  };
}
