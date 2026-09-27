import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { secret } from "@/lib/env";
import { WALL_CAP_S } from "./talk-clock";
import { TAG_TTL_S } from "./test-tag";

/**
 * The call-scoped credential for a public demo call's server routes (tools,
 * judge). `/api/demo/token` mints one alongside each AssemblyAI token:
 * `<callId>.<expSeconds>.<hmac>`. It names one call and expires just after
 * that call's wall cap (plus the socket-open window), so a token lifted from
 * the network tab cannot drive these routes beyond that one call's lifetime.
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

/** `tagId` names the call's Test tag (test-tag.ts): `<callId>.<exp>[.<tagId>].<hmac>`. */
export function signDemoCall(key: string, now = Date.now(), tagId: string | null = null): string {
  const payload = [randomUUID(), Math.floor(now / 1000) + CALL_TOKEN_TTL_S, ...(tagId ? [tagId] : [])].join(".");
  return `${payload}.${mac(key, payload)}`;
}

export function verifyDemoCall(key: string, token: string, now = Date.now()): DemoCall | null {
  const parts = unseal(key, token, "demo-call");
  if (!parts || parts.length > 3) return null;
  const [callId, exp, tagId] = parts;
  if (!callId || !exp || (parts.length === 3 && !tagId)) return null;
  if (Number(exp) * 1000 <= now) return null;
  return { callId, startedAt: (Number(exp) - CALL_TOKEN_TTL_S) * 1000, tagId: tagId ?? null };
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
 * A re-mint within the same call (hold rejoin, reload continue) keeps the
 * call's token while it is valid: same call id, start and budgets, so the
 * inbox check still sees email sent before the rejoin.
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
