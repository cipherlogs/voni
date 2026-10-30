/**
 * THE DEMO'S ONE DELIVERY TO THE PIPELINE (demo-cascade ticket 07).
 *
 * The mint (ticket 09) builds and signs the demo body (ticket 06), mints the
 * cascade call token, and hands both to this module. This module posts the
 * three fields the service's channel accepts — nothing else — and maps every
 * answer to a typed result the mint can act on without reading prose.
 *
 * The rules this module exists to keep:
 *
 * - One request. There is no retry loop and no second engine: a refusal is the
 *   visitor's unavailable state, never a managed call.
 * - Nothing is kept. The call token, the signed body and its signature live
 *   for the length of this function; no module state holds them after the
 *   answer, and the accepted result carries only the service's identity.
 * - Nothing is logged. Neither the secret, the body, the signature nor the
 *   call token appears in a log line, an error message or a result message.
 * - The refusal code is machine-readable: the service names it in the
 *   `X-Cascade-Refusal` header, so the client never parses `detail` prose. A
 *   missing header (an older service, a proxy error page) is a failed
 *   delivery, not a guessed refusal.
 *
 * This is a server-side module: it carries the signed body and the call token,
 * which must never reach a client bundle.
 */

/** The service's signed-body path (`voice-pipeline/server.py`). */
export const CALL_BODY_PATH = "/v1/call-body";

/** The response header the service sets on every 400/503 refusal. */
export const REFUSAL_HEADER = "x-cascade-refusal";

/**
 * Every refusal the mint must be able to tell apart. `store_unavailable` is
 * the one code the service does not raise on this path today; it is mapped
 * here so a 503 that names it (a future store-backed channel) needs no client
 * change and no prose match.
 */
export const DELIVERY_REFUSAL_CODES = [
  "draining",
  "envelope_secret_missing",
  "malformed_body",
  "envelope_refused",
  "duplicate_call_token",
  "store_unavailable",
  "transport_failure",
] as const;

export type DeliveryRefusalCode = (typeof DELIVERY_REFUSAL_CODES)[number];

/** The pipeline accepted the body: the identity the mint hands back. */
export type DeliveryAccepted = {
  ok: true;
  callId: string;
  agentId: string;
  bodyHash: string;
};

/** The pipeline did not take the call. `message` is safe to show a visitor. */
export type DeliveryRefused = {
  ok: false;
  code: DeliveryRefusalCode;
  message: string;
};

export type DeliveryResult = DeliveryAccepted | DeliveryRefused;

export type DeliverCallBodyInput = {
  /** The runtime pipeline base (ticket 08), `https` and without a trailing slash. */
  pipelineBase: string;
  /** `ct1.…`, minted for this call and this subject. */
  callToken: string;
  /** The demo call's existing id. */
  callId: string;
  /** `{envelope, body}` as signed by ticket 06. */
  signedBody: unknown;
};

export type DeliverCallBodyDeps = {
  /** Injectable for tests; the global `fetch` otherwise. */
  fetchImpl?: typeof fetch;
};

/**
 * One visitor-safe line per refusal. These are what the demo shows; they never
 * name an engine, a vendor, a transport or any part of the signed body, and
 * they never repeat a `detail` string from the service.
 */
const MESSAGES: Record<DeliveryRefusalCode, string> = {
  draining: "The live demo is restarting. Please try again in a moment.",
  envelope_secret_missing: "The live demo is not available right now.",
  store_unavailable: "The live demo is busy right now. Please try again in a moment.",
  malformed_body: "The live demo could not start this call. Please try again.",
  envelope_refused: "The live demo could not accept this call. Please try again.",
  duplicate_call_token: "That call was already started. Please start a new call.",
  transport_failure: "The live demo is unreachable right now. Please try again in a moment.",
};

/** The refusals the service can name; `transport_failure` is the client's own. */
const SERVICE_REFUSAL_CODES: readonly DeliveryRefusalCode[] =
  DELIVERY_REFUSAL_CODES.filter((code) => code !== "transport_failure");

/** The visitor-safe line for a refusal code — one source for every caller. */
export function deliveryMessage(code: DeliveryRefusalCode): string {
  return MESSAGES[code];
}

function refuse(code: DeliveryRefusalCode): DeliveryRefused {
  return { ok: false, code, message: MESSAGES[code] };
}

function callBodyUrl(pipelineBase: string): string {
  return `${pipelineBase.replace(/\/+$/, "")}${CALL_BODY_PATH}`;
}

/**
 * Post the signed body for one call, once, and classify the answer.
 *
 * Never throws: a thrown fetch, an unreadable answer and an unrecognised
 * status are all `transport_failure`, because none of them is the pipeline
 * refusing this call by name.
 */
export async function deliverCallBody(
  input: DeliverCallBodyInput,
  deps: DeliverCallBodyDeps = {},
): Promise<DeliveryResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(callBodyUrl(input.pipelineBase), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        call_token: input.callToken,
        call_id: input.callId,
        signed_body: input.signedBody,
      }),
    });
  } catch {
    return refuse("transport_failure");
  }

  if (response.status === 202) {
    const accepted = await readAccepted(response);
    if (accepted) return accepted;
  }
  const named = namedRefusal(response);
  return refuse(named ?? "transport_failure");
}

/** The refusal the service named in its header, or `null` if it named none we know. */
function namedRefusal(response: Response): DeliveryRefusalCode | null {
  const value = response.headers.get(REFUSAL_HEADER)?.trim().toLowerCase();
  if (!value) return null;
  return SERVICE_REFUSAL_CODES.find((code) => code === value) ?? null;
}

/** Read the service's 202 identity; anything malformed is not an acceptance. */
async function readAccepted(response: Response): Promise<DeliveryAccepted | null> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const callId = record.call_id;
  const agentId = record.agent_id;
  const bodyHash = record.body_hash;
  if (
    typeof callId !== "string" ||
    typeof agentId !== "string" ||
    typeof bodyHash !== "string"
  ) {
    return null;
  }
  return { ok: true, callId, agentId, bodyHash };
}
