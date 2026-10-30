import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBodyFingerprint } from "@/lib/agents/fingerprint";
import { stableJson, type StoredAgentBody } from "@/lib/agents/body";
import {
  BodyFingerprintMismatch,
  EnvelopeSecretError,
  MalformedEnvelope,
  UnknownSubjectKind,
  signEnvelope,
} from "./envelope";

type Vector = {
  version: number;
  secret: string;
  account_salt: string;
  call_id: string;
  agent_id: string;
  issued_at_ms: number;
  expires_at_ms: number;
  body: Record<string, unknown>;
  body_hash: string;
  minted_fingerprint: string;
  signature: string;
};

const here = dirname(fileURLToPath(import.meta.url));
const VECTOR = JSON.parse(
  readFileSync(join(here, "../../../../voice-pipeline/cascade/envelope_vectors.json"), "utf8"),
) as Vector & { v2_demo: Vector & { kind: "demo" } };

const V2 = VECTOR.v2_demo;

test("the app signs the committed v1 envelope the Python service verifies", () => {
  // The vector was produced by Node's crypto and cross-checked with openssl
  // (ticket 64), so the two signers cannot drift.
  const signed = signEnvelope({
    version: 1,
    secret: VECTOR.secret,
    accountSalt: VECTOR.account_salt,
    callId: VECTOR.call_id,
    agentId: VECTOR.agent_id,
    body: VECTOR.body,
    mintedFingerprint: VECTOR.minted_fingerprint,
    ttlMs: VECTOR.expires_at_ms - VECTOR.issued_at_ms,
    now: VECTOR.issued_at_ms,
  });

  assert.equal(signed.envelope.body_hash, VECTOR.body_hash);
  assert.equal(signed.envelope.signature, VECTOR.signature);
  assert.deepEqual(signed.envelope, {
    version: 1,
    call_id: VECTOR.call_id,
    agent_id: VECTOR.agent_id,
    body_hash: VECTOR.body_hash,
    issued_at_ms: VECTOR.issued_at_ms,
    expires_at_ms: VECTOR.expires_at_ms,
    signature: VECTOR.signature,
  });
  assert.deepEqual(signed.body, VECTOR.body);
});

test("the app signs the committed v2 demo envelope the Python service will verify", () => {
  // The v2_demo subsection pins test-only values: a demo body, its hashes and
  // the signature over claims that include `kind`. Python reads the same
  // subsection (ticket 02), so a claim drift fails both suites.
  const signed = signEnvelope({
    version: 2,
    kind: V2.kind,
    secret: V2.secret,
    accountSalt: V2.account_salt,
    callId: V2.call_id,
    agentId: V2.agent_id,
    body: V2.body,
    mintedFingerprint: V2.minted_fingerprint,
    ttlMs: V2.expires_at_ms - V2.issued_at_ms,
    now: V2.issued_at_ms,
  });

  assert.equal(signed.envelope.body_hash, V2.body_hash);
  assert.equal(signed.envelope.signature, V2.signature);
  assert.deepEqual(signed.envelope, {
    version: 2,
    kind: "demo",
    call_id: V2.call_id,
    agent_id: V2.agent_id,
    body_hash: V2.body_hash,
    issued_at_ms: V2.issued_at_ms,
    expires_at_ms: V2.expires_at_ms,
    signature: V2.signature,
  });
  assert.deepEqual(signed.body, V2.body);
});

test("changing the kind, call, agent, body or expiry changes the signature", () => {
  const base = {
    version: 2 as const,
    kind: "demo" as const,
    secret: V2.secret,
    accountSalt: V2.account_salt,
    callId: V2.call_id,
    agentId: V2.agent_id,
    body: V2.body,
    mintedFingerprint: V2.minted_fingerprint,
    ttlMs: V2.expires_at_ms - V2.issued_at_ms,
    now: V2.issued_at_ms,
  };
  const reference = signEnvelope(base).envelope.signature;

  assert.notEqual(signEnvelope({ ...base, kind: "tenant" }).envelope.signature, reference);
  assert.notEqual(signEnvelope({ ...base, callId: "call_other" }).envelope.signature, reference);
  assert.notEqual(signEnvelope({ ...base, agentId: "agent_other" }).envelope.signature, reference);
  assert.notEqual(signEnvelope({ ...base, ttlMs: base.ttlMs + 1 }).envelope.signature, reference);

  const otherBody = { ...V2.body, greeting: "Hi, this is another Voni." };
  const other = signEnvelope({
    ...base,
    body: otherBody,
    mintedFingerprint: agentBodyFingerprint(
      otherBody as unknown as StoredAgentBody,
      V2.account_salt,
    ),
  });
  assert.notEqual(other.envelope.body_hash, V2.body_hash);
  assert.notEqual(other.envelope.signature, reference);
});

