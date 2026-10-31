/**
 * `npm run parity:check` — the deploy parity command (ticket 20).
 *
 * The pure host, signing and routing logic lives in `./lib/parity.ts`; this
 * file is the operator surface: flags, environment, the two call-body
 * deliveries, the routing read, and the printed report. Read the module doc in
 * `./lib/parity.ts` for what the check proves and what it refuses to touch.
 *
 * This command is deliberately outside the pull-request path: CI runs the unit
 * tests in `scripts/parity-check.test.ts` and never invokes this file, because
 * only a deploy (or a local service) can answer these questions.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { secret } from "../src/lib/env";
import { pipelineUrlFromEnv } from "../src/lib/voice/pipeline-url";
import { DEMO_VOICE_IDS } from "../src/lib/demo/voni-agent";
import {
  APP_ORIGIN_ENV,
  APP_ORIGIN_FALLBACKS,
  CALL_BODY_PATH,
  ENVELOPE_SECRET_ENV,
  PIPELINE_URL_ENV,
  REFUSAL_HEADER,
  ROUTING_SWITCH_PATH,
  SERVICE_URL_ENV,
  THRESHOLDS_PATH,
  TOOL_BASE_URL_ENV,
  ParityError,
  buildSignedThrowawayBody,
  envelopeBodyHash,
  evaluateHostParity,
  parsePublicBase,
  parseRoutingShow,
  readBound,
  readThresholds,
  refusalName,
  tamperSignedBody,
  type CallBodyPayload,
  type Cited,
  type DemoVoiceId,
  type HostCheck,
  type RoutingView,
} from "./lib/parity";

const USAGE = `usage: npm run parity:check -- [options]

  --pipeline-url URL     the app's configured base (default: VOICE_PIPELINE_URL)
  --service-url URL      the service's own public base (VOICE_PIPELINE_SERVICE_URL)
  --tool-base-url URL    the service's configured app origin (VOICE_PIPELINE_TOOL_BASE_URL)
  --app-origin URL       the app's public origin (VONI_PUBLIC_ORIGIN,
                         then BETTER_AUTH_URL, then VONI_API_URL)
  --sqlite PATH          the service's local routing store (CASCADE_STORE_PATH)
  --database-url DSN     the service's Postgres routing store (DATABASE_URL)
  --python PATH          the interpreter for routing_switch.py (PYTHON, python3)
  --voice ID             a demo voice for the throwaway body (first demo voice)
  --json                 print one machine-readable report

Reads the envelope secret from the environment only. Exits 0 only when every
check passes; the routing switch is read, never flipped.`;

type Options = {
  pipelineUrl: Cited;
  serviceUrl: Cited;
  toolBaseUrl: Cited;
  appOrigin: Cited;
  sqlite: string;
  databaseUrl: string;
  python: string;
  voice: string;
  json: boolean;
};

const FLAGS_WITH_VALUE = new Set([
  "--pipeline-url",
  "--service-url",
  "--tool-base-url",
  "--app-origin",
  "--sqlite",
  "--database-url",
  "--python",
  "--voice",
]);

class UsageError extends Error {}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      flags.set(flag, "");
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      flags.set("--help", "");
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(flag)) {
      throw new UsageError(`unknown option ${JSON.stringify(flag)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}

/** The first non-blank value, and the configuration that supplied it. */
async function resolveCited(
  flag: string,
  flags: Map<string, string>,
  envNames: readonly string[],
): Promise<Cited> {
  const fromFlag = flags.get(flag);
  if (fromFlag !== undefined && fromFlag.trim() !== "") {
    return { value: fromFlag.trim(), source: `flag ${flag}` };
  }
  for (const name of envNames) {
    const value = await secret(name);
    if (value && value.trim() !== "") {
      return { value: value.trim(), source: `env ${name}` };
    }
  }
  const label =
    envNames.length === 1
      ? `flag ${flag} / env ${envNames[0]}`
      : `flag ${flag} / env ${envNames.join(" or ")}`;
  return { value: "", source: label };
}

