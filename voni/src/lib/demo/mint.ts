import { getVoice } from "@/lib/agents/voices";
import {
  carryDemoCall,
  demoCallKey,
  signDemoCallFor,
  signTagToken,
  verifyDemoCall,
  verifyTagToken,
} from "./call-token";
import {
  buildDemoCascadeBody,
  type DemoCascadeBodyDeps,
  type DemoCascadeBodyInput,
  type DemoCascadeCall,
} from "./cascade-body";
import { checkDemoLimits, type LimitDecision } from "./rate-limit";
import { recordDemoCall } from "./reply";
import {
  deliverCallBody,
  deliveryMessage,
  type DeliverCallBodyDeps,
  type DeliverCallBodyInput,
  type DeliveryResult,
} from "./pipeline-delivery";
import { WALL_CAP_S } from "./talk-clock";
import { issueTestTag, loadLiveTestTag, tagForMint } from "./test-tag-registry";
import { DEMO_VOICE_IDS } from "./voni-agent";
import { pipelineUrlFromEnv, type PipelineUrlResult } from "@/lib/voice/pipeline-url";

/**
 * THE PUBLIC DEMO MINT (demo-cascade ticket 09).
 *
 * The demo has one door to a call: this module. It keeps the controls the
 * managed mint had — per-IP and global limits, the visitor's Test tag, the
 * call record, the wall cap — and replaces the vendor session with the
 * cascade's signed contract:
 *
 *   1. build the demo call body locally with the one stored-body builder
 *      (ticket 06), never an inline prompt and never a vendor agent;
 *   2. deliver the signed envelope to the pipeline once (ticket 07);
 *   3. return the browser identity only: the pipeline URL, the demo subject,
 *      the single-use cascade call token and the existing demo call token.
 *
 * There is no managed fallback and no engine choice. A pipeline refusal or a
 * missing pipeline configuration is the visitor's unavailable state; the
 * response never names a vendor, a fallback engine or the served body; the
 * effective engine is reported as cascade.
 *
 * Every dependency the request touches — the limit store, the tag registry,
 * the call record, the body builder, the delivery client, the pipeline URL and
 * the clock — is injected so the handler is testable without a database or a
 * network. The Next route is a one-line adapter.
 */

/** The visitor-facing line for every configuration or delivery failure. */
export const UNAVAILABLE_MESSAGE = "The live demo is not available right now.";

/** A hold rejoin that names no live call is a new call, not a resumed one. */
export const CALL_ENDED_MESSAGE = "That call has ended. Please start a new call.";

/** The body sent before this door parses: only these five fields matter. */
export type MintRequestBody = {
  voiceId?: unknown;
  resume?: unknown;
  callToken?: unknown;
  tagToken?: unknown;
  /** A hold return's bounded recent turns; validated by the body builder. */
  history?: unknown;
};

export type MintDeps = {
  /** The rate-limit store (per-IP and global); the real one hits Postgres. */
  limits: (headers: Headers) => Promise<LimitDecision>;
  /** The Test-tag registry, as `tagForMint` consumes it. */
  tags: { load: typeof loadLiveTestTag; issue: typeof issueTestTag };
  /** The demo call record; a failure is a warning, never a refused call. */
  recordCall: (callId: string, tagId: string | null, language: string) => Promise<void>;
  /** The one body builder (ticket 06). */
  buildBody: (input: DemoCascadeBodyInput, deps?: DemoCascadeBodyDeps) => Promise<DemoCascadeCall>;
  /** The one delivery to the pipeline (ticket 07). */
  deliver: (input: DeliverCallBodyInput, deps?: DeliverCallBodyDeps) => Promise<DeliveryResult>;
  /** The one runtime pipeline URL (ticket 08). */
  pipelineUrl: () => Promise<PipelineUrlResult>;
  /** Epoch milliseconds; injected so tests pin the signed windows. */
  clock: () => number;
  /** The demo call token's signing key; the real one is `BETTER_AUTH_SECRET`. */
  callKey: () => Promise<string | undefined>;
};

const DEFAULT_DEPS: MintDeps = {
  limits: checkDemoLimits,
  tags: { load: loadLiveTestTag, issue: issueTestTag },
  recordCall: recordDemoCall,
  buildBody: buildDemoCascadeBody,
  deliver: deliverCallBody,
  pipelineUrl: pipelineUrlFromEnv,
  clock: () => Date.now(),
  callKey: demoCallKey,
};

function unavailable(): Response {
  return noStore({ error: UNAVAILABLE_MESSAGE }, 503);
}