test("the v2 signing input is order-independent canonical JSON", () => {
  const signed = signEnvelope({
    version: 2,
    kind: "demo",
    secret: V2.secret,
    accountSalt: V2.account_salt,
    callId: V2.call_id,
    agentId: V2.agent_id,
    body: V2.body,
    mintedFingerprint: V2.minted_fingerprint,
    ttlMs: V2.expires_at_ms - V2.issued_at_ms,
    now: V2.issued_at_ms,
  });
  const { signature, ...claims } = signed.envelope;
  const reordered = Object.fromEntries(Object.entries(claims).reverse());
  const expected = createHmac("sha256", V2.secret)
    .update(stableJson(reordered), "utf8")
    .digest("hex");
  assert.equal(signature, expected);
});

function v2Input() {
  return {
    version: 2 as const,
    kind: "demo" as const,
    secret: V2.secret,
    accountSalt: V2.account_salt,
    callId: V2.call_id,
    agentId: V2.agent_id,
    body: V2.body,
    mintedFingerprint: V2.minted_fingerprint,
    ttlMs: V2.expires_at_ms - V2.issued_at_ms,
    now: V2.issued_at_ms,
  };
}

function refuses(error: unknown, name: string): true {
  assert.equal((error as Error).name, name);
  assert.equal((error as Error).message.includes(V2.secret), false);
  return true;
}

test("an unknown subject kind is refused by name", () => {
  assert.throws(
    () => signEnvelope({ ...v2Input(), kind: "admin" as never }),
    (error) =>
      error instanceof UnknownSubjectKind &&
      refuses(error, "UnknownSubjectKind") &&
      /"kind"/.test(error.message),
  );
});

test("a v2 envelope without a subject kind is refused by name", () => {
  assert.throws(
    () => signEnvelope({ ...v2Input(), kind: undefined as never }),
    (error) => error instanceof UnknownSubjectKind && refuses(error, "UnknownSubjectKind"),
  );
});

test("a v1 envelope carrying a subject kind is refused, never silently unsigned", () => {
  assert.throws(
    () => signEnvelope({ ...v2Input(), version: 1, kind: "demo" as never }),
    (error) =>
      error instanceof MalformedEnvelope &&
      refuses(error, "MalformedEnvelope") &&
      /"kind"/.test(error.message),
  );
});

test("an empty secret is refused by name and never substituted", () => {
  assert.throws(
    () => signEnvelope({ ...v2Input(), secret: "" }),
    (error) =>
      error instanceof EnvelopeSecretError &&
      refuses(error, "EnvelopeSecretError") &&
      /empty/.test(error.message),
  );
});

test("a body that is not the fingerprinted body is refused by name", () => {
  const tampered = {
    ...V2.body,
    greeting: "Hi, this is not the fingerprinted body.",
  };
  assert.throws(
    () => signEnvelope({ ...v2Input(), body: tampered }),
    (error) =>
      error instanceof BodyFingerprintMismatch &&
      refuses(error, "BodyFingerprintMismatch") &&
      error.message.includes(V2.minted_fingerprint) &&
      !error.message.includes("not the fingerprinted body"),
  );
});

test("an unknown envelope version is refused rather than guessed", () => {
  assert.throws(
    () => signEnvelope({ ...v2Input(), version: 3 as never }),
    (error) => error instanceof MalformedEnvelope && refuses(error, "MalformedEnvelope"),
  );
});

test("the signer is server-only and can never be bundled into a client", () => {
  // The module holds the HMAC secret. `node:crypto` is the server-only import
  // boundary: a client component that imported this file would fail to build
  // rather than ship the secret.
  const source = readFileSync(join(here, "envelope.ts"), "utf8");
  assert.match(source, /from "node:crypto"/);
  assert.doesNotMatch(source, /^["']use client["'];?$/m);
});
