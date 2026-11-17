/**
 * The `/email` page password gate, separate from the control-panel secret.
 *
 * Two locks, two questions. The page password decides whether the page renders
 * at all; the control secret only decides whether the panel it renders is
 * read-only. They must not share a digest, or a control-secret cookie would
 * open the page gate (and vice versa), so the page digest is domain-separated
 * with the `voni:email-page:` prefix.
 *
 * No I/O here: the cookie is written by `src/app/email/actions.ts` and read by
 * the page, and both must use this module so the formats cannot drift.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** The cookie that carries `pagePasswordDigest(password)` in hex. */
export const PAGE_COOKIE = "voni_email_view";

/** Domain separation from the control-secret digest. */
const PAGE_DIGEST_PREFIX = "voni:email-page:";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The cookie value: `sha256("voni:email-page:" + password)` as hex. */
export function pagePasswordDigest(password: string): string {
  return digest(PAGE_DIGEST_PREFIX + password).toString("hex");
}

/**
 * Whether the gate cookie matches the configured page password.
 *
 * The cookie already carries `pagePasswordDigest(password)`, so the comparison
 * is that value against the digest of the configured password — the password
 * itself never has to travel. `timingSafeEqual` gets two fixed-length buffers
 * once the lengths are known to match, so a malformed or truncated cookie is a
 * plain `false` instead of a throw. A missing cookie or an unset password is
 * also `false`: there is nothing to compare against, and "locked" is the safe
 * answer either way.
 */
export function isPageUnlocked(
  cookieValue: string | undefined,
  expectedPassword: string | undefined,
): boolean {
  if (!cookieValue || !expectedPassword) return false;
  const provided = Buffer.from(cookieValue, "hex");
  const expected = Buffer.from(pagePasswordDigest(expectedPassword), "hex");
  // Equal-length inputs are the only ones `timingSafeEqual` accepts; a length
  // mismatch is not a secret, and a wrong-length cookie can never be a match.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** The gate cookie never leaves `/email`, and expires with the workday. */
export function pageGateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/email",
    maxAge: 60 * 60 * 12,
  };
}
