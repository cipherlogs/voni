/**
 * Deploy parity check for the demo cascade (ticket 20).
 *
 * One operator command answers the three questions a demo depends on, before
 * a visitor discovers the answer:
 *
 *  1. **Do the app and the service point at each other?** The app's runtime
 *     pipeline base (`VOICE_PIPELINE_URL`) must be the service this check
 *     posts to, and the service's `VOICE_PIPELINE_TOOL_BASE_URL` must be the
 *     app's public origin.
 *  2. **Do they agree on the signed body?** A throwaway v2 demo body, signed
 *     with the app's own body builder, envelope signer and call-token signer,
 *     is delivered to `POST /v1/call-body`. The service must accept it; the
 *     same body tampered must be refused with a named 400.
 *  3. **What is the routing mode?** The durable switch is read through
 *     `voice-pipeline/scripts/routing_switch.py` — the one operator path to the
 *     store — and the mode is printed. An unreadable switch is a failure.
 *
 * Hard limits, because this runs next to a live demo: it mints a random call
 * id (never a production one), opens no vendor socket and starts no call. The
 * only network request is the call-body POST, and the only write is whatever
 * the routing switch already holds — this command never flips it.
 *
 * The command runs outside the pull-request path: CI runs the unit tests and
 * never invokes this file, because only a deploy can answer these questions.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  ENVELOPE_VERSION_SUBJECT_KIND,
  envelopeBodyHash,
  signEnvelope,
  type SignedBody,
} from "../../src/lib/voice/envelope";
export { envelopeBodyHash };
import { signCallToken } from "../../src/lib/voice/cascade-token";
import { readPipelineUrl } from "../../src/lib/voice/pipeline-url";
import { buildDemoAgentBody, demoAgentFingerprint } from "../../src/lib/demo/stored-agents";
import { DEMO_VOICE_IDS } from "../../src/lib/demo/voni-agent";
import { DELIVERY_REFUSAL_CODES, REFUSAL_HEADER } from "../../src/lib/demo/pipeline-delivery";
export { REFUSAL_HEADER };

export const PIPELINE_URL_ENV = "VOICE_PIPELINE_URL";
export const SERVICE_URL_ENV = "VOICE_PIPELINE_SERVICE_URL";
export const TOOL_BASE_URL_ENV = "VOICE_PIPELINE_TOOL_BASE_URL";
export const APP_ORIGIN_ENV = "VONI_PUBLIC_ORIGIN";
export const APP_ORIGIN_FALLBACKS = ["BETTER_AUTH_URL", "VONI_API_URL"] as const;
export const ENVELOPE_SECRET_ENV = "VOICE_PIPELINE_ENVELOPE_SECRET";
export const THRESHOLDS_PATH = new URL(
  "../../../voice-pipeline/cascade/thresholds.json",
  import.meta.url,
).pathname;
export const ROUTING_SWITCH_PATH = new URL(
  "../../../voice-pipeline/scripts/routing_switch.py",
  import.meta.url,
).pathname;
export const CALL_BODY_PATH = "/v1/call-body";
export const ROUTING_MODES = ["off", "demo", "all"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** A configured value and where the operator's configuration put it. */
export type Cited = { value: string; source: string };

/** One checklist row: what was checked, its stable name, and the evidence. */
export type HostCheck = {
  /** Human row label, e.g. "pipeline host". */
  name: string;
  /** Machine name, stable across reworded detail text. */
  code: string;
  ok: boolean;
  detail: string;
};

export class ParityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ParityError";
    this.code = code;
  }
}

type ParsedBase = { url: URL; baseUrl: string; host: string; origin: string };