/** The pipeline base is read through the app's runtime helper, never re-parsed. */
async function resolvePipelineUrl(flags: Map<string, string>): Promise<Cited> {
  const fromFlag = flags.get("--pipeline-url");
  if (fromFlag !== undefined && fromFlag.trim() !== "") {
    return { value: fromFlag.trim(), source: "flag --pipeline-url" };
  }
  const result = await pipelineUrlFromEnv();
  if (result.ok) {
    return { value: result.baseUrl, source: `env ${PIPELINE_URL_ENV}` };
  }
  // Keep the raw value so the checklist names the refusal the app would hit
  // (insecure, invalid or missing) instead of flattening every case to missing.
  const raw = (await secret(PIPELINE_URL_ENV)) ?? "";
  return { value: raw, source: `env ${PIPELINE_URL_ENV}` };
}

async function resolveOptions(flags: Map<string, string>): Promise<Options> {
  return {
    pipelineUrl: await resolvePipelineUrl(flags),
    serviceUrl: await resolveCited("--service-url", flags, [SERVICE_URL_ENV]),
    toolBaseUrl: await resolveCited("--tool-base-url", flags, [TOOL_BASE_URL_ENV]),
    appOrigin: await resolveCited("--app-origin", flags, [
      APP_ORIGIN_ENV,
      ...APP_ORIGIN_FALLBACKS,
    ]),
    sqlite: flags.get("--sqlite") ?? "",
    databaseUrl: flags.get("--database-url") ?? "",
    python: flags.get("--python") ?? process.env.PYTHON ?? "python3",
    voice: flags.get("--voice") ?? DEMO_VOICE_IDS[0],
    json: flags.has("--json"),
  };
}

type DeliverResult = {
  status: number;
  /** The service's machine-readable refusal (`X-Cascade-Refusal`), or null. */
  refusal: string | null;
  /** The human-readable detail; printed as context, never classified. */
  detail: string;
  body: Record<string, unknown>;
};

