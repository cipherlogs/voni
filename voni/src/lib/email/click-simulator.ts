/**
 * One simulated affiliate click, from this server, with a believable identity.
 *
 * The same visit the `/email` panel's "Run one click now" button triggers, split
 * out of the server action so it can be tested without a database or a network:
 * a profile is drawn, one bounded redirect chain is followed with that profile's
 * headers, and the outcome is returned. Writing the row is the caller's job —
 * this module records nothing, so a test that runs it cannot leave evidence
 * behind.
 *
 * `target` is not validated by the caller, so the first thing this module does
 * is check it against the approved hosts. The one invariant (an absolute https
 * URL) lives in `assertClickTarget`; this module adds the scheme, port and host
 * policy because the click table stores where a visit landed, and a URL that
 * reached an internal address must never be written as one.
 *
 * ## Why the redirects are followed by hand
 *
 * The Cloudflare Worker this replaced could rely on the platform refusing
 * private, loopback and link-local destinations. The app runtime has no such
 * control: `redirect: "follow"` would let a target's 302 send this server to
 * `http://169.254.169.254/…` or an internal host, and the final URL would then
 * be recorded as the click's landing page. So each hop is resolved here and
 * accepted only when it stays on a host one of the approved targets names.
 */

import TARGETS_JSON from "./targets.json";
import { isPrivateIpLiteral, normaliseHostname } from "./target-url";
import { clientHintsFor, pickBrowserProfile, refererForProvider } from "./user-agents";

export const CLICK_SIMULATOR_TIMEOUT_MS = 8_000;

/**
 * How many `Location` hops one visit may follow. Browsers give up around 20;
 * ten is enough for an affiliate chain (tracker → network → page) and keeps one
 * pathological target from holding a server connection open.
 */
export const CLICK_SIMULATOR_MAX_HOPS = 10;

/** What a Chromium-family browser sends when it follows a link in an email. */
export const CLICK_SIMULATOR_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

export const CLICK_SIMULATOR_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

/** Said instead of a rejected URL: the chain is the fact, the address is not. */
export const CLICK_SIMULATOR_REJECTED_HOP =
  "The redirect chain left the approved hosts; the visit was stopped.";

/**
 * A 3xx that carries no `Location` sends a browser nowhere. It is a refusal,
 * not a visit: `status < 400` alone would otherwise record it as a success.
 */
export const CLICK_SIMULATOR_REDIRECT_WITHOUT_DESTINATION =
  "Redirected without a destination; the visit was stopped.";

/** The caller drew something `targets.json` does not name, so nothing was sent. */
export const CLICK_SIMULATOR_REJECTED_TARGET =
  "The target is not on the approved host list; nothing was fetched.";

export type SimulatedClick = {
  ok: boolean;
  status: number | null;
  finalUrl: string | null;
  ms: number;
  userAgent: string;
  device: string;
  browser: string;
  message: string;
};

export type SimulateOneClickInput = {
  target: string;
  source: string | null;
  /**
   * The URLs whose hosts a hop may land on. Production passes the panel's live
   * list (`src/lib/email/targets.ts`); the seed file is the default so a test
   * or a script needs no database. Every target on the list approves its own
   * host, so adding a target is what widens the allowlist — never a redirect.
   */
  targets?: readonly string[];
  /** Injected for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
  /** Injected so a test can observe the request without a network. */
  fetcher?: typeof fetch;
  /** Injected clock, used only to measure `ms`. */
  now?: () => number;
};

/**
 * The hosts a hop may land on, read from the same list the target bag comes
 * from. A second hardcoded list would be a second thing to edit, and the one
 * that gets forgotten is the one that is wrong.
 */
function approvedHosts(targets: readonly string[]): ReadonlySet<string> {
  return new Set(
    targets.map((target) => normaliseHostname(new URL(target).hostname)),
  );
}

/**
 * Accept a URL only when it is https on the default port, its host is one of
 * the approved targets, and that host is not a private IP literal. A relative
 * `Location` is resolved against the URL that sent it, which is what a browser
 * does.
 *
 * Every target is stored `https:` on 443 (the panel refuses anything else), so
 * plaintext and an extra port are surface with no caller and no reason to keep.
 */
function approvedUrl(
  value: string,
  hosts: ReadonlySet<string>,
  base?: string,
): URL | null {
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.port !== "" && url.port !== "443") return null;
  const hostname = normaliseHostname(url.hostname);
  if (!hosts.has(hostname)) return null;
  if (isPrivateIpLiteral(hostname)) return null;
  return url;
}

