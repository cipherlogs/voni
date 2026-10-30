import { signCallToken } from "@/lib/voice/cascade-token";
import BOUNDS from "@/lib/voice/cascade-bounds.json";
import {
  EnvelopeSecretError,
  signEnvelope,
  type EnvelopeClaimsV2,
} from "@/lib/voice/envelope";
import { buildDemoAgentBody, demoAgentFingerprint } from "@/lib/demo/stored-agents";
import { DEMO_VOICE_IDS } from "@/lib/demo/voni-agent";
import type { StoredAgentBody } from "@/lib/agents/body";
import { secret } from "@/lib/env";

/**
 * THE DEMO CALL BODY (demo-cascade ticket 06).
 *
 * The demo is the cascade's only client: there is no managed fallback, so the
 * body the pipeline runs is assembled here, in the app, from the one stored-body
 * builder with the demo profile. Nothing in this module reaches a vendor, opens
 * a socket or writes a row — the mint route (ticket 09) asks for a signed body
 * and the delivery client (ticket 07) is what posts it.
 *
 * This module is server-only: it reads the envelope secret, so a client
 * component that imported it would fail the build rather than ship the secret.
 */

/**
 * Not a secret and never sent on the wire. The vendor (account) concept is
 * gone; the fingerprint only binds the demo body, and a stable constant keeps
 * that binding reproducible across deploys.
 */
export const DEMO_ACCOUNT_SALT = "demo-cascade-body-account";

export type DemoCascadeBodyInput = {
  /** One of `DEMO_VOICE_IDS`; the voice picks the Locale. */
  voice: string;
  /** The demo call's existing id; one call, one trace, one row. */
  callId: string;
  /** A hold return: the builder omits the greeting waiting for carried context. */
  resume?: boolean;
  /**
   * Reserved for the hold return's bounded recent-turn history (ticket 13).
   * This module does not invent history; until ticket 13 defines its shape,
   * passing any is refused by name.
   */
  history?: readonly string[];
};

export type DemoCascadeCall = {
  /** `demo:<voice>`: the routing subject, the browser identity and the trace subject. */
  agentId: string;
  voice: string;
  callId: string;
  /** The body built by the one builder (never forked, never amended here). */
  body: StoredAgentBody;
  /** The signed v2 `kind: "demo"` envelope plus the body it covers. */
  signedBody: {
    envelope: EnvelopeClaimsV2 & { signature: string };
    body: Record<string, unknown>;
  };
  /** SHA-256 of the canonical body; the envelope's `body_hash`. */
  bodyHash: string;
  /** The body's demo-account fingerprint, computed before signing. */
  fingerprint: string;
  /** `ct1.…`, bound to `callId` and to `agentId`. */
  callToken: string;
  envelopeTtlMs: number;
  callTokenTtlMs: number;
};

/**
 * The module's named refusal: an unknown voice, a malformed call id or an
 * unwired resume never reaches signing with a guessed value. The envelope
 * signer's own named errors (secret, fingerprint, claims) pass through.
 */
export class DemoCascadeBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnknownDemoVoice extends DemoCascadeBodyError {
  readonly voice: unknown;

  constructor(voice: unknown) {
    super(
      `unknown demo voice ${JSON.stringify(voice)}; the demo offers ` +
        `${DEMO_VOICE_IDS.join(", ")}`,
    );
    this.voice = voice;
  }
}

export type DemoCascadeBodyDeps = {
  /** Injectable clock in epoch milliseconds; `Date.now()` otherwise. */
  now?: number;
};

/**
 * The two signing windows come from one data record, never a literal. A
 * malformed record is a named refusal, not a silent default.
 */
function signingWindows(): { envelopeTtlMs: number; callTokenTtlMs: number } {
  const { envelopeTtlMs, callTokenTtlMs } = BOUNDS;
  for (const [field, value] of [
    ["envelopeTtlMs", envelopeTtlMs],
    ["callTokenTtlMs", callTokenTtlMs],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new DemoCascadeBodyError(
        `cascade bounds field "${field}" must be a positive whole number, got ${value}`,
      );
    }
  }
  return { envelopeTtlMs, callTokenTtlMs };
}

function requireKnownVoice(voice: unknown): string {
  if (typeof voice !== "string" || !(DEMO_VOICE_IDS as readonly string[]).includes(voice)) {
    throw new UnknownDemoVoice(voice);
  }
  return voice;
}

function requireCallId(callId: unknown): string {
  if (typeof callId !== "string" || callId.trim() === "") {
    throw new DemoCascadeBodyError('demo call field "callId" must be a non-empty string');
  }
  return callId;
}

/** Build the demo stored body, name the subject `demo:<voice>`, sign it and mint the token. */
export async function buildDemoCascadeBody(
  input: DemoCascadeBodyInput,
  deps: DemoCascadeBodyDeps = {},
): Promise<DemoCascadeCall> {
  const voice = requireKnownVoice(input.voice);
  const callId = requireCallId(input.callId);
  const resume = input.resume === true;
  if (input.history !== undefined) {
    throw new DemoCascadeBodyError(
      'demo call field "history" is reserved for the hold return (ticket 13); ' +
        "this module never invents resumed history",
    );
  }

  const envelopeSecret = await secret("VOICE_PIPELINE_ENVELOPE_SECRET");
  if (envelopeSecret === undefined || envelopeSecret === "") {
    throw new EnvelopeSecretError('"VOICE_PIPELINE_ENVELOPE_SECRET" is not set');
  }

  const { envelopeTtlMs, callTokenTtlMs } = signingWindows();
  const body = buildDemoAgentBody(voice, { resume });
  const agentId = `demo:${voice}`;
  const fingerprint = demoAgentFingerprint(body, DEMO_ACCOUNT_SALT);

  // Sign only the body this module just built and fingerprinted; the signer
  // re-checks it and refuses on any mismatch.
  const signedBody = signEnvelope({
    version: 2,
    kind: "demo",
    body: body as unknown as Record<string, unknown>,
    mintedFingerprint: fingerprint,
    accountSalt: DEMO_ACCOUNT_SALT,
    secret: envelopeSecret,
    callId,
    agentId,
    ttlMs: envelopeTtlMs,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  }) as DemoCascadeCall["signedBody"];

  const callToken = signCallToken({
    secret: envelopeSecret,
    callId,
    subject: signedBody.envelope.agent_id,
    ttlMs: callTokenTtlMs,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  return {
    agentId,
    voice,
    callId,
    body,
    signedBody,
    bodyHash: signedBody.envelope.body_hash,
    fingerprint,
    callToken,
    envelopeTtlMs,
    callTokenTtlMs,
  };
}