/** Parse one http(s) deployment base; no credentials, no query, no fragment. */
export function parsePublicBase(raw: string, field: string): ParsedBase | ParityError {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return new ParityError(`${field}-missing`, "is not set");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return new ParityError(
      `${field}-invalid`,
      `is not a URL: expected an http(s) base such as https://host[:port]`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return new ParityError(
      `${field}-invalid`,
      `must use http or https (got "${url.protocol}")`,
    );
  }
  if (!url.hostname) {
    return new ParityError(`${field}-invalid`, "has no host");
  }
  if (url.username || url.password) {
    return new ParityError(`${field}-invalid`, "must not carry credentials");
  }
  if (url.search || url.hash) {
    return new ParityError(
      `${field}-invalid`,
      "must be a base URL: no query string and no fragment",
    );
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  return {
    url,
    baseUrl: `${url.origin}${prefix}`,
    host: url.host,
    origin: url.origin,
  };
}

/** Parse the pipeline base through the app's own reader, so the rules match. */
function parsePipelineBase(raw: string): ParsedBase | ParityError {
  const result = readPipelineUrl(raw);
  if (!result.ok) {
    const code =
      result.error.code === "insecure"
        ? "pipeline-url-insecure"
        : `pipeline-url-${result.error.code}`;
    // The reader's message already names the variable; the row names the
    // source, so drop the duplicate prefix and keep the refusal itself.
    return new ParityError(
      code,
      result.error.message.replace(`${PIPELINE_URL_ENV} `, ""),
    );
  }
  return parsePublicBase(result.baseUrl, "pipeline-url");
}

function row(
  name: string,
  code: string,
  ok: boolean,
  detail: string,
): HostCheck {
  return { name, code, ok, detail };
}

function urlRow(
  name: string,
  code: string,
  cited: Cited,
  parsed: ParsedBase | ParityError,
): HostCheck {
  if (parsed instanceof ParityError) {
    return row(name, parsed.code, false, `${cited.source} ${parsed.message}`);
  }
  return row(name, code, true, `${cited.source} = ${parsed.baseUrl}`);
}

/**
 * The four URL rows plus the two cross-deployment host checks, in checklist
 * order. A missing URL skips the host comparison that needs it: the missing
 * value is already a named failure and no comparison is guessed.
 */
export function evaluateHostParity(input: {
  pipeline: Cited;
  service: Cited;
  toolBase: Cited;
  appOrigin: Cited;
}): HostCheck[] {
  const pipeline = parsePipelineBase(input.pipeline.value);
  const service = parsePublicBase(input.service.value, "service-url");
  const toolBase = parsePublicBase(input.toolBase.value, "tool-base-url");
  const appOrigin = parsePublicBase(input.appOrigin.value, "app-origin");

  const rows: HostCheck[] = [
    urlRow("pipeline url", "pipeline-url", input.pipeline, pipeline),
    urlRow("service url", "service-url", input.service, service),
  ];

  if (!(pipeline instanceof ParityError) && !(service instanceof ParityError)) {
    const same = pipeline.host === service.host;
    rows.push(
      row(
        "pipeline host",
        same ? "pipeline-host" : "pipeline-host-mismatch",
        same,
        same
          ? `app pipeline host "${pipeline.host}" is the service this check talks to (${input.service.source})`
          : `app pipeline host "${pipeline.host}" (${input.pipeline.source}) is not the service host "${service.host}" (${input.service.source}); the app would deliver a signed body to a deployment this check is not testing`,
      ),
    );
  }

  rows.push(
    urlRow("tool base url", "tool-base-url", input.toolBase, toolBase),
    urlRow("app origin", "app-origin", input.appOrigin, appOrigin),
  );

  if (!(toolBase instanceof ParityError) && !(appOrigin instanceof ParityError)) {
    const same = toolBase.origin === appOrigin.origin;
    rows.push(
      row(
        "tool base host",
        same ? "tool-base-host" : "tool-base-host-mismatch",
        same,
        same
          ? `service tool base origin "${toolBase.origin}" is the app's public origin (${input.appOrigin.source})`
          : `service tool base origin "${toolBase.origin}" (${input.toolBase.source}) is not the app's public origin "${appOrigin.origin}" (${input.appOrigin.source}); the service's tool calls would reach a different host`,
      ),
    );
  }

  return rows;
}

/**
 * Name the refusal the service returned. The service sets
 * `X-Cascade-Refusal` on every 400/503 refusal, so the check reads that header
 * as the machine-readable source and never classifies `detail` prose (which is
 * kept only as human context by the caller). A missing or unknown header is a
 * failure, never a pass.
 */
const SERVICE_REFUSAL_CODES: ReadonlySet<string> = new Set(
  DELIVERY_REFUSAL_CODES.filter((code) => code !== "transport_failure"),
);

export function refusalName(status: number, refusal: unknown): string | null {
  if (status === 202) return "Accepted";
  if (typeof refusal !== "string") return null;
  const code = refusal.trim().toLowerCase();
  return code !== "" && SERVICE_REFUSAL_CODES.has(code) ? code : null;
}

/**
 * Change the body without touching the signed envelope: the signature still
 * covers the accepted hash, so the service must compute a different body hash
 * and refuse. The accepted message is returned untouched.
 */
export function tamperSignedBody(signed: SignedBody): SignedBody {
  const body = structuredClone(signed.body);
  const name = typeof body.name === "string" ? body.name : "";
  body.name = `${name} (tampered by parity-check)`;
  return { envelope: signed.envelope, body };
}

/** The routing switch, as the one operator CLI reports it. */
export type RoutingView = {
  mode: RoutingMode;
  recordVersion: number | null;
  decidedAt: number | null;
  missing: boolean;
};

/** Validate `routing_switch.py show --json`: a view that cannot be trusted is refused. */
export function parseRoutingShow(stdout: string): RoutingView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ParityError(
      "routing-switch-invalid",
      "the routing switch printed no readable JSON",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ParityError(
      "routing-switch-invalid",
      "the routing switch printed no object",
    );
  }
  const view = parsed as Record<string, unknown>;
  if (!ROUTING_MODES.includes(view.mode as RoutingMode)) {
    throw new ParityError(
      "routing-switch-invalid",
      `the routing switch reported an unknown mode ${JSON.stringify(view.mode)}; expected off, demo or all`,
    );
  }
  if (typeof view.missing !== "boolean") {
    throw new ParityError(
      "routing-switch-invalid",
      "the routing switch did not say whether a switch is stored",
    );
  }
  const recordVersion = view.recordVersion;
  if (
    recordVersion !== null &&
    !(typeof recordVersion === "number" && Number.isInteger(recordVersion))
  ) {
    throw new ParityError(
      "routing-switch-invalid",
      "the routing switch reported no usable recordVersion",
    );
  }
  if (recordVersion === null && !view.missing) {
    throw new ParityError(
      "routing-switch-invalid",
      "the routing switch reported a stored record with no version",
    );
  }
  const decidedAt = view.decidedAt;
  if (decidedAt !== null && typeof decidedAt !== "number") {
    throw new ParityError(
      "routing-switch-invalid",
      "the routing switch reported a non-numeric decidedAt",
    );
  }
  return {
    mode: view.mode as RoutingMode,
    recordVersion: recordVersion as number | null,
    decidedAt: decidedAt as number | null,
    missing: view.missing,
  };
}

