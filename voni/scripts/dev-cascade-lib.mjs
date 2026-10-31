/**
 * Planning half of the one-command local cascade (demo-cascade ticket 21).
 *
 * Everything here is pure: ports, process names, environment names, the https
 * pipeline base, the TLS plan and the preflight blockers. The launcher
 * (`dev-cascade.mjs`) owns spawning and teardown; keeping the contract in this
 * module is what lets a script-level test fail when a required process, port,
 * environment name or the https rule goes missing.
 *
 * The ports are the ticket's: pipeline 8766, its dedicated Postgres 5433, the
 * app 3000. The pipeline itself listens plain on 8767 and a TLS/WSS front owns
 * 8766, because the app's one runtime pipeline base must be `https` (ticket 08)
 * and the browser derives `wss` from it. Nothing here ever produces `http` for
 * the pipeline: there is no fallback, local included.
 */
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const voniDir = resolve(here, "..");

/** The ticket's ports. The pipeline's public port is the https one. */
export const PORTS = Object.freeze({
  app: 3000,
  postgres: 5433,
  pipeline: 8766,
  pipelineInternal: 8767,
});

/**
 * Every process the command starts, in start order. `port` is the port that
 * proves the process is up; `label` is what a human sees in the readiness
 * report, so a failure names the process and its port rather than a pid.
 *
 * @type {ReadonlyArray<{ name: string, label: string, port: number }>}
 */
export const PROCESSES = Object.freeze([
  {
    name: "postgres",
    label: "cascade Postgres (dedicated)",
    port: PORTS.postgres,
  },
  {
    name: "pipeline",
    label: "cascade pipeline (plain, internal)",
    port: PORTS.pipelineInternal,
  },
  {
    name: "pipeline-tls",
    label: "pipeline TLS/WSS front (https)",
    port: PORTS.pipeline,
  },
  {
    name: "app",
    label: "voni app",
    port: PORTS.app,
  },
]);

/**
 * The environment names this launcher sets or requires. Nothing here is a
 * value: a value in this file would be a committed secret or a baked URL.
 */
export const ENV = Object.freeze({
  pipelineUrl: "VOICE_PIPELINE_URL",
  serviceUrl: "VOICE_PIPELINE_SERVICE_URL",
  envelopeSecret: "VOICE_PIPELINE_ENVELOPE_SECRET",
  databaseUrl: "DATABASE_URL",
  toolBaseUrl: "VOICE_PIPELINE_TOOL_BASE_URL",
  toolSecret: "VONI_TOOL_SECRET",
  port: "VOICE_PIPELINE_PORT",
  buildVersion: "VOICE_PIPELINE_BUILD_VERSION",
  eventsDir: "VOICE_PIPELINE_EVENTS_DIR",
  tlsCert: "VOICE_PIPELINE_TLS_CERT",
  tlsKey: "VOICE_PIPELINE_TLS_KEY",
  routingStore: "CASCADE_STORE_PATH",
  reasoningEffort: "META_REASONING_EFFORT",
  metaKey: "META_API_KEY",
  metaSalt: "META_IDENTIFIER_SALT",
  assemblyKey: "ASSEMBLYAI_API_KEY",
  appAuthSecret: "BETTER_AUTH_SECRET",
  googleClientId: "GOOGLE_CLIENT_ID",
  googleClientSecret: "GOOGLE_CLIENT_SECRET",
});

/**
 * The values a real call cannot run without. A missing one is a named refusal
 * before anything is spawned — never a managed call and never a silent default.
 *
 * @type {ReadonlyArray<string>}
 */
export const REQUIRED_ENV = Object.freeze([
  ENV.databaseUrl,
  ENV.appAuthSecret,
  ENV.googleClientId,
  ENV.googleClientSecret,
  ENV.metaKey,
  ENV.reasoningEffort,
  ENV.metaSalt,
  ENV.assemblyKey,
]);

