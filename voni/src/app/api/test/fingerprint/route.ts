import { NextResponse } from "next/server";
import { secret } from "@/lib/env";

/**
 * Server-side lookup of a Fingerprint JS Pro v4 `event_id`.
 *
 * The browser gets an `event_id` from the JS agent after a visit; the trust
 * decision is only worth anything once the server asks Fingerprint about that
 * id directly. This route is the single place that call happens: the secret
 * never leaves the server, and the response is a normalized summary plus the
 * raw event so a test page can show exactly what Fingerprint said.
 *
 * Node runtime, outbound `fetch` only — no Node APIs, so the OpenNext/Cloudflare
 * build handles it the same way it handles every other route. There is
 * deliberately no `export const runtime = "nodejs"`: this app sets
 * `cacheComponents: true`, and Next rejects any route segment config there
 * (`Route segment config "runtime" is not compatible with
 * nextConfig.cacheComponents`). Node.js is the only runtime under Cache
 * Components, so the export would be a no-op that breaks the build.
 */

/**
 * Global region. An EU key must use `https://eu.api.fpjs.io/v4/events` and an
 * AP key `https://ap.api.fpjs.io/v4/events`; the key's region and this base URL
 * have to match or every lookup answers 404.
 */
const FP_EVENTS_URL = "https://api.fpjs.io/v4/events";

const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_EVENT_ID_LENGTH = 128;

const NO_STORE = { "Cache-Control": "no-store" } as const;

type Json = Record<string, unknown>;

function fail(
  status: number,
  reason: string,
  message: string,
  extra?: Json,
): NextResponse {
  return NextResponse.json(
    { ok: false, reason, message, ...extra },
    { status, headers: NO_STORE },
  );
}

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Anything JSON-shaped we pass through untouched, but never `undefined`. */
function asUnknown(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** Only JSON media types are accepted; a missing header is left to the body. */
function isJsonContentType(raw: string | null): boolean {
  if (!raw) return true;
  const mime = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "application/json" || mime.endsWith("+json");
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return fail(
      415,
      "unsupported_media_type",
      "Send the event id as JSON, Content-Type: application/json.",
    );
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return fail(400, "bad_request", "Could not read the request body.");
  }

  // An empty body is the same user mistake as `{"eventId": ""}`.
  if (!text.trim()) {
    return fail(
      400,
      "missing_event_id",
      "Provide the eventId returned by the Fingerprint JS agent.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(400, "bad_request", "Request body must be valid JSON.");
  }

  const body = asRecord(parsed);
  const rawEventId = body?.["eventId"];
  if (typeof rawEventId !== "string") {
    return fail(
      400,
      "missing_event_id",
      "eventId must be the string returned by the Fingerprint JS agent.",
    );
  }
  const eventId = rawEventId.trim();
  if (eventId.length === 0) {
    return fail(
      400,
      "missing_event_id",
      "Provide the eventId returned by the Fingerprint JS agent.",
    );
  }
  if (eventId.length > MAX_EVENT_ID_LENGTH) {
    return fail(
      400,
      "bad_request",
      `eventId must be at most ${MAX_EVENT_ID_LENGTH} characters.`,
    );
  }

  const apiKey = await secret("FINGERPRINT_SECRET_API_KEY");
  if (!apiKey) {
    return fail(
      503,
      "not_configured",
      "Fingerprint secret API key is not configured.",
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${FP_EVENTS_URL}/${encodeURIComponent(eventId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeout(error)) {
      return fail(
        504,
        "upstream_timeout",
        "Fingerprint did not answer in time. Try the lookup again.",
      );
    }
    return fail(502, "upstream_error", "Could not reach Fingerprint.");
  }

  if (upstream.status === 404) {
    return fail(
      404,
      "not_found",
      "Fingerprint has no event with that id (unknown, expired, or an id from another region).",
    );
  }
  if (!upstream.ok) {
    // Deliberately no upstream body: it can echo request details back.
    return fail(
      502,
      "upstream_error",
      "Fingerprint rejected the lookup.",
      { status: upstream.status },
    );
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return fail(
      502,
      "upstream_error",
      "Fingerprint returned a body this route could not read.",
      { status: upstream.status },
    );
  }

  const event = asRecord(payload) ?? {};
  const products = asRecord(event["products"]);
  const identification =
    asRecord(event["identification"]) ?? asRecord(products?.["identification"]);
  const confidence = asRecord(identification?.["confidence"]);

  return NextResponse.json(
    {
      ok: true,
      eventId,
      visitorId: asString(identification?.["visitor_id"]),
      visitorFound: asBoolean(identification?.["visitor_found"]),
      confidence: asNumber(confidence?.["score"]),
      firstSeenAt: asString(event["first_seen_at"]),
      lastSeenAt: asString(event["last_seen_at"]),
      suspectScore: asNumber(event["suspect_score"]),
      tampering: asUnknown(event["tampering"]),
      bot: asUnknown(event["bot"]),
      raw: payload,
    },
    { headers: NO_STORE },
  );
}
