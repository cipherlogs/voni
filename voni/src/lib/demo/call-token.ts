import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { secret } from "@/lib/env";
import { WALL_CAP_S } from "./talk-clock";
import { TAG_TTL_S } from "./test-tag";

/**
 * The call-scoped credential for a public demo call's server routes (tools,
 * judge). `/api/demo/token` mints one alongside each cascade call token:
 * `<callId>.<expSeconds>.<startSeconds>.<nonce>[.<tagId>].<hmac>`. It names one
 * call and expires just after that call's wall cap (plus the socket-open
 * window), from the call's first start, so a token lifted from the network tab
 * (or a hold return's fresh one) cannot drive these routes beyond that one
 * call's lifetime.
 *
 * ponytail: expiry-only, not revoked on hang-up. The one side effect (Voni's
 * reply, reply.ts) goes out once per call, only to the email the call's tag
 * matched, so a lifted token can't send more. Add a server-side ended-call
 * mark if a tool with wider side effects lands.
 */
export const CALL_TOKEN_TTL_S = WALL_CAP_S + 60;

/** The label keeps each token kind's HMAC domain-separated under the one key. */
function mac(key: string, payload: string, label = "demo-call"): string {
  return createHmac("sha256", `${label}:${key}`).update(payload).digest("base64url");
}

/** The payload parts of `<part>.<part>….<hmac>` when the HMAC checks out, else null. */
function unseal(key: string, token: string, label: string): string[] | null {
  const parts = token.split(".");
  const sig = parts.pop();
  if (!sig || parts.length === 0) return null;
  const expected = Buffer.from(mac(key, parts.join("."), label));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected) ? parts : null;
}

export type DemoCall = { callId: string; startedAt: number; tagId: string | null };

/**
 * One call token: `<callId>.<expSeconds>.<startSeconds>.<nonce>[.<tagId>].<hmac>`.
 *
 * The start is signed rather than inferred from the expiry, so a hold return
 * can expire its token from the call's first start while remaining a different
 * token: the nonce keeps every signature fresh even when id, window and tag all
 * match a predecessor. `startedAt` defaults to `now`, a new call's start.
 */
function signCall(
  key: string,
  callId: string,
  now: number,
  tagId: string | null,
  startedAt = now,
): string {
  const startSeconds = Math.floor(startedAt / 1000);
  const payload = [
    callId,
    startSeconds + CALL_TOKEN_TTL_S,
    startSeconds,
    randomUUID(),
    ...(tagId ? [tagId] : []),
  ].join(".");
  return `${payload}.${mac(key, payload)}`;
}

/** `tagId` names the call's Test tag (test-tag.ts): a fresh call starts now. */
export function signDemoCall(key: string, now = Date.now(), tagId: string | null = null): string {
  return signCall(key, randomUUID(), now, tagId);
}

/**
 * A fresh token for a call id that already exists. A hold return continues the
 * same call (same row, same trace, same budgets) but never reuses the old
 * token: the previous one may already be short-dated or bound to a tag the
 * visitor no longer holds. Signed fresh, the call id and its first start are
 * the carried parts, so a return never narrows the call's inbox lookback
 * (`runCheckEmail` reads `call.startedAt`) nor extends its credential lifetime.
 */
export function signDemoCallFor(
  key: string,
  callId: string,
  now = Date.now(),
  tagId: string | null = null,
  startedAt?: number,
): string {
  return signCall(key, callId, now, tagId, startedAt);
}

/**
 * Read a token. Tokens signed before the start was carried
 * (`<callId>.<exp>[.<tagId>]`) still verify for their short life; their start
 * is the expiry's TTL offset, which is where it always came from.
 */
export function verifyDemoCall(key: string, token: string, now = Date.now()): DemoCall | null {
  const parts = unseal(key, token, "demo-call");
  if (!parts) return null;
  if (parts.length === 2 || parts.length === 3) {
    const [callId, exp, tagId] = parts;
    if (!callId || !exp || (parts.length === 3 && !tagId)) return null;
    const expSeconds = Number(exp);
    if (!Number.isFinite(expSeconds) || expSeconds * 1000 <= now) return null;
    return { callId, startedAt: (expSeconds - CALL_TOKEN_TTL_S) * 1000, tagId: tagId ?? null };
  }
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [callId, exp, start, nonce, tagId] = parts;
  if (!callId || !exp || !start || !nonce || (parts.length === 5 && !tagId)) return null;
  const expSeconds = Number(exp);
  const startSeconds = Number(start);
  if (!Number.isFinite(expSeconds) || !Number.isFinite(startSeconds)) return null;
  if (expSeconds * 1000 <= now) return null;
  return { callId, startedAt: startSeconds * 1000, tagId: tagId ?? null };
}

/** The browser's handle on its Test tag: `<tagId>.<issuedAtSeconds>.<hmac>`, valid for TAG_TTL_S. */
export function signTagToken(key: string, id: string, issuedAt = Date.now()): string {
  const payload = `${id}.${Math.floor(issuedAt / 1000)}`;
  return `${payload}.${mac(key, payload, "demo-tag")}`;
}

export function verifyTagToken(key: string, token: string, now = Date.now()): { id: string; issuedAt: number } | null {
  const parts = unseal(key, token, "demo-tag");
  if (!parts || parts.length !== 2 || !parts[0]) return null;
  const issuedAt = Number(parts[1]) * 1000;
  if (!Number.isFinite(issuedAt) || issuedAt + TAG_TTL_S * 1000 <= now) return null;
  return { id: parts[0], issuedAt };
}

/**
 * A non-resume re-mint (a reload continue) keeps the call's token while it is
 * valid and the tag is unchanged: same call id, start and budgets. A hold
 * return signs fresh instead (`signDemoCallFor`): same call id, new token.
 */
export function carryDemoCall(key: string, previous: unknown, now = Date.now(), tagId: string | null = null): string {
  const carried = typeof previous === "string" ? verifyDemoCall(key, previous, now) : null;
  return carried && carried.tagId === tagId ? (previous as string) : signDemoCall(key, now, tagId);
}

/** The signing key. Reuses the auth secret; the HMAC label keeps it domain-separated. */
export function demoCallKey(): Promise<string | undefined> {
  return secret("BETTER_AUTH_SECRET");
}

/** The demo call a request's `Authorization: Bearer <callToken>` names, or null. */
export async function demoCallFromRequest(req: Request): Promise<DemoCall | null> {
  const key = await demoCallKey();
  const header = req.headers.get("authorization") ?? "";
  if (!key || !header.startsWith("Bearer ")) return null;
  return verifyDemoCall(key, header.slice("Bearer ".length));
}
