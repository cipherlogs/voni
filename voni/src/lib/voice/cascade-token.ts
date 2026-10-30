import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { stableJson } from "@/lib/agents/body";

/**
 * The app's short-TTL cascade call token (ticket 136).
 *
 * `ct1.<base64url(canonical claims)>.<hmac-sha256 hex>` binds one call to one
 * subject and an expiry. It reuses the signed body envelope's one signature
 * construction (canonical JSON + HMAC-SHA256 under the envelope secret, ticket
 * 64); the `kind` claim keeps a call token from ever verifying as an envelope.
 *
 * The Python service verifies the same bytes at connect
 * (`voice-pipeline/cascade/token.py`), and
 * `voice-pipeline/cascade/call_token_vectors.json` pins a vector both signers
 * must reproduce. `ttlMs` is required: the short-lived window comes from the
 * service's recorded bound (`envelope.ttl_ms`), never a literal in the app.
 *
 * This is a server-side module: the secret never reaches the browser.
 */

export const CALL_TOKEN_PREFIX = "ct1";
export const CALL_TOKEN_VERSION = 1;
export const CALL_TOKEN_KIND = "call-token";

export type CallTokenClaims = {
  kind: string;
  version: number;
  call_id: string;
  subject: string;
  issued_at_ms: number;
  expires_at_ms: number;
  nonce: string;
};

export type MintCallToken = {
  secret: string;
  callId: string;
  subject: string;
  ttlMs: number;
  /** Injectable for the pinned vector; a UUID otherwise. */
  nonce?: string;
  /** Injectable clock in epoch milliseconds; `Date.now()` otherwise. */
  now?: number;
};

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`call token field "${field}" must be a non-empty string`);
  }
  return value;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Mint the token the service verifies at connect. */
export function signCallToken(input: MintCallToken): string {
  const secret = requireText(input.secret, "secret");
  const callId = requireText(input.callId, "call_id");
  const subject = requireText(input.subject, "subject");
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error(`call token field "expires_at_ms" must be a positive whole number, got ${input.ttlMs}`);
  }
  const issuedAt = input.now ?? Date.now();
  if (!Number.isInteger(issuedAt) || issuedAt < 0) {
    throw new Error(`call token field "issued_at_ms" must be epoch milliseconds, got ${issuedAt}`);
  }
  const claims: CallTokenClaims = {
    kind: CALL_TOKEN_KIND,
    version: CALL_TOKEN_VERSION,
    call_id: callId,
    subject,
    issued_at_ms: issuedAt,
    expires_at_ms: issuedAt + input.ttlMs,
    nonce: input.nonce ?? randomUUID(),
  };
  const canonical = stableJson(claims);
  const payload = Buffer.from(canonical, "utf8").toString("base64url");
  return `${CALL_TOKEN_PREFIX}.${payload}.${sign(canonical, secret)}`;
}

/**
 * Verify a token the app minted. Returns null for any refusal: the browser
 * never sees a call token's contents, and a caller only needs the claims when
 * the token is valid.
 */
export function verifyCallToken(
  token: unknown,
  options: { secret: string; callId?: string; subject?: string; now?: number },
): CallTokenClaims | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CALL_TOKEN_PREFIX) return null;
  const [, payload, signature] = parts;
  let canonical: string;
  try {
    canonical = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = sign(canonical, options.secret);
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  let claims: CallTokenClaims;
  try {
    claims = JSON.parse(canonical) as CallTokenClaims;
  } catch {
    return null;
  }
  if (
    claims?.kind !== CALL_TOKEN_KIND ||
    claims.version !== CALL_TOKEN_VERSION ||
    typeof claims.call_id !== "string" ||
    typeof claims.subject !== "string" ||
    typeof claims.nonce !== "string" ||
    !Number.isInteger(claims.issued_at_ms) ||
    !Number.isInteger(claims.expires_at_ms)
  ) {
    return null;
  }
  const now = options.now ?? Date.now();
  if (now >= claims.expires_at_ms) return null;
  if (options.callId !== undefined && claims.call_id !== options.callId) return null;
  if (options.subject !== undefined && claims.subject !== options.subject) return null;
  return claims;
}
