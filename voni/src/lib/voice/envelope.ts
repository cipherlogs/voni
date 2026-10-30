import { createHash, createHmac } from "node:crypto";
import { stableJson, type StoredAgentBody } from "@/lib/agents/body";
import { agentBodyFingerprint } from "@/lib/agents/fingerprint";

/**
 * The app's signed call-body envelope (ticket 64; version 2 in ticket 01).
 *
 * The browser never sees the body, the prompt or the tool list. The app
 * assembles the stored body, checks it against the fingerprint it minted, and
 * signs the claims the cascade service verifies before any vendor socket
 * opens:
 *
 *     {"envelope": {version, [kind,] call_id, agent_id, body_hash,
 *                   issued_at_ms, expires_at_ms, signature},
 *      "body": {…}}
 *
 * The signing input is `stableJson(claims)`, so the app and
 * `voice-pipeline/cascade/envelope.py` agree byte-for-byte regardless of
 * object order on the wire. Version 1 is the committed envelope: its claims
 * name no subject kind, and the service reads it as `tenant`. Version 2 adds
 * the explicit `kind` claim (`demo` or `tenant`), and the HMAC covers it — the
 * routing decision never infers a kind from an id or a name.
 *
 * `voice-pipeline/cascade/envelope_vectors.json` pins both versions: the v1
 * fields and the `v2_demo` subsection. Both suites read the same bytes, so the
 * signers cannot drift without a test failing.
 *
 * This is a server-only module: it reads the HMAC secret, so the secret never
 * reaches the browser and no client component may import it.
 */

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_VERSION_SUBJECT_KIND = 2;

export const SUBJECT_KINDS = ["demo", "tenant"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export type EnvelopeClaimsV1 = {
  version: 1;
  call_id: string;
  agent_id: string;
  body_hash: string;
  issued_at_ms: number;
  expires_at_ms: number;
};

export type EnvelopeClaimsV2 = {
  version: 2;
  kind: SubjectKind;
  call_id: string;
  agent_id: string;
  body_hash: string;
  issued_at_ms: number;
  expires_at_ms: number;
};

export type EnvelopeClaims = EnvelopeClaimsV1 | EnvelopeClaimsV2;

export type SignedEnvelope = EnvelopeClaims & { signature: string };

export type SignedBody = {
  envelope: SignedEnvelope;
  body: Record<string, unknown>;
};

/**
 * A signed body envelope cannot be trusted, so the call is refused. Every
 * refusal is a named class so a caller can act on it, and no message ever
 * contains the HMAC secret.
 */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EnvelopeSecretError extends EnvelopeError {
  constructor(reason: string) {
    super(`the envelope secret ${reason}; no default secret is substituted`);
  }
}

export class EnvelopeIdentityError extends EnvelopeError {
  readonly field: string;

  constructor(field: string) {
    super(`envelope field "${field}" must be a non-empty string`);
    this.field = field;
  }
}

export class MalformedEnvelope extends EnvelopeError {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`envelope field "${field}": ${reason}`);
    this.field = field;
    this.reason = reason;
  }
}

/** A subject kind this signer does not understand. Guessing is forbidden. */
export class UnknownSubjectKind extends EnvelopeError {
  readonly kind: unknown;

  constructor(kind: unknown) {
    super(
      `envelope field "kind" must be "demo" or "tenant", got ${describeValue(kind)}`,
    );
    this.kind = kind;
  }
}

/** The body is not the body the app fingerprinted, so it cannot be signed. */
export class BodyFingerprintMismatch extends EnvelopeError {
  readonly minted: string;
  readonly served: string;

  constructor(callId: string, minted: string, served: string) {
    super(
      `the body served for call "${callId}" fingerprints to "${served}", which ` +
        `does not match the minted fingerprint "${minted}"; the body is refused ` +
        "before the envelope is signed",
    );
    this.minted = minted;
    this.served = served;
  }
}