/**
 * The headless request, shaped like the browser the profile claims to be.
 *
 * Each request is sent with `redirect: "manual"`, so this module — not the
 * runtime — decides whether the next hop is allowed. The headers are identical
 * on every hop: a redirect must not let the visit acquire an identity the drawn
 * profile does not have. The body is never read — it can be any page — so the
 * response stream is cancelled to release the connection without parsing a
 * byte. No cookie jar and no navigation state: a second click starts clean,
 * which is what keeps one poisoned response from changing the next click's
 * identity.
 */
export async function simulateOneClick(
  input: SimulateOneClickInput,
): Promise<SimulatedClick> {
  const profile = pickBrowserProfile(input.random);
  const referer = refererForProvider(input.source);
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;

  const started = now();
  let status: number | null = null;
  let finalUrl: string | null = null;
  let ok = false;
  let message: string;

  const headers: Record<string, string> = {
    "user-agent": profile.userAgent,
    accept: CLICK_SIMULATOR_ACCEPT,
    "accept-language": CLICK_SIMULATOR_ACCEPT_LANGUAGE,
    ...clientHintsFor(profile),
    // A null referer means "no Referer header at all", not an empty one.
    ...(referer === null ? {} : { referer }),
  };

  const hosts = approvedHosts(input.targets ?? TARGETS_JSON);
  const start = approvedUrl(input.target, hosts);
  if (start === null) {
    // An unapproved target is never fetched. The caller draws from the bag, so
    // reaching this branch means a bug or a forged call, not a bad campaign.
    return {
      ok: false,
      status: null,
      finalUrl: null,
      ms: Math.max(0, now() - started),
      userAgent: profile.userAgent,
      device: profile.device,
      browser: profile.browser,
      message: CLICK_SIMULATOR_REJECTED_TARGET,
    };
  }

  let current = input.target;
  // One budget for the whole chain, so ten fast hops cannot add up to ten
  // timeouts and hold the request handler open.
  const signal = AbortSignal.timeout(CLICK_SIMULATOR_TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop += 1) {
      const response = await fetcher(current, {
        redirect: "manual",
        headers,
        signal,
        cache: "no-store",
      });
      status = response.status;
      const isRedirect = status >= 300 && status < 400 && status !== 304;
      const location = isRedirect ? response.headers.get("location") : null;

      try {
        await response.body?.cancel();
      } catch {
        // Best effort only; the click is reported either way.
      }

      // A 3xx with no `Location` names no destination, so nothing was visited.
      // `status < 400` on its own would record this as a success.
      if (isRedirect && location === null) {
        finalUrl = current;
        message = CLICK_SIMULATOR_REDIRECT_WITHOUT_DESTINATION;
        break;
      }

      if (!isRedirect) {
        finalUrl = current;
        ok = status >= 200 && status < 400;
        message = ok
          ? `Visited as ${profile.browser} on ${profile.platform}.`
          : `Target answered HTTP ${status} as ${profile.browser} on ${profile.platform}.`;
        break;
      }

      // The last accepted URL is the honest `finalUrl` for either refusal: it
      // is where the visit actually got before this module stopped it. The
      // rejected URL is deliberately not returned anywhere.
      if (hop >= CLICK_SIMULATOR_MAX_HOPS) {
        finalUrl = current;
        message = `The redirect chain exceeded ${CLICK_SIMULATOR_MAX_HOPS} hops; the visit was stopped.`;
        break;
      }

      const next = location === null ? null : approvedUrl(location, hosts, current);
      if (!next) {
        finalUrl = current;
        message = CLICK_SIMULATOR_REJECTED_HOP;
        break;
      }
      current = next.toString();
    }
  } catch (error) {
    // A transport failure leaves no landing page to record; `status` and
    // `finalUrl` go back to null so the row says "never answered" rather than
    // quoting an intermediate hop. The message stays free of the target: an
    // arbitrary URL has no place in a panel line.
    status = null;
    finalUrl = null;
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    message = timedOut
      ? `No answer within ${CLICK_SIMULATOR_TIMEOUT_MS / 1000} s.`
      : "The target did not answer.";
  }

  return {
    ok,
    status,
    finalUrl,
    ms: Math.max(0, now() - started),
    userAgent: profile.userAgent,
    device: profile.device,
    browser: profile.browser,
    message,
  };
}
