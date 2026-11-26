/**
 * The runner's half of the client's loopback control API.
 *
 * A Click asks this module for an exit, opens its browser context through the
 * returned SOCKS port, and gives the exit back with an outcome. Nothing here
 * speaks the Tuxler protocol and nothing here keeps a pool: the client owns the
 * session, the pool and the quota, and the runner only holds a URL.
 *
 * Two invariants are enforced here because they are the difference between a
 * failed Click and a leak:
 *
 *   - the control URL is loopback and carries no credential, so a mistyped
 *     address cannot send the runner's Clicks through a stranger's client;
 *   - an acquired lease must name a loopback SOCKS port, so a client bug cannot
 *     hand the browser a remote proxy or an HTTP one.
 *
 * A refusal is a value, never a throw: the Click must record the reason and
 * carry on with the next Target, not end the segment.
 */

import { POOL_ACQUIRE_WAIT_MS } from "../src/lib/tuxler/timing.ts";

/** The pool's bounded wait, from the one place the client declares it. */
export const EXIT_ACQUIRE_WAIT_MS = POOL_ACQUIRE_WAIT_MS;
/** The pool may take its full wait; this only bounds a wedged client. */
const ACQUIRE_TIMEOUT_MS = EXIT_ACQUIRE_WAIT_MS + 5_000;
const RELEASE_TIMEOUT_MS = 5_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * @typedef {object} Exit
 * @property {string} exitId
 * @property {string | null} server
 * @property {string} ip
 * @property {string} country
 * @property {string} asn
 * @property {string | null} city
 * @property {string | null} state
 * @property {string} socksUrl
 * @property {number} localPort
 */

/** @typedef {{ ok: true, exit: Exit } | { ok: false, reason: string, detail: string }} AcquireResult */

function firstLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].trim();
}

function readJson(response) {
  return response.json().catch(() => null);
}

/**
 * The runner's control address: `http://127.0.0.1:<port>`, from
 * `TUXLER_CONTROL_URL`. Any scheme but plain HTTP, any host but loopback, a
 * path, or an inline credential is refused before a Click is planned.
 *
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function parseControlUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "is empty" };
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "is not an absolute URL, e.g. http://127.0.0.1:41000" };
  }
  if (url.protocol !== "http:") {
    return { ok: false, reason: `must be http, not ${url.protocol.replace(":", "")}` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "must not carry a username or password" };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: `must be loopback, got ${url.hostname}` };
  }
  if (url.port === "") {
    return { ok: false, reason: "must name the control port" };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "must be the base address, not a path" };
  }
  return { ok: true, url: `http://${url.host}` };
}

/**
 * A lease as the runner may use it. The country is US by construction — a pool
 * that offered anything else is a client bug, and a Click never substitutes.
 * `socks5h` and `socks5` are the same tunnel; Playwright accepts `socks5`, so
 * the scheme is normalised rather than passed through untested.
 */
function parseLease(body) {
  if (typeof body !== "object" || body === null) return null;
  const { exitId, ip, country, asn, socksUrl } = body;
  if (typeof exitId !== "string" || exitId.trim() === "") return null;
  if (typeof ip !== "string" || ip.trim() === "") return null;
  if (country !== "US") return null;
  if (typeof asn !== "string" || !/^\d{1,10}$/.test(asn)) return null;
  if (typeof socksUrl !== "string") return null;

  let socks;
  try {
    socks = new URL(socksUrl);
  } catch {
    return null;
  }
  if (socks.protocol !== "socks5:" && socks.protocol !== "socks5h:") return null;
  if (!LOOPBACK_HOSTS.has(socks.hostname)) return null;
  if (socks.port === "") return null;

  return {
    exitId,
    server: typeof body.server === "string" ? body.server : null,
    ip,
    country,
    asn,
    city: typeof body.city === "string" ? body.city : null,
    state: typeof body.state === "string" ? body.state : null,
    socksUrl: `socks5://${socks.host}`,
    localPort: Number(socks.port),
  };
}

/**
 * Ask the pool for one exit. A 503 is the pool's own reason (`no-us-exit`,
 * `quota-spent`, `relay-silent`, `not-ready`); an unreachable control port is
 * `not-ready` too, because a client that cannot answer is not serving exits.
 *
 * @param {string} controlUrl
 * @param {{ waitMs?: number, fetcher?: typeof fetch }} [options]
 * @returns {Promise<AcquireResult>}
 */
export async function acquireExit(
  controlUrl,
  { waitMs = EXIT_ACQUIRE_WAIT_MS, fetcher = fetch } = {},
) {
  let response;
  try {
    response = await fetcher(`${controlUrl}/acquire?waitMs=${waitMs}`, {
      signal: AbortSignal.timeout(ACQUIRE_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return {
      ok: false,
      reason: "not-ready",
      detail: `the control port did not answer: ${firstLine(error)}`,
    };
  }

  const body = await readJson(response);
  if (response.status === 503) {
    const reason =
      typeof body?.reason === "string" && body.reason !== "" ? body.reason : "not-ready";
    return { ok: false, reason, detail: `the pool answered 503 ${reason}` };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "not-ready",
      detail: `the pool answered ${response.status}`,
    };
  }

  const exit = parseLease(body);
  if (exit === null) {
    return {
      ok: false,
      reason: "bad-exit",
      detail: "the control port returned an exit that is not a US loopback SOCKS lease",
    };
  }
  return { ok: true, exit };
}

/** Give the exit back. `ok: false` counts a strike and a second one kills it.
 *
 * @param {string} controlUrl
 * @param {string} exitId
 * @param {boolean} ok
 * @param {{ fetcher?: typeof fetch }} [options]
 * @returns {Promise<{ ok: true } | { ok: false, detail: string }>}
 */
export async function releaseExit(controlUrl, exitId, ok, { fetcher = fetch } = {}) {
  try {
    const response = await fetcher(`${controlUrl}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exitId, ok }),
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.status === 204) return { ok: true };
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      detail: `HTTP ${response.status}${text === "" ? "" : ` ${text.slice(0, 120)}`}`,
    };
  } catch (error) {
    return { ok: false, detail: firstLine(error) };
  }
}
