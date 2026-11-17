/**
 * The `/email` control-panel cookie, verified the same way by the page that
 * renders the lock state and the server actions that enforce it.
 *
 * The cookie never carries the secret itself: it carries `sha256(secret)` in
 * hex. Both sides hash their inputs again before comparing, so the buffers
 * `timingSafeEqual` sees are always 32 bytes — a wrong-length or non-hex cookie
 * cannot make the comparison throw, and no length tells an attacker anything.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const EMAIL_CONTROL_COOKIE = "voni_email_control";

/**
 * The writer is `src/app/email/actions.ts`. Both sides must hash the same way:
 * a change to the cookie format here without the matching change there shows
 * the panel unlocked while every action refuses.
 */

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time equality over fixed-length SHA-256 digests. */
export function safeSecretEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** The value stored in the cookie: `sha256(secret)` as hex. */
export function controlCookieValue(expected: string): string {
  return digest(expected).toString("hex");
}

/**
 * Whether a cookie value matches the configured secret. A missing cookie or a
 * missing `EMAIL_CONTROL_SECRET` is a plain `false` — there is nothing to
 * compare against, and "locked" is the safe answer either way.
 */
export function controlCookieMatches(
  cookieValue: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !cookieValue) return false;
  return safeSecretEqual(cookieValue, controlCookieValue(expected));
}
