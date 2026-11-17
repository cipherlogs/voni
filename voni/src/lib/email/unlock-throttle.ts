import { createHash } from "node:crypto";
import { bumpRateBucket } from "@/lib/demo/rate-limit";
import { secret } from "@/lib/env";

/**
 * The attempt budget both `/email` password forms spend before they compare
 * anything.
 *
 * Lives here rather than in the server action so the ordering — which bucket a
 * request spends first — can be driven from a test with a fake bucket store.
 * The policy is the part that must not drift: getting it wrong is how one
 * anonymous visitor locks the operator out of the only way in.
 *
 * Ten attempts per 15 minutes per IP, plus a ceiling on the whole deployment.
 * The per-IP ceiling stops one guesser; the global one stops a distributed
 * guess. Neither can tell a correct password from a wrong one because both are
 * spent before the comparison, and both answer with the same sentence a wrong
 * password gets, so being throttled is not evidence about the password.
 *
 * The 15-minute window is a fixed time slice rather than a rolling window: the
 * bucket key carries the slice, so an expired bucket is simply never read again
 * and no sweeper is needed. `retryAfterSeconds` therefore reports the whole
 * window — an upper bound on the real wait, never a way to shorten it.
 *
 * The budget is fail-closed: if the database cannot answer, the caller gets a
 * refusal it can *show* ("could not check attempts") rather than a rejected
 * action that resets the form with nothing on screen.
 */

export const UNLOCK_WINDOW_SECONDS = 15 * 60;

export const UNLOCK_MAX_PER_IP = 10;

/**
 * The ceiling one IP cannot reach on its own: 30 windows of that IP's whole
 * budget. Even a flood from a single address spends at most
 * `UNLOCK_MAX_PER_IP` of it (see the order in `spendUnlockAttempt`), so it can
 * never take the operator's own attempt away. It still stops a distributed
 * spray, which is all a ceiling can do.
 */
export const UNLOCK_MAX_GLOBAL = 300;

/** Shown when the limiter itself is unavailable. Says nothing about the secret. */
export const UNLOCK_UNAVAILABLE_MESSAGE =
  "Could not check attempts right now. Try again in a moment.";

export type UnlockScope = "page" | "control";

export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; reason: "throttled"; retryAfterSeconds: number }
  | { allowed: false; reason: "unavailable"; error: string };

type BumpBucket = (
  bucket: string,
  limit: number,
  windowSeconds: number,
) => Promise<{ ok: boolean; count: number }>;

export type SpendUnlockAttemptInput = {
  scope: UnlockScope;
  /** The caller's IP, or `"unknown"` when no proxy header named one. */
  ip: string;
  /** Injected clock, in ms; the bucket key carries the 15-minute slice. */
  now?: number;
  /** Injected store, so a test can count buckets without a database. */
  bump?: BumpBucket;
};

/**
 * The IP as a bucket key, hashed first for the same reason
 * `@/lib/demo/rate-limit` hashes its own: a table of attempt counts is not a log
 * of who visited. The deployment secret means the hashes are not reversible by
 * rainbow table — a bare hash of an IPv4 address is trivial to enumerate — and
 * the bucket prefix keeps these keys out of the demo's namespace.
 *
 * `secret()` rather than `process.env` because this deployment keeps secrets in
 * the Cloudflare binding, where `process.env` may be empty. The fallback is a
 * public literal, so it only keeps local dev and the unit tests working: if
 * `BETTER_AUTH_SECRET` is unset in production the fallback *is* what runs, and
 * the IPv4 keys become enumerable. Nothing else depends on it being secret, but
 * that is the reason the variable belongs in the Worker's secrets either way.
 */
async function ipBucketKey(ip: string): Promise<string> {
  const salt = (await secret("BETTER_AUTH_SECRET")) ?? "voni-email-unlock";
  return createHash("sha256")
    .update(`${salt}:email-unlock:${ip}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function globalBucket(scope: UnlockScope, window: number): string {
  return `email-unlock:${scope}:global:${window}`;
}

function perIpBucket(scope: UnlockScope, key: string, window: number): string {
  return `email-unlock:${scope}:ip:${key}:${window}`;
}

/**
 * Spend one attempt against the budget and report whether it was allowed.
 *
 * Order matters, and this is the whole point of the module:
 *
 *   1. the per-IP bucket is bumped first and decides on its own whether this
 *      request may spend global budget;
 *   2. the global bucket is bumped only after the per-IP check allowed it.
 *
 * So a flood from one address burns *that address's* ten attempts and touches
 * the global ceiling at most ten times — it can never exhaust it, and it can
 * never take the operator's correct password away from a different address.
 * The accepted cost is the mirror image: while the global ceiling is spent,
 * arriving attempts still spend their own IP's budget for an attempt that is
 * refused. Every arrived request is an attempt, so that is the honest count.
 */
export async function spendUnlockAttempt(
  input: SpendUnlockAttemptInput,
): Promise<ThrottleVerdict> {
  const bump = input.bump ?? bumpRateBucket;
  const retryAfterSeconds = UNLOCK_WINDOW_SECONDS;
  const window = Math.floor(
    (input.now ?? Date.now()) / (UNLOCK_WINDOW_SECONDS * 1000),
  );

  try {
    if (input.ip === "unknown") {
      // No proxy header named a client, so a "per-IP" key would be one constant
      // shared by every caller — a second global bucket wearing a per-IP label.
      // Spend the global one and only the global one, rather than invent a
      // per-IP ceiling that does not exist.
      const global = await bump(
        globalBucket(input.scope, window),
        UNLOCK_MAX_GLOBAL,
        UNLOCK_WINDOW_SECONDS,
      );
      return global.ok
        ? { allowed: true }
        : { allowed: false, reason: "throttled", retryAfterSeconds };
    }

    const key = await ipBucketKey(input.ip);
    const perIp = await bump(
      perIpBucket(input.scope, key, window),
      UNLOCK_MAX_PER_IP,
      UNLOCK_WINDOW_SECONDS,
    );
    if (!perIp.ok) {
      return { allowed: false, reason: "throttled", retryAfterSeconds };
    }

    const global = await bump(
      globalBucket(input.scope, window),
      UNLOCK_MAX_GLOBAL,
      UNLOCK_WINDOW_SECONDS,
    );
    if (!global.ok) {
      return { allowed: false, reason: "throttled", retryAfterSeconds };
    }

    return { allowed: true };
  } catch {
    // Fail closed, but visibly: the form can render this, which a rejected
    // action could not. A database outage must not read as a wrong password and
    // must not read as nothing at all. The trace is one fixed line — the
    // attempt's identity is not worth leaking into logs to explain an outage.
    console.error("email unlock: attempt ledger unavailable");
    return {
      allowed: false,
      reason: "unavailable",
      error: UNLOCK_UNAVAILABLE_MESSAGE,
    };
  }
}
