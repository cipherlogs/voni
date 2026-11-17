/**
 * Region probe: a Durable Object that answers two questions with evidence.
 *
 * 1. `https://www.cloudflare.com/cdn-cgi/trace` reports the colo that handled
 *    the request — our best available evidence of where the object itself ran.
 * 2. `https://ipinfo.io/json` reports the egress IP and its geography — what a
 *    normal site sees when this object fetches it.
 *
 * `locationHint` is a best-effort placement hint, not a guarantee, so this
 * module reports what actually happened instead of echoing the hint back.
 *
 * The probe body is a pure function (`probeRegion`) so it is unit-testable
 * without the Durable Object runtime.
 */

export const PROBE_TIMEOUT_MS = 5_000;

export const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
export const EGRESS_URL = "https://ipinfo.io/json";

/**
 * Placement hints the route accepts. `satisfies` ties this list to the runtime
 * type, so a typo or a removed hint fails typecheck instead of a deploy.
 */
export const REGION_HINTS = [
  "wnam",
  "enam",
  "sam",
  "apac",
  "weur",
  "eeur",
  "oc",
  "afr",
  "me",
] as const satisfies readonly DurableObjectLocationHint[];

export type RegionHint = (typeof REGION_HINTS)[number];

export function isRegionHint(value: string): value is RegionHint {
  return (REGION_HINTS as readonly string[]).includes(value);
}

/** Where the trace request was handled: the colo, plus the IP it saw. */
export interface RegionTrace {
  colo: string;
  ip: string | null;
}

/** The egress IP and what the geo database says about it. */
export interface RegionEgress {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  org: string | null;
}

/** Named failure of a single source; never a thrown error. */
export type ProbeError =
  | "timeout"
  | "fetch_failed"
  | "unreadable_body"
  | "parse_failed"
  | `http_${number}`;

export interface RegionProbeResult {
  /** True when at least one source produced a usable observation. */
  ok: boolean;
  trace: RegionTrace | null;
  egress: RegionEgress | null;
  ms: number;
  errors: { trace?: ProbeError; egress?: ProbeError };
  /** Present only on total failure (both sources unusable). */
  reason?: string;
}

/** Parse Cloudflare's `key=value` per-line trace body. */
export function parseTrace(text: string): RegionTrace | null {
  const fields = new Map<string, string>();

  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (key === "") continue;
    fields.set(key, line.slice(index + 1).trim());
  }

  const colo = fields.get("colo");
  if (colo === undefined || colo === "") return null;

  const ip = fields.get("ip");
  return { colo, ip: ip === undefined || ip === "" ? null : ip };
}

function textField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Parse ipinfo's JSON. Without an `ip` there is no egress evidence. */
export function parseEgress(text: string): RegionEgress | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  const ip = textField(record.ip);
  if (ip === null) return null;

  return {
    ip,
    city: textField(record.city),
    region: textField(record.region),
    country: textField(record.country),
    org: textField(record.org),
  };
}

interface SourceResult<T> {
  value: T | null;
  error?: ProbeError;
}

function isTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Drop a body we are not going to read; a locked body is not our problem. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or locked; nothing to release.
  }
}

/** A status code is an error code, not a throw. */
function httpError(status: number): ProbeError {
  return `http_${status}`;
}

async function readSource<T>(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  parse: (text: string) => T | null,
): Promise<SourceResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      value: null,
      error: isTimeoutError(error) ? "timeout" : "fetch_failed",
    };
  }

  if (!response.ok) {
    await cancelBody(response);
    return { value: null, error: httpError(response.status) };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    await cancelBody(response);
    return {
      value: null,
      error: isTimeoutError(error) ? "timeout" : "unreadable_body",
    };
  }

  const value = parse(text);
  return value === null ? { value: null, error: "parse_failed" } : { value };
}

export interface ProbeRegionOptions {
  fetch: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask both sources, concurrently, for one object. A source that fails degrades
 * to `null` plus a named error in `errors`; it never fails the whole probe.
 */
export async function probeRegion(
  options: ProbeRegionOptions,
): Promise<RegionProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = Date.now();

  // Each source carries its own timeout, so running them together costs one
  // timeout at worst — a serial probe would cost two.
  const [trace, egress] = await Promise.all([
    readSource(options.fetch, TRACE_URL, timeoutMs, parseTrace),
    readSource(options.fetch, EGRESS_URL, timeoutMs, parseEgress),
  ]);

  const errors: RegionProbeResult["errors"] = {};
  if (trace.error !== undefined) errors.trace = trace.error;
  if (egress.error !== undefined) errors.egress = egress.error;

  return {
    ok: trace.value !== null || egress.value !== null,
    trace: trace.value,
    egress: egress.value,
    ms: Date.now() - started,
    errors,
  };
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

/**
 * The Durable Object. It holds no state: every request is a probe, answered
 * from wherever the object happens to be running.
 */
export class RegionProbe implements DurableObject {
  // Accepted so the runtime can hand the object storage later; unused today.
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(_request: Request): Promise<Response> {
    const started = Date.now();

    let body: RegionProbeResult;
    try {
      body = await probeRegion({
        fetch: (input, init) => globalThis.fetch(input, init),
      });
    } catch (error) {
      // Unreachable by design; kept so a surprise is a readable 502 instead of
      // an opaque 500 the worker route has to guess at.
      body = {
        ok: false,
        trace: null,
        egress: null,
        ms: Date.now() - started,
        errors: {},
        reason: `probe_threw: ${errorDetail(error)}`,
      };
    }

    if (!body.ok) {
      body = { ...body, reason: body.reason ?? "both_sources_failed" };
    }

    return new Response(JSON.stringify(body), {
      status: body.ok ? 200 : 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}
