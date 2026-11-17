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
 * The guards are the point, not a nicety:
 *   - a script without the placeholder may already carry a real secret, and
 *     uploading it blindly would either overwrite a working secret or push a
 *     leaked one back to Grafana;
 *   - a secret that cannot survive a JavaScript string literal is refused
 *     before the swap, because it would break the script or silently 401;
 *   - a mistyped EMAIL_CLICK_CHECK_ID is refused, and the fetched check must be
 *     the affiliate click check with an explicit `enabled` flag, because a
 *     wrong id would otherwise write the secret-bearing script into someone
 *     else's check.
 *
 * The read-back is what makes the result a fact: Grafana is re-fetched and the
 * script hash plus every untouched setting are compared before this command
 * claims success. A failed write or read-back gets one more read, so the abort
 * text can say whether the write landed. Nothing here prints the secret, a
 * prefix of it, or any substring of it.
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

/** The one check this script may write to. */
const CHECK_JOB = "voni-affiliate-click-us";
const CHECK_TARGET = "https://voni.cc/email";

type Json = Record<string, unknown>;
type GrafanaConfig = { baseUrl: string; token: string };

function abort(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Every refusal and every failed round trip travels as this, so one catch site prints it. */
function refuse(message: string): never {
  throw new AffiliateCheckUploadError(message);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
    refuse(`${name} is not set (see ENVIRONMENT.md).`);
  }
  return value;
}

/**
 * `EMAIL_CLICK_CHECK_ID` when it is a positive integer; the known check only
 * when the variable is unset. A set-but-broken value must never fall back: the
 * fallback would look like success while writing to a check nobody asked for.
 */
function checkId(): number {
  const raw = (process.env.EMAIL_CLICK_CHECK_ID ?? "").trim();
  if (raw === "") return DEFAULT_CHECK_ID;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    refuse(
      `refusing to upload: EMAIL_CLICK_CHECK_ID is "${raw}", which is not a positive ` +
        `integer. Unset it to use check ${DEFAULT_CHECK_ID}, or fix the value.`,
    );
  }
  return Number(raw);
}

/** The transport, minus the status handling: throws only when Grafana is unreachable. */
async function send(
  config: GrafanaConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  try {
    return await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    // Quotes the transport reason only. The token travels in a header and the
    // script only in a body; neither reaches a fetch error message.
    refuse(`could not reach Grafana at GRAFANA_SM_URL: ${messageOf(cause)}`);
  }
}

