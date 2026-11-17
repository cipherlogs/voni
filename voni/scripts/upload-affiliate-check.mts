/**
 * Uploads scripts/affiliate-click-check.k6.js to the Grafana Synthetic
 * Monitoring check, with the click-report secret injected in memory only.
 *
 *   npm run affiliate:upload
 *
 * Why this exists: a Grafana scripted check cannot be given `__ENV` values, so
 * the report target and secret must be constants in the stored script — but the
 * script is generated, committed and reviewed, and a secret in it would be a
 * secret in git. So the committed file carries `"__REPORT_SECRET__"` and this
 * command substitutes EMAIL_CLICK_REPORT_SECRET into the copy it posts.
 *
 * The placeholder guard is the point, not a nicety: a script without the
 * placeholder may already carry a real secret, and uploading it blindly would
 * either overwrite a working secret or push a leaked one back to Grafana.
 *
 * The read-back is what makes the result a fact: Grafana is re-fetched and the
 * script hash plus every untouched setting are compared before this command
 * claims success. Nothing here prints the secret, a prefix of it, or any
 * substring of it.
 *
 * Reads `.env.local` the way drizzle.config.ts does; real environment values
 * win, so CI can supply the three variables instead.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CHECK_ID,
  normalizeBaseUrl,
} from "../src/lib/grafana/synthetic";
import {
  AffiliateCheckUploadError,
  changedCheckFields,
  countOccurrences,
  injectReportSecret,
  REPORT_SECRET_PLACEHOLDER,
} from "./lib/affiliate-check";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI and on a fresh clone; the real environment is used there.
}

const SCRIPT_PATH = join(import.meta.dirname, "affiliate-click-check.k6.js");
const SCRIPT_LABEL = "scripts/affiliate-click-check.k6.js";
const REQUEST_TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;

function abort(message: string): never {
  console.error(message);
  process.exit(1);
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function requireEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value === "") {
    abort(`${name} is not set (see ENVIRONMENT.md).`);
  }
  return value;
}

/** `EMAIL_CLICK_CHECK_ID` when it is a positive integer, else the known check. */
function checkId(): number {
  const parsed = Number((process.env.EMAIL_CLICK_CHECK_ID ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHECK_ID;
}

type GrafanaConfig = { baseUrl: string; token: string };

async function requestJson(
  config: GrafanaConfig,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const hasBody = body !== undefined;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/json",
  };
  if (hasBody) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: hasBody ? "POST" : "GET",
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    // Quotes the transport reason only. The token travels in a header and the
    // script only in a body; neither reaches a fetch error message.
    const detail = cause instanceof Error ? cause.message : String(cause);
    abort(`could not reach Grafana at GRAFANA_SM_URL: ${detail}`);
  }

  if (response.status === 401 || response.status === 403) {
    abort(`Grafana rejected GRAFANA_SM_TOKEN (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    // The response body is not printed: a rejected write can echo the check,
    // and the check can hold the script.
    abort(`Grafana answered HTTP ${response.status} for ${path}.`);
  }

  try {
    return await response.json();
  } catch {
    abort(`Grafana returned an unreadable response for ${path}.`);
  }
}

async function readCheck(config: GrafanaConfig, id: number): Promise<Json> {
  const body = await requestJson(config, `/check/${id}`);
  if (!isRecord(body)) abort("Grafana returned an unexpected check body.");
  return body;
}

/** The check's scripted block, or a refusal that names the check's shape. */
function scriptedOf(body: Json, id: number): Json {
  const settings = body["settings"];
  if (!isRecord(settings)) {
    abort(`check ${id} has no settings block; refusing to rewrite it.`);
  }
  const scripted = settings["scripted"];
  if (!isRecord(scripted) || typeof scripted["script"] !== "string") {
    abort(`check ${id} is not a scripted check; refusing to rewrite it.`);
  }
  return scripted;
}

function decodeScript(script: string): string {
  return Buffer.from(script, "base64").toString("utf8");
}

async function main(): Promise<void> {
  const baseUrl = normalizeBaseUrl(requireEnv("GRAFANA_SM_URL"));
  if (!baseUrl) abort("GRAFANA_SM_URL is not set or malformed.");
  const config: GrafanaConfig = {
    baseUrl,
    token: requireEnv("GRAFANA_SM_TOKEN"),
  };
  const secret = requireEnv("EMAIL_CLICK_REPORT_SECRET");
  const id = checkId();

  const committed = readFileSync(SCRIPT_PATH, "utf8");
  // Guard first, before any network call: a file without the placeholder must
  // never reach Grafana, whoever asks.
  let injected: string;
  try {
    injected = injectReportSecret(committed, secret);
  } catch (error) {
    abort(error instanceof AffiliateCheckUploadError ? error.message : String(error));
  }
  if (!injected.includes(`const REPORT_SECRET = "${secret}";`)) {
    abort(
      "refusing to upload: the secret did not land in the REPORT_SECRET declaration.",
    );
  }
  if (countOccurrences(injected, REPORT_SECRET_PLACEHOLDER) === 0) {
    abort(
      "refusing to upload: the reporting enable check lost its placeholder comparison; regenerate the script.",
    );
  }

  const original = await readCheck(config, id);
  const scripted = scriptedOf(original, id);
  const originalScript = scripted["script"] as string;
  const encoded = Buffer.from(injected, "utf8").toString("base64");

  const settings = original["settings"] as Json;
  const posted = {
    ...original,
    settings: { ...settings, scripted: { ...scripted, script: encoded } },
  };

  await requestJson(config, `/check/${id}`, posted);

  const confirmed = await readCheck(config, id);
  const confirmedScripted = scriptedOf(confirmed, id);
  const confirmedDecoded = decodeScript(confirmedScripted["script"] as string);

  if (sha256(confirmedDecoded) !== sha256(injected)) {
    abort(
      "upload could not be verified: the script Grafana stores is not the one that was sent.",
    );
  }

  const changed = changedCheckFields(original, confirmed);
  if (changed.length > 0) {
    abort(
      `upload changed settings it must not touch: ${changed.join(", ")}. ` +
        "The check was written, so re-read it in Grafana before using it.",
    );
  }

  const originalHash = sha256(decodeScript(originalScript));
  const hash = sha256(injected);
  const digest = hash.slice(0, 8);

  console.log(`check      ${id}`);
  console.log(`script     ${Buffer.byteLength(injected, "utf8")} bytes, sha256 ${digest}`);
  console.log("secret     injected (not printed)");
  console.log(
    `changed    ${
      originalHash === hash
        ? "nothing; Grafana already held this script"
        : `settings.scripted.script (sha256 ${originalHash.slice(0, 8)} -> ${digest})`
    }`,
  );
  console.log(
    "unchanged  id, job, target, enabled, frequency, timeout, probes, labels, tenantId",
  );
  console.log(`source     ${SCRIPT_LABEL}`);
}

await main();