/** Describe a refused value without echoing a secret or invoking a toString. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return typeof value;
}

type SignEnvelopeBase = {
  body: Record<string, unknown>;
  /** The fingerprint the app minted for the body it read back. */
  mintedFingerprint: string;
  /** The account the stored agent lives under; never an envelope claim. */
  accountSalt: string;
  secret: string;
  callId: string;
  agentId: string;
  ttlMs: number;
  /** Injectable clock in epoch milliseconds; `Date.now()` otherwise. */
  now?: number;
};

export type SignEnvelopeInput =
  | (SignEnvelopeBase & { version: 1; kind?: never })
  | (SignEnvelopeBase & { version: 2; kind: SubjectKind });

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EnvelopeIdentityError(field);
  }
  return value;
}

function requireSecret(secret: unknown): string {
  if (typeof secret !== "string") {
    throw new EnvelopeSecretError(`must be a string, got ${typeof secret}`);
  }
  if (secret.length === 0) {
    throw new EnvelopeSecretError("is empty");
  }
  return secret;
}

/** SHA-256 of the canonical body — the hash the envelope carries. */
export function envelopeBodyHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(body), "utf8").digest("hex");
}

function signClaims(claims: EnvelopeClaims, secret: string): string {
  return createHmac("sha256", secret)
    .update(stableJson(claims), "utf8")
    .digest("hex");
}

/** Seal the served body for the service channel (the app's side). */
export function signEnvelope(input: SignEnvelopeInput): SignedBody {
  const secret = requireSecret(input.secret);

  const version = input.version;
  if (version !== 1 && version !== 2) {
    throw new MalformedEnvelope(
      "version",
      `unknown envelope version ${describeValue(version)}; this signer signs 1 and 2`,
    );
  }

  // Version 1 carries no kind; version 2 must name one, and it is signed.
  let kind: SubjectKind | undefined;
  if (version === 1) {
    if (input.kind !== undefined) {
      throw new MalformedEnvelope(
        "kind",
        "is a version 2 claim; a version 1 envelope carries no subject kind",
      );
    }
  } else {
    if (input.kind !== "demo" && input.kind !== "tenant") {
      throw new UnknownSubjectKind(input.kind);
    }
    kind = input.kind;
  }

  const body = input.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new MalformedEnvelope("body", "must be an object");
  }

  const callId = requireText(input.callId, "call_id");
  const agentId = requireText(input.agentId, "agent_id");

  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new MalformedEnvelope(
      "expires_at_ms",
      `ttlMs must be a positive whole number, got ${describeValue(input.ttlMs)}`,
    );
  }
  const issuedAt = input.now ?? Date.now();
  if (!Number.isInteger(issuedAt) || issuedAt < 0) {
    throw new MalformedEnvelope(
      "issued_at_ms",
      `must be epoch milliseconds, got ${describeValue(issuedAt)}`,
    );
  }

  // The app's check runs before signing: never sign a body nobody
  // fingerprinted, or the service would accept a body the app never read back.
  const servedFingerprint = agentBodyFingerprint(
    body as unknown as StoredAgentBody,
    input.accountSalt,
  );
  if (servedFingerprint !== input.mintedFingerprint) {
    throw new BodyFingerprintMismatch(callId, input.mintedFingerprint, servedFingerprint);
  }

  const bodyHash = envelopeBodyHash(body);
  const claims: EnvelopeClaims =
    version === 2
      ? {
          version: 2,
          kind: kind as SubjectKind,
          call_id: callId,
          agent_id: agentId,
          body_hash: bodyHash,
          issued_at_ms: issuedAt,
          expires_at_ms: issuedAt + input.ttlMs,
        }
      : {
          version: 1,
          call_id: callId,
          agent_id: agentId,
          body_hash: bodyHash,
          issued_at_ms: issuedAt,
          expires_at_ms: issuedAt + input.ttlMs,
        };

  return {
    envelope: { ...claims, signature: signClaims(claims, secret) },
    body: { ...body },
  };
}