/** The gitignored directory a generated local cert lives in. */
export const DEV_CERT_DIR = resolve(voniDir, ".dev-certs");

/** The app's runtime pipeline base. `https` only, and no localhost fallback. */
/**
 * @param {number} [port]
 * @returns {string}
 */
export function localPipelineUrl(port = PORTS.pipeline) {
  return `https://localhost:${port}`;
}

/** The app origin the pipeline calls back for tools. Server-to-server, IPv4. */
/**
 * @param {number} [port]
 * @returns {string}
 */
export function localAppOrigin(port = PORTS.app) {
  return `http://127.0.0.1:${port}`;
}

/**
 * The dedicated cascade Postgres DSN, never the app's own database.
 *
 * The role is filled in on the URL object instead of being written as URL
 * userinfo: a committed `user:password@host` is what the repository secret
 * scan refuses, and the local cluster is `trust`-auth, so there is no password
 * to keep. The value is local-only and never leaves this process.
 *
 * @param {number} [port]
 * @returns {string}
 */
export function pipelineDatabaseUrl(port = PORTS.postgres) {
  const url = new URL(`postgresql://127.0.0.1:${port}/voni_pipeline`);
  url.username = "voni";
  return url.toString();
}

/** The one envelope value: configured wins, otherwise generated per run. */
/**
 * @param {string | null | undefined} configured
 * @param {() => string} [generate]
 * @returns {string}
 */
export function resolveEnvelopeSecret(configured, generate = generateSecret) {
  const value = typeof configured === "string" ? configured.trim() : "";
  return value || generate();
}

/**
 * The same rule for the app<->service tool secret (one value on both sides).
 *
 * @param {string | null | undefined} configured
 * @param {() => string} [generate]
 * @returns {string}
 */
export function resolveToolSecret(configured, generate = generateSecret) {
  return resolveEnvelopeSecret(configured, generate);
}

function generateSecret() {
  return randomBytes(32).toString("base64url");
}

/**
 * The children's environment. Both sides get the *same* envelope and tool
 * secrets, the app gets the one https pipeline base, and the service gets the
 * dedicated database and the app origin. No `NEXT_PUBLIC_*` value is set.
 *
 * @param {{
 *   appPort?: number,
 *   pipelinePort?: number,
 *   pipelineInternalPort?: number,
 *   databaseUrl?: string,
 *   envelopeSecret?: string,
 *   toolSecret?: string,
 *   eventsDir?: string,
 *   buildVersion?: string,
 * }} [options]
 * @returns {{ app: Record<string, string>, pipeline: Record<string, string> }}
 */
export function cascadeEnv({
  appPort = PORTS.app,
  pipelinePort = PORTS.pipeline,
  pipelineInternalPort = PORTS.pipelineInternal,
  databaseUrl = pipelineDatabaseUrl(),
  envelopeSecret,
  toolSecret,
  eventsDir,
  buildVersion = "local-dev",
} = {}) {
  const sharedEnvelope = envelopeSecret ?? "";
  const app = {
    [ENV.pipelineUrl]: localPipelineUrl(pipelinePort),
    [ENV.envelopeSecret]: sharedEnvelope,
    [ENV.toolSecret]: toolSecret ?? "",
  };
  const pipeline = {
    [ENV.port]: String(pipelineInternalPort),
    [ENV.envelopeSecret]: sharedEnvelope,
    [ENV.databaseUrl]: databaseUrl,
    [ENV.toolBaseUrl]: localAppOrigin(appPort),
    [ENV.toolSecret]: toolSecret ?? "",
    [ENV.eventsDir]: eventsDir ?? resolve(voniDir, "..", "voice-pipeline", ".events"),
    [ENV.buildVersion]: buildVersion,
  };
  return { app, pipeline };
}