function checkStatus(response: Response, path: string): void {
  if (response.status === 401 || response.status === 403) {
    refuse(`Grafana rejected GRAFANA_SM_TOKEN (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    // The response body is not printed: a rejected write can echo the check,
    // and the check can hold the script.
    refuse(`Grafana answered HTTP ${response.status} for ${path}.`);
  }
}

async function requestJson(
  config: GrafanaConfig,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await send(config, body === undefined ? "GET" : "POST", path, body);
  checkStatus(response, path);
  try {
    return await response.json();
  } catch {
    refuse(`Grafana returned an unreadable response for ${path}.`);
  }
}

/**
 * The write, reported as a reason instead of thrown: the caller has one more
 * thing to do before aborting — read back what Grafana now stores.
 */
async function writeCheck(
  config: GrafanaConfig,
  id: number,
  body: Json,
): Promise<string | null> {
  const path = `/check/${id}`;
  let response: Response;
  try {
    response = await send(config, "POST", path, body);
  } catch (cause) {
    return messageOf(cause);
  }
  if (response.status === 401 || response.status === 403) {
    return `Grafana rejected GRAFANA_SM_TOKEN (HTTP ${response.status})`;
  }
  if (!response.ok) {
    return `Grafana answered HTTP ${response.status} for ${path}`;
  }
  return null;
}

async function readCheck(config: GrafanaConfig, id: number): Promise<Json> {
  const body = await requestJson(config, `/check/${id}`);
  if (!isRecord(body)) refuse("Grafana returned an unexpected check body.");
  return body;
}

/** The check's scripted block, or a refusal that names the check's shape. */
function scriptedOf(body: Json, id: number): Json {
  const settings = body["settings"];
  if (!isRecord(settings)) {
    refuse(`check ${id} has no settings block; refusing to rewrite it.`);
  }
  const scripted = settings["scripted"];
  if (!isRecord(scripted) || typeof scripted["script"] !== "string") {
    refuse(`check ${id} is not a scripted check; refusing to rewrite it.`);
  }
  return scripted;
}

/**
 * The fetched check must be the affiliate click check, and its `enabled` flag
 * must be present and boolean: Grafana reads an absent flag as "on", so a check
 * this command cannot see as paused would be resumed by writing it.
 */
function assertCheckIdentity(body: Json, id: number): void {
  const job = body["job"];
  const target = body["target"];
  if (job !== CHECK_JOB && target !== CHECK_TARGET) {
    refuse(
      `refusing to upload: check ${id} is job ${JSON.stringify(job)} on ` +
        `${JSON.stringify(target)}, not ${CHECK_JOB} or ${CHECK_TARGET}. ` +
        "A wrong check id would put the secret-bearing script in someone else's check.",
    );
  }
  if (typeof body["enabled"] !== "boolean") {
    refuse(
      `refusing to upload: check ${id} has no boolean "enabled" flag ` +
        `(got ${JSON.stringify(body["enabled"])}). Grafana reads an absent flag as ` +
        "on, so this command will not write a check it cannot see as paused.",
    );
  }
}

function decodeScript(script: string): string {
  return Buffer.from(script, "base64").toString("utf8");
}

/**
 * One best-effort read of the script Grafana now stores, as a sha256. `null`
 * when even that read fails. Only a hash leaves this function, so the abort
 * text can say whether the write landed without printing any of the bytes.
 */
async function storedHashOnce(config: GrafanaConfig, id: number): Promise<string | null> {
  try {
    const body = await readCheck(config, id);
    const scripted = scriptedOf(body, id);
    return sha256(decodeScript(scripted["script"] as string));
  } catch {
    return null;
  }
}

function storedVerdict(stored: string | null, expected: string): string {
  if (stored === null) {
    return "the read-back could not be completed, so whether the write landed is unknown";
  }
  if (stored === expected) {
    return "a read-back shows Grafana stores exactly this script, so the write landed";
  }
  return "a read-back shows Grafana stores a different script, so the write did not land";
}

/** Abort after a failed write or read-back, and say whether re-running is safe. */
function abortAfterFailure(what: string, stored: string | null, expected: string): never {
  return refuse(
    `${what}. ${storedVerdict(stored, expected)}. ` +
      "Re-running `npm run affiliate:upload` is safe: it posts the same bytes and " +
      "verifies them again.",
  );
}

/** The read-back, retried once; the retry exists so a blip is not reported as a failure. */
async function readBack(
  config: GrafanaConfig,
  id: number,
  expected: string,
): Promise<Json> {
  try {
    return await readCheck(config, id);
  } catch {
    try {
      return await readCheck(config, id);
    } catch (second) {
      abortAfterFailure(
        `the read-back failed twice: ${messageOf(second)}`,
        await storedHashOnce(config, id),
        expected,
      );
    }
  }
}

async function main(): Promise<void> {
  const baseUrl = normalizeBaseUrl(requireEnv("GRAFANA_SM_URL"));
  if (!baseUrl) refuse("GRAFANA_SM_URL is not set or malformed.");
  const config: GrafanaConfig = {
    baseUrl,
    token: requireEnv("GRAFANA_SM_TOKEN"),
  };
  const secret = requireEnv("EMAIL_CLICK_REPORT_SECRET");
  const id = checkId();

  const committed = readFileSync(SCRIPT_PATH, "utf8");
  // Guard first, before any network call: a file without the placeholder, or a
  // secret that cannot survive a string literal, must never reach Grafana.
  let injected: string;
  try {
    injected = injectReportSecret(committed, secret);
  } catch (error) {
    abort(messageOf(error));
  }
  if (!injected.includes(`const REPORT_SECRET = "${secret}";`)) {
    refuse(
      "refusing to upload: the secret did not land in the REPORT_SECRET declaration.",
    );
  }
  if (countOccurrences(injected, REPORT_SECRET_PLACEHOLDER) === 0) {
    refuse(
      "refusing to upload: the reporting enable check lost its placeholder comparison; regenerate the script.",
    );
  }

  const original = await readCheck(config, id);
  assertCheckIdentity(original, id);
  const scripted = scriptedOf(original, id);
  const originalScript = scripted["script"] as string;
  const expectedHash = sha256(injected);
  const encoded = Buffer.from(injected, "utf8").toString("base64");

  const settings = original["settings"] as Json;
  const posted = {
    ...original,
    settings: { ...settings, scripted: { ...scripted, script: encoded } },
  };

  const writeFailure = await writeCheck(config, id, posted);
  if (writeFailure !== null) {
    abortAfterFailure(
      `the upload failed: ${writeFailure}`,
      await storedHashOnce(config, id),
      expectedHash,
    );
  }

  const confirmed = await readBack(config, id, expectedHash);
  const confirmedScripted = scriptedOf(confirmed, id);
  const confirmedDecoded = decodeScript(confirmedScripted["script"] as string);
  const confirmedHash = sha256(confirmedDecoded);

  if (confirmedHash !== expectedHash) {
    abortAfterFailure(
      "upload could not be verified: the script Grafana stores is not the one that was sent",
      confirmedHash,
      expectedHash,
    );
  }

  const changed = changedCheckFields(original, confirmed);
  if (changed.length > 0) {
    refuse(
      `upload changed settings it must not touch: ${changed.join(", ")}. ` +
        "The check was written, so re-read it in Grafana before using it. " +
        "Re-running `npm run affiliate:upload` is safe once that is understood.",
    );
  }

  const originalHash = sha256(decodeScript(originalScript));
  const digest = expectedHash.slice(0, 8);

  console.log(`check      ${id}`);
  console.log(`script     ${Buffer.byteLength(injected, "utf8")} bytes, sha256 ${digest}`);
  console.log("secret     injected (not printed)");
  console.log(
    `changed    ${
      originalHash === expectedHash
        ? "nothing; Grafana already held this script"
        : `settings.scripted.script (sha256 ${originalHash.slice(0, 8)} -> ${digest})`
    }`,
  );
  console.log(
    "unchanged  id, job, target, enabled, frequency, timeout, probes, labels, tenantId",
  );
  console.log(`source     ${SCRIPT_LABEL}`);
}

try {
  await main();
} catch (error) {
  abort(messageOf(error));
}
