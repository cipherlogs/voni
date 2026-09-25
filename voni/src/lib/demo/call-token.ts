import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { secret } from "@/lib/env";
import { WALL_CAP_S } from "./talk-clock";

/**
 * The call-scoped credential for a public demo call's server routes (tools,
 * judge). `/api/demo/token` mints one alongside each AssemblyAI token:
 * `<callId>.<expSeconds>.<hmac>`. It names one call and expires just after
 * that call's wall cap (plus the socket-open window), so a token lifted from
 * the network tab cannot drive these routes beyond that one call's lifetime.
 *
 * ponytail: expiry-only, not revoked on hang-up. Add a server-side ended-call
 * mark when a tool with side effects (sending email) lands.
 */
export const CALL_TOKEN_TTL_S = WALL_CAP_S + 60;

function mac(key: string, payload: string): string {
  return createHmac("sha256", `demo-call:${key}`).update(payload).digest("base64url");
}

export function signDemoCall(key: string, now = Date.now()): string {
  const payload = `${randomUUID()}.${Math.floor(now / 1000) + CALL_TOKEN_TTL_S}`;
  return `${payload}.${mac(key, payload)}`;
}

export function verifyDemoCall(
  key: string,
  token: string,
  now = Date.now(),
): { callId: string } | null {
  const [callId, exp, sig, ...rest] = token.split(".");
  if (!callId || !exp || !sig || rest.length > 0) return null;
  const expected = Buffer.from(mac(key, `${callId}.${exp}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Number(exp) * 1000 <= now) return null;
  return { callId };
}

/** The signing key. Reuses the auth secret; the HMAC label keeps it domain-separated. */
export function demoCallKey(): Promise<string | undefined> {
  return secret("BETTER_AUTH_SECRET");
}

/** The demo call a request's `Authorization: Bearer <callToken>` names, or null. */
export async function demoCallFromRequest(req: Request): Promise<{ callId: string } | null> {
  const key = await demoCallKey();
  const header = req.headers.get("authorization") ?? "";
  if (!key || !header.startsWith("Bearer ")) return null;
  return verifyDemoCall(key, header.slice("Bearer ".length));
}