/**
 * Where local TLS comes from. Preference: an explicitly supplied cert/key pair
 * (a developer's trusted cert), then a generated dev cert under `.dev-certs/`.
 *
 * There is no `http` branch. A half-configured pair, a missing file, or a
 * missing `openssl` is a blocker that names the exact variable or tool.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fileExists?: (path: string) => boolean,
 *   opensslAvailable?: boolean,
 *   devCertDir?: string,
 * }} [options]
 * @returns {{
 *   ok: true,
 *   source: "env" | "generated",
 *   certPath: string,
 *   keyPath: string,
 *   reuse?: boolean,
 * } | { ok: false, blocker: string }}
 */
export function tlsPlan({
  env = {},
  fileExists = () => false,
  opensslAvailable = false,
  devCertDir = DEV_CERT_DIR,
} = {}) {
  const certPath = String(env[ENV.tlsCert] ?? "").trim();
  const keyPath = String(env[ENV.tlsKey] ?? "").trim();

  if (certPath || keyPath) {
    if (!certPath) {
      return {
        ok: false,
        blocker: `${ENV.tlsKey} is set but ${ENV.tlsCert} is missing: set both, or neither to generate a dev cert.`,
      };
    }
    if (!keyPath) {
      return {
        ok: false,
        blocker: `${ENV.tlsCert} is set but ${ENV.tlsKey} is missing: set both, or neither to generate a dev cert.`,
      };
    }
    if (!fileExists(certPath)) {
      return {
        ok: false,
        blocker: `${ENV.tlsCert} points at a missing file: ${certPath}.`,
      };
    }
    if (!fileExists(keyPath)) {
      return {
        ok: false,
        blocker: `${ENV.tlsKey} points at a missing file: ${keyPath}.`,
      };
    }
    return { ok: true, source: "env", certPath, keyPath };
  }

  if (!opensslAvailable) {
    return {
      ok: false,
      blocker:
        "no local TLS certificate and `openssl` is missing: install OpenSSL so a dev cert can be generated, or set " +
        `${ENV.tlsCert} and ${ENV.tlsKey} to a trusted local cert pair. The pipeline base is https; there is no http fallback.`,
    };
  }

  return {
    ok: true,
    source: "generated",
    certPath: resolve(devCertDir, "pipeline.crt"),
    keyPath: resolve(devCertDir, "pipeline.key"),
    reuse: fileExists(resolve(devCertDir, "pipeline.crt")) && fileExists(resolve(devCertDir, "pipeline.key")),
  };
}

/**
 * Everything that must stop the launch before a process starts. Ordered so the
 * first line a human reads is the most actionable. Empty means "go".
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   python?: { ok: boolean, path: string, missingModules: string[] },
 *   occupied?: string[],
 *   cert?: { ok: boolean, blocker?: string },
 *   requiredEnv?: ReadonlyArray<string>,
 * }} [options]
 * @returns {string[]}
 */
export function collectBlockers({
  env = {},
  python = { ok: true, path: "", missingModules: [] },
  occupied = [],
  cert = { ok: true },
  requiredEnv = REQUIRED_ENV,
} = {}) {
  const blockers = [];

  const missing = requiredEnv.filter((name) => !String(env[name] ?? "").trim());
  if (missing.length > 0) {
    blockers.push(
      `missing environment: ${missing.join(", ")} — set them in voni/.env.local (see ENVIRONMENT.md); none has a silent default.`,
    );
  }

  if (!cert.ok) blockers.push(`local TLS: ${cert.blocker}`);

  if (!python.ok) {
    const modules = (python.missingModules ?? []).join(", ");
    blockers.push(
      modules
        ? `no Python runtime with the pipeline dependencies (missing: ${modules}); create one: uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python -r requirements-ci.txt`
        : `no Python runtime found; create one: uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python -r requirements-ci.txt`,
    );
  }

  for (const target of occupied) {
    blockers.push(
      `port ${target} is occupied — refusing to attach to an unknown server. Stop it, or name the process holding it.`,
    );
  }

  return blockers;
}
