/**
 * One simulated affiliate click, from this server, with a believable identity.
 *
 * The same visit the `/email` panel's "Run one click now" button triggers, split
 * out of the server action so it can be tested without a database or a network:
 * a profile is drawn, one follow-redirects fetch is made with that profile's
 * headers, and the outcome is returned. Writing the row is the caller's job —
 * this module records nothing, so a test that runs it cannot leave evidence
 * behind.
 *
 * `target` is not validated here. The one invariant (an absolute http(s) URL)
 * lives in `assertClickTarget`, and every caller already holds it; duplicating
 * the check would make this module import the database client for no gain.
 */

import { pickBrowserProfile, refererForProvider } from "./user-agents";

export const CLICK_SIMULATOR_TIMEOUT_MS = 8_000;

/** What a Chromium-family browser sends when it follows a link in an email. */
export const CLICK_SIMULATOR_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

export const CLICK_SIMULATOR_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

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
  /** Injected for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
  /** Injected so a test can observe the request without a network. */
  fetcher?: typeof fetch;
  /** Injected clock, used only to measure `ms`. */
  now?: () => number;
};

/**
 * The headless request, shaped like the browser the profile claims to be.
 *
 * `redirect: "follow"` is the point of the exercise: the panel wants to know
 * where a visitor actually landed, and affiliate links are redirect chains. The
 * body is never read — it can be any page — so the response stream is cancelled
 * to release the connection without parsing a byte. No cookie jar and no
 * navigation state: a second click starts clean, which is what keeps one
 * poisoned response from changing the next click's identity.
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

  try {
    const response = await fetcher(input.target, {
      redirect: "follow",
      headers: {
        "user-agent": profile.userAgent,
        accept: CLICK_SIMULATOR_ACCEPT,
        "accept-language": CLICK_SIMULATOR_ACCEPT_LANGUAGE,
        // A null referer means "no Referer header at all", not an empty one.
        ...(referer === null ? {} : { referer }),
      },
      signal: AbortSignal.timeout(CLICK_SIMULATOR_TIMEOUT_MS),
      cache: "no-store",
    });
    status = response.status;
    finalUrl = response.url || null;
    try {
      await response.body?.cancel();
    } catch {
      // Best effort only; the click is reported either way.
    }
    ok = status >= 200 && status < 400;
    message = ok
      ? `Visited as ${profile.browser} on ${profile.platform}.`
      : `Target answered HTTP ${status} as ${profile.browser} on ${profile.platform}.`;
  } catch (error) {
    // The message stays free of the target: an arbitrary URL has no place in a
    // panel line, and the row already carries the target the caller drew.
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
