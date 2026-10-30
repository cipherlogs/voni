import { secret } from "@/lib/env";

/**
 * The one runtime pipeline URL (ticket 08).
 *
 * The app points at the cascade pipeline through a single server-side
 * environment value, `VOICE_PIPELINE_URL`, holding an `https` base. Local and
 * production differ only in that value: nothing is baked into the build and
 * the browser never reads a public pipeline variable.
 *
 * The browser cannot connect to `https` — it needs `wss` — so the base is
 * derived here, once, and the mint (ticket 09) delivers the result as
 * `wsUrl`. `[host][:port][/prefix]` is preserved exactly and the service's
 * connect path is appended, so a non-default port and a path prefix both
 * survive and no double slash appears.
 *
 * There is no fallback. A missing URL is a named `missing` result and a
 * non-https value is refused as `insecure` — a localhost default would hide a
 * broken deployment behind a call that cannot connect.
 *
 * This is a server-side module: it reads a runtime secret and must not be
 * imported from a client component.
 */

export const PIPELINE_URL_ENV = "VOICE_PIPELINE_URL";

/** The service's browser WebSocket path (`voice-pipeline/server.py`). */
export const BROWSER_CALL_PATH = "/v1/browser-call";

export type PipelineUrlErrorCode = "missing" | "invalid" | "insecure";

/** A configuration refusal, named so callers can branch without matching text. */
export class PipelineUrlError extends Error {
  readonly code: PipelineUrlErrorCode;

  constructor(code: PipelineUrlErrorCode, message: string) {
    super(message);
    this.name = "PipelineUrlError";
    this.code = code;
  }
}

export type PipelineUrlConfig = {
  /** The configured base, normalised: no trailing slash, `https` only. */
  baseUrl: string;
  /** The browser connect URL the mint hands to the client. */
  wsUrl: string;
};

export type PipelineUrlResult =
  | ({ ok: true } & PipelineUrlConfig)
  | { ok: false; error: PipelineUrlError };

function refuse(code: PipelineUrlErrorCode, message: string): never {
  throw new PipelineUrlError(code, message);
}

/**
 * Validate an `https` base and derive the browser connect URL from it.
 *
 * Throws a named `PipelineUrlError`; `readPipelineUrl` wraps this as a result.
 */
export function deriveBrowserCallUrl(base: string): string {
  const result = readPipelineUrl(base);
  if (!result.ok) throw result.error;
  return result.wsUrl;
}

/**
 * Parse a raw configured value into the two URLs the app needs, or a named
 * refusal. Pure: the runtime reader below is the only place that touches the
 * environment.
 */
export function readPipelineUrl(
  raw: string | null | undefined,
): PipelineUrlResult {
  const value = typeof raw === "string" ? raw.trim() : "";
  try {
    return { ok: true, ...parsePipelineBase(value) };
  } catch (error) {
    if (error instanceof PipelineUrlError) return { ok: false, error };
    throw error;
  }
}

/** The throwing core: one validation order for every entry point. */
function parsePipelineBase(value: string): PipelineUrlConfig {
  if (!value) {
    refuse(
      "missing",
      `${PIPELINE_URL_ENV} is not set. The cascade demo has no pipeline to call.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    refuse(
      "invalid",
      `${PIPELINE_URL_ENV} is not a URL: expected an https base such as https://pipeline.example.com.`,
    );
  }

  if (parsed.protocol !== "https:") {
    refuse(
      "insecure",
      `${PIPELINE_URL_ENV} must use https (got "${parsed.protocol}"); the browser connects over wss, derived from it.`,
    );
  }
  if (!parsed.hostname) {
    refuse("invalid", `${PIPELINE_URL_ENV} has no host.`);
  }
  if (parsed.username || parsed.password) {
    refuse("invalid", `${PIPELINE_URL_ENV} must not carry credentials.`);
  }
  if (parsed.search || parsed.hash) {
    refuse(
      "invalid",
      `${PIPELINE_URL_ENV} must be a base URL: no query string and no fragment.`,
    );
  }

  // A base from a dashboard often arrives with a trailing slash; drop it so
  // the appended path never doubles up. The origin rendering below also drops
  // the default :443, which `URL` normalises away.
  const prefix = parsed.pathname.replace(/\/+$/, "");
  const baseUrl = `${parsed.origin}${prefix}`;
  const ws = new URL(baseUrl);
  ws.protocol = "wss:";
  ws.pathname = `${prefix}${BROWSER_CALL_PATH}`;

  return { baseUrl, wsUrl: ws.toString() };
}

/**
 * Read the pipeline URL from the runtime environment, wherever this deployment
 * keeps it. Returns the typed refusal instead of throwing so a route can turn
 * `missing` into an unavailable response.
 *
 * The old build-time `NEXT_PUBLIC_VOICE_PIPELINE_URL` is deliberately never
 * consulted (ticket 08 AC4): a stale public value must not mask a missing
 * server value.
 */
export async function pipelineUrlFromEnv(): Promise<PipelineUrlResult> {
  return readPipelineUrl(await secret(PIPELINE_URL_ENV));
}