function noStore(payload: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function refused(): Response {
  return noStore({ error: "Unknown voice." }, 400);
}

/** One mint's decided state, so the handler reads as the order of the controls. */
async function mint(request: Request, deps: MintDeps): Promise<Response> {
  const { headers } = request;
  const limit = await deps.limits(headers);
  if (!limit.allowed) {
    return noStore({ error: limit.reason }, 429, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  let body: MintRequestBody;
  try {
    body = (await request.json()) as MintRequestBody;
  } catch {
    return noStore({ error: "Bad request." }, 400);
  }
  if (body === null || typeof body !== "object") return noStore({ error: "Bad request." }, 400);

  const voiceId = typeof body.voiceId === "string" ? body.voiceId : "";
  if (!(DEMO_VOICE_IDS as readonly string[]).includes(voiceId)) return refused();
  const resume = body.resume === true;
  const now = deps.clock();

  const callKey = await deps.callKey();
  if (!callKey) return unavailable();

  const pipeline = await deps.pipelineUrl();
  if (!pipeline.ok) {
    // Named for the operator, not the visitor: the demo stays unavailable,
    // but the reason is visible in the server log (no URL, no secret).
    console.warn(`[demo-token] pipeline unavailable: ${pipeline.error.code}`);
    return unavailable();
  }

  // A hold rejoin must continue the call it left: no previous token, no resume.
  const previous = typeof body.callToken === "string" ? verifyDemoCall(callKey, body.callToken, now) : null;
  if (resume && !previous) return noStore({ error: CALL_ENDED_MESSAGE }, 400);

  // The visitor's Test tag: the browser's token re-issues the same tag for a
  // day, so a callback finds the email sent after a late call; otherwise a
  // fresh tag in the call's language.
  const held = typeof body.tagToken === "string" ? verifyTagToken(callKey, body.tagToken, now) : null;
  const language = getVoice(voiceId)?.languageCode ?? "en";
  const { tag, carried } = await tagForMint(
    held && { ...held, continuing: previous?.tagId === held.id },
    language,
    deps.tags,
  );

  // The demo call's existing identity: a hold return always continues the
  // held call id with a fresh token (a changed tag must never start a second
  // call); every other mint carries the token while it is valid. The return
  // keeps the call's first start: its inbox lookback and credential window do
  // not move when the visitor comes back.
  const demoCallToken =
    resume && previous
      ? signDemoCallFor(callKey, previous.callId, now, tag.id, previous.startedAt)
      : carryDemoCall(callKey, body.callToken, now, tag.id);
  const demoCall = verifyDemoCall(callKey, demoCallToken, now);
  if (!demoCall) return unavailable();
  // The call's language, for Voni's reply. A rejoin keeps its row. Never
  // fatal: the reply falls back to the tag's language.
  try {
    await deps.recordCall(demoCall.callId, tag.id, language);
  } catch (e: unknown) {
    console.warn(`[demo-token] call record failed: ${e}`);
  }

  let cascade: DemoCascadeCall;
  try {
    cascade = await deps.buildBody(
      {
        voice: voiceId,
        callId: demoCall.callId,
        resume,
        ...(body.history === undefined
          ? {}
          : { history: body.history as DemoCascadeBodyInput["history"] }),
      },
      { now },
    );
  } catch (e) {
    console.warn(`[demo-token] body refused: ${e instanceof Error ? e.message : e}`);
    return unavailable();
  }

  const delivered = await deps.deliver({
    pipelineBase: pipeline.baseUrl,
    callToken: cascade.callToken,
    callId: cascade.callId,
    signedBody: cascade.signedBody,
  });
  if (!delivered.ok) {
    console.warn(`[demo-token] pipeline refused the body: ${delivered.code}`);
    return noStore({ error: deliveryMessage(delivered.code) }, 503);
  }
  return noStore(
    {
      engine: "cascade",
      wsUrl: pipeline.wsUrl,
      agentId: cascade.agentId,
      callToken: cascade.callToken,
      demoCallToken,
      testTag: tag.tag,
      // A carried tag keeps its token (same id and issue time).
      tagToken: signTagToken(callKey, tag.id, tag.issuedAt.getTime()),
      /** Carried from an earlier call: its email may already be in (Q15). */
      tagCarried: carried,
      maxSessionSeconds: WALL_CAP_S,
    },
    200,
  );
}

/** Build the route handler around the injected seams; the route holds no logic. */
export function createDemoTokenHandler(overrides: Partial<MintDeps> = {}) {
  const deps: MintDeps = { ...DEFAULT_DEPS, ...overrides };
  return (request: Request): Promise<Response> => mint(request, deps);
}