/**
 * Read a numeric bound from `cascade/thresholds.json`. The registry is the
 * only home for these numbers: an open bound is a named refusal, never a
 * default invented here.
 */
export function readBound(registry: unknown, name: string): number {
  const bounds =
    registry && typeof registry === "object"
      ? (registry as { bounds?: unknown }).bounds
      : undefined;
  const entry =
    bounds && typeof bounds === "object"
      ? (bounds as Record<string, unknown>)[name]
      : undefined;
  const value =
    entry && typeof entry === "object"
      ? (entry as { value?: unknown }).value
      : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ParityError(
      "bound-unset",
      `${THRESHOLDS_PATH}: bound "${name}" has no positive whole-number value; the registry is its only home and no default is substituted`,
    );
  }
  return value;
}

export function readThresholds(): unknown {
  try {
    return JSON.parse(readFileSync(THRESHOLDS_PATH, "utf8"));
  } catch (error) {
    throw new ParityError(
      "thresholds-unreadable",
      `${THRESHOLDS_PATH}: ${(error as Error).message}`,
    );
  }
}

/** A voice the demo picker offers; the only ids a throwaway body may name. */
export type DemoVoiceId = (typeof DEMO_VOICE_IDS)[number];

/** The signed message the app delivers: the call token and the signed body. */
export type CallBodyPayload = {
  call_token: string;
  call_id: string;
  signed_body: SignedBody;
};
/**
 * Build and sign one throwaway demo body with the app's own builder and
 * signers. `callId` is random in production use; tests inject one only to
 * compare runs.
 */
export function buildSignedThrowawayBody(input: {
  secret: string;
  voiceId: DemoVoiceId;
  envelopeTtlMs: number;
  callTokenTtlMs: number;
  now?: number;
  callId?: string;
}): { payload: CallBodyPayload; signed: SignedBody; acceptedHash: string } {
  const callId = input.callId ?? randomUUID();
  const agentId = `demo:${input.voiceId}`;
  // The account salt scopes the app's own fingerprint check; it never reaches
  // the service (the service verifies the body hash, not the fingerprint), so
  // an empty salt is the honest value for a check that holds no vendor key.
  const accountSalt = "";
  const body = buildDemoAgentBody(input.voiceId);
  const signed = signEnvelope({
    version: ENVELOPE_VERSION_SUBJECT_KIND,
    kind: "demo",
    body: body as unknown as Record<string, unknown>,
    mintedFingerprint: demoAgentFingerprint(body, accountSalt),
    accountSalt,
    secret: input.secret,
    callId,
    agentId,
    ttlMs: input.envelopeTtlMs,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const callToken = signCallToken({
    secret: input.secret,
    callId,
    subject: agentId,
    ttlMs: input.callTokenTtlMs,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return {
    payload: { call_token: callToken, call_id: callId, signed_body: signed },
    signed,
    acceptedHash: envelopeBodyHash(body as unknown as Record<string, unknown>),
  };
}