async function postCallBody(
  serviceBase: string,
  payload: CallBodyPayload,
): Promise<DeliverResult> {
  const url = `${serviceBase.replace(/\/+$/, "")}${CALL_BODY_PATH}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ParityError(
      "deliver-failed",
      `POST ${url} failed before a response: ${(error as Error).message}`,
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const detail = typeof body.detail === "string" ? body.detail : "";
  return {
    status: response.status,
    refusal: response.headers.get(REFUSAL_HEADER),
    detail,
    body,
  };
}

function serviceBaseOf(cited: Cited): string {
  const parsed = parsePublicBase(cited.value, "service-url");
  if (parsed instanceof ParityError) throw parsed;
  return parsed.baseUrl;
}

/** Read the durable switch through the one operator CLI; missing is a failure. */
function readRoutingSwitch(options: Options): { view: RoutingView; store: string } {
  if (!existsSync(ROUTING_SWITCH_PATH)) {
    throw new ParityError(
      "routing-script-missing",
      `${ROUTING_SWITCH_PATH} is not present; run the check from a repository checkout`,
    );
  }
  const args = ["show", "--json"];
  const childEnv = { ...process.env };
  let store: string;
  if (options.sqlite) {
    // One command reads one switch: a flag and an inherited DSN are ambiguous.
    args.push("--sqlite", options.sqlite);
    delete childEnv.DATABASE_URL;
    delete childEnv.CASCADE_STORE_PATH;
    store = `sqlite ${options.sqlite}`;
  } else if (options.databaseUrl) {
    args.push("--database-url", options.databaseUrl);
    store = "postgres (flag --database-url)";
  } else {
    store = process.env.DATABASE_URL
      ? "postgres (env DATABASE_URL)"
      : "none configured";
  }
  const result = spawnSync(options.python, [ROUTING_SWITCH_PATH, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: childEnv,
  });
  if (result.error) {
    throw new ParityError(
      "python-missing",
      `could not run ${options.python} for the routing switch: ${result.error.message}; pass --python or set PYTHON`,
    );
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "").trim();
    throw new ParityError(
      "routing-switch-unreadable",
      `routing_switch.py exited ${result.status}: ${message || "no message"}`,
    );
  }
  return { view: parseRoutingShow(result.stdout), store };
}

type Report = {
  checks: HostCheck[];
  routing?: RoutingView & { store: string };
  accepted?: { callId: string; agentId: string; bodyHash: string };
  refusal?: { status: number; name: string };
};

function check(
  report: Report,
  name: string,
  code: string,
  ok: boolean,
  detail: string,
): void {
  report.checks.push({ name, code, ok, detail });
}

function pass(report: Report, name: string, code: string, detail: string): void {
  check(report, name, code, true, detail);
}

function fail(report: Report, name: string, code: string, detail: string): void {
  check(report, name, code, false, detail);
}

/**
 * Run every check and return the process exit code. Each row's detail cites
 * the configuration that supplied the value, so a failure names the setting
 * to change rather than only the fact.
 */
export async function main(argv: string[]): Promise<number> {
  let flags: Map<string, string>;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`parity-check: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (flags.has("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const options = await resolveOptions(flags);
  const report: Report = {
    checks: evaluateHostParity({
      pipeline: options.pipelineUrl,
      service: options.serviceUrl,
      toolBase: options.toolBaseUrl,
      appOrigin: options.appOrigin,
    }),
  };

  const finish = (): number => {
    const failed = report.checks.filter((entry) => !entry.ok);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: failed.length === 0, ...report }, null, 2)}\n`,
      );
    } else {
      const lines = ["demo-cascade deploy parity (ticket 20)", ""];
      for (const entry of report.checks) {
        const mark = entry.ok ? "PASS" : "FAIL";
        lines.push(`  ${mark}  ${entry.name.padEnd(16)} ${entry.detail}`);
      }
      lines.push("");
      lines.push(
        failed.length === 0
          ? `${report.checks.length} checks, all passed`
          : `${failed.length} of ${report.checks.length} checks failed: ${failed
              .map((entry) => entry.code)
              .join(", ")}`,
      );
      if (failed.length === 0) {
        lines.push(
          "no vendor session and no demo call was opened; the routing switch was read, never flipped",
        );
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return failed.length === 0 ? 0 : 1;
  };

  // Drift is visible before anything is signed: never deliver a body to a
  // deployment the app is not configured to talk to.
  if (report.checks.some((entry) => !entry.ok)) return finish();

  if (!DEMO_VOICE_IDS.includes(options.voice as DemoVoiceId)) {
    fail(
      report,
      "throwaway voice",
      "voice-invalid",
      `"${options.voice}" is not a demo voice; the demo picker is ${DEMO_VOICE_IDS.join(", ")}`,
    );
    return finish();
  }

  const envelopeSecret = await secret(ENVELOPE_SECRET_ENV);
  if (!envelopeSecret) {
    fail(
      report,
      "envelope secret",
      "envelope-secret-missing",
      `${ENVELOPE_SECRET_ENV} is not set; the app signs and the service verifies with the one shared value`,
    );
    return finish();
  }

  let envelopeTtlMs: number;
  let callTokenTtlMs: number;
  try {
    const thresholds = readThresholds();
    envelopeTtlMs = readBound(thresholds, "envelope.ttl_ms");
    callTokenTtlMs = readBound(thresholds, "call_token.ttl_ms");
    pass(
      report,
      "signed bounds",
      "signed-bounds",
      `${THRESHOLDS_PATH}: envelope.ttl_ms=${envelopeTtlMs}, call_token.ttl_ms=${callTokenTtlMs}`,
    );
  } catch (error) {
    const named = error as ParityError;
    fail(report, "signed bounds", named.code ?? "bounds-unreadable", named.message);
    return finish();
  }

  let signed: ReturnType<typeof buildSignedThrowawayBody>;
  try {
    signed = buildSignedThrowawayBody({
      secret: envelopeSecret,
      voiceId: options.voice as DemoVoiceId,
      envelopeTtlMs,
      callTokenTtlMs,
    });
  } catch (error) {
    fail(
      report,
      "throwaway body",
      "sign-failed",
      `${(error as Error).name}: ${(error as Error).message}`,
    );
    return finish();
  }
  pass(
    report,
    "throwaway body",
    "throwaway-body",
    `signed v2 demo body for "${signed.payload.signed_body.envelope.agent_id}" with a random call id "${signed.payload.call_id}"`,
  );

  const base = serviceBaseOf(options.serviceUrl);
  let accepted: DeliverResult;
  try {
    accepted = await postCallBody(base, signed.payload);
  } catch (error) {
    const named = error as ParityError;
    fail(report, "signed body", named.code ?? "deliver-failed", named.message);
    return finish();
  }
  const acceptedName = refusalName(accepted.status, accepted.refusal);
  if (accepted.status !== 202) {
    fail(
      report,
      "signed body",
      "signed-body-refused",
      `POST ${base}${CALL_BODY_PATH} → ${accepted.status} ${acceptedName ?? "unrecognised refusal"}: ${accepted.detail || "(no detail)"}`,
    );
    return finish();
  }
  if (accepted.body.status !== "accepted") {
    fail(
      report,
      "signed body",
      "signed-body-refused",
      `POST ${base}${CALL_BODY_PATH} → 202 without an accepted status: ${JSON.stringify(accepted.body)}`,
    );
    return finish();
  }
  if (accepted.body.body_hash !== signed.acceptedHash) {
    fail(
      report,
      "signed body",
      "accepted-hash-mismatch",
      `the service accepted body hash "${String(accepted.body.body_hash)}" but the app signed "${signed.acceptedHash}"; the two sides disagree on the body bytes`,
    );
    return finish();
  }
  if (
    accepted.body.call_id !== signed.payload.call_id ||
    accepted.body.agent_id !== signed.payload.signed_body.envelope.agent_id
  ) {
    fail(
      report,
      "signed body",
      "accepted-identity-mismatch",
      `the service accepted call "${String(accepted.body.call_id)}" for "${String(accepted.body.agent_id)}"; the app sent "${signed.payload.call_id}" for "${signed.payload.signed_body.envelope.agent_id}"`,
    );
    return finish();
  }
  pass(
    report,
    "signed body",
    "signed-body",
    `POST ${base}${CALL_BODY_PATH} → 202 accepted; call "${signed.payload.call_id}"; body hash ${signed.acceptedHash}`,
  );
  report.accepted = {
    callId: signed.payload.call_id,
    agentId: signed.payload.signed_body.envelope.agent_id,
    bodyHash: signed.acceptedHash,
  };

  const tampered = tamperSignedBody(signed.payload.signed_body);
  const tamperedHash = envelopeBodyHash(tampered.body);
  let refused: DeliverResult;
  try {
    refused = await postCallBody(base, {
      ...signed.payload,
      signed_body: tampered,
    });
  } catch (error) {
    const named = error as ParityError;
    fail(report, "tampered body", named.code ?? "deliver-failed", named.message);
    return finish();
  }
  const refusal = refusalName(refused.status, refused.refusal);
  if (refused.status !== 400 || refusal !== "envelope_refused") {
    fail(
      report,
      "tampered body",
      "tamper-not-refused",
      `POST ${base}${CALL_BODY_PATH} → ${refused.status} ${refusal ?? "unrecognised refusal"}: ${refused.detail || "(no detail)"}; a tampered body must be refused with X-Cascade-Refusal: envelope_refused`,
    );
    return finish();
  }
  pass(
    report,
    "tampered body",
    "tampered-body",
    `POST ${base}${CALL_BODY_PATH} → 400 envelope_refused; signed ${signed.acceptedHash}, tampered ${tamperedHash}`,
  );
  report.refusal = { status: refused.status, name: refusal };

  try {
    const { view, store } = readRoutingSwitch(options);
    report.routing = { ...view, store };
    pass(
      report,
      "routing switch",
      "routing-switch",
      view.missing
        ? `mode "${view.mode}" (no switch stored, fail-safe; store ${store})`
        : `mode "${view.mode}" (recordVersion ${view.recordVersion}; store ${store})`,
    );
  } catch (error) {
    const named = error as ParityError;
    fail(
      report,
      "routing switch",
      named.code ?? "routing-switch-unreadable",
      named.message,
    );
  }
  return finish();
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
