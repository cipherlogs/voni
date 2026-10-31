#!/usr/bin/env node
/**
 * One command starts a real local cascade demo (demo-cascade ticket 21).
 *
 *   cd voni && npm run dev:cascade
 *
 * What it starts, and what it reports:
 *   - the pipeline's dedicated Postgres on :5433 (its own data dir, never the
 *     app's database);
 *   - the cascade pipeline on an internal plain port (:8767);
 *   - a TLS/WSS front on :8766, because the app's one runtime pipeline base
 *     must be `https` and the browser derives `wss` from it (ticket 08);
 *   - the app on :3000.
 *
 * It hands the app `VOICE_PIPELINE_URL=https://localhost:8766` and the *same*
 * `VOICE_PIPELINE_ENVELOPE_SECRET` to both sides, so the landing demo connects
 * to the local pipeline with no code edit. A configured secret wins; an absent
 * one is generated for this run (never committed, never a constant).
 *
 * A dependency that is missing or a port that is taken is a named refusal
 * before anything starts. There is no managed fallback and no `http` pipeline
 * base anywhere in this file.
 *
 * Ctrl-C (or SIGTERM) stops every process this command started — including the
 * dedicated Postgres — and verifies the ports are free again.
 */
import { spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ENV,
  PORTS,
  PROCESSES,
  cascadeEnv,
  collectBlockers,
  localAppOrigin,
  localPipelineUrl,
  pipelineDatabaseUrl,
  resolveEnvelopeSecret,
  resolveToolSecret,
  tlsPlan,
} from "./dev-cascade-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const voniDir = resolve(here, "..");
const repoDir = resolve(voniDir, "..");
const pipelineDir = resolve(repoDir, "voice-pipeline");
const pgDataDir = resolve(repoDir, ".dev-postgres", "t21-local");
const pgLogFile = resolve(repoDir, ".dev-postgres", "t21-local.log");
const pgSocketDir = resolve(repoDir, ".dev-postgres", "sockets");

const USAGE = `usage: npm run dev:cascade -- [options]

  --port N            app port (default 3000)
  --database-url DSN  use an already-running Postgres instead of starting the
                      dedicated one on :5433 (that process is not stopped)
  --smoke             also run the key-gated parity delivery check once ready
  --help              this text

Ports, fixed by the ticket: app 3000, pipeline 8766 (https), its Postgres 5433.
The pipeline's plain internal port is 8767 and is never handed to the app.`;

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    "database-url": { type: "string" },
    smoke: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const appPort = values.port === undefined ? PORTS.app : Number(values.port);
if (!Number.isInteger(appPort) || appPort <= 0) {
  console.error("[dev-cascade] REFUSE: --port must be a positive integer.");
  process.exit(2);
}

// The same file Next loads. Missing is fine (CI, fresh clone): the preflight
// below names every value that actually matters.
try {
  process.loadEnvFile(resolve(voniDir, ".env.local"));
} catch {}

const state = {
  children: [],
  stopping: false,
  managedPostgres: false,
  routingMode: "unknown",
  cert: null,
};

function tag(prefix, chunk) {
  for (const line of String(chunk).split("\n")) {
    if (line.trim() !== "") console.log(`[${prefix}] ${line}`);
  }
}

function launch(name, command, args, options) {
  if (state.stopping) return null;
  console.log(
    `[dev-cascade] start ${name}: ${command} ${args.join(" ")} (cwd=${options.cwd})`,
  );
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => tag(name, chunk));
  child.stderr.on("data", (chunk) => tag(name, chunk));
  child.on("exit", (code, signal) => {
    if (state.stopping) return;
    fail(`${name} exited before the cascade was stopped (${code ?? signal})`);
  });
  state.children.push({ name, child, port: options.port });
  return child;
}

async function fail(message) {
  if (state.stopping) return;
  state.stopping = true;
  console.error(`\n[dev-cascade] FAILED: ${message}`);
  await teardown();
  process.exit(1);
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function portOccupied(port) {
  return new Promise((resolvePromise) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.end();
      resolvePromise(true);
    });
    socket.on("error", () => resolvePromise(false));
  });
}

async function waitForPort(port, timeoutMs = 90_000) {
  const start = Date.now();
  for (;;) {
    if (await portOccupied(port)) return true;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for :${port}`);
    }
    await sleep(400);
  }
}

async function waitForHttp(url, { timeoutMs = 90_000, label = url, ca } = {}) {
  const start = Date.now();
  let lastError = "";
  for (;;) {
    try {
      const status = await httpStatus(url, ca);
      if (status >= 200 && status < 400) return true;
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error.message;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${label} (${lastError})`);
    }
    await sleep(1000);
  }
}

/** GET a URL; `ca` verifies the local dev certificate instead of disabling TLS. */
function httpStatus(url, ca) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(
      url,
      { ca, servername: parsed.hostname, timeout: 4000 },
      (response) => {
        response.resume();
        resolvePromise(response.statusCode ?? 0);
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", rejectPromise);
  });
}

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error;
}

function probePython(candidate) {
  const code =
    'import importlib.util as u; print(",".join(m for m in ("fastapi","uvicorn","websockets","asyncpg") if u.find_spec(m) is None))';
  const result = spawnSync(candidate, ["-c", code], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { ok: false, path: candidate, missingModules: [] };
  }
  const missing = (result.stdout ?? "").trim().split(",").filter(Boolean);
  return { ok: missing.length === 0, path: candidate, missingModules: missing };
}

/** The first interpreter with the pipeline deps; the reason is reported if none. */
function resolvePython() {
  const candidates = [
    process.env.CASCADE_PYTHON,
    resolve(repoDir, "telephony-bot/.venv/bin/python"),
    resolve(repoDir, ".venv/bin/python"),
    "python3",
    "python",
  ].filter(Boolean);

  let closest = { ok: false, path: "", missingModules: [] };
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const probe = probePython(candidate);
    if (probe.ok) return probe;
    if (probe.missingModules.length > 0) closest = probe;
  }
  return closest;
}

function certStillValid(certPath) {
  try {
    const certificate = new X509Certificate(readFileSync(certPath));
    const expires = new Date(certificate.validTo).getTime();
    return expires - Date.now() > 7 * 86_400_000;
  } catch {
    return false;
  }
}

function ensureCertificate({ generate = true, log = true } = {}) {
  const plan = tlsPlan({
    env: process.env,
    fileExists: existsSync,
    opensslAvailable: hasCommand("openssl"),
  });
  if (!plan.ok) return plan;

  if (plan.source === "env") return plan;
  if (plan.certPath === undefined || plan.keyPath === undefined) return plan;

  if (certStillValid(plan.certPath) && existsSync(plan.keyPath)) {
    if (log) console.log(`[dev-cascade] local TLS: reusing ${plan.certPath}`);
    return plan;
  }
  if (!generate) return plan;

  mkdirSync(dirname(plan.certPath), { recursive: true });
  console.log(`[dev-cascade] local TLS: generating ${plan.certPath}`);
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      plan.keyPath,
      "-out",
      plan.certPath,
      "-days",
      "90",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      blocker: `openssl could not create the dev cert at ${plan.certPath}: ${(result.stderr ?? "").trim()}`,
    };
  }
  chmodSync(plan.keyPath, 0o600);
  return plan;
}

/** The port a Postgres DSN points at, for readiness only. */
function databasePort(dsn) {
  try {
    const parsed = new URL(dsn);
    return Number(parsed.port || 5432);
  } catch {
    return PORTS.postgres;
  }
}

function runOrFail(command, args, options, description) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`${description} failed: ${detail}`);
  }
  return result;
}

function postgresAlreadyRunning() {
  if (!existsSync(pgDataDir)) return false;
  const result = spawnSync("pg_ctl", ["-D", pgDataDir, "status"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function startManagedPostgres() {
  mkdirSync(dirname(pgDataDir), { recursive: true });

  if (!existsSync(resolve(pgDataDir, "PG_VERSION"))) {
    console.log("[dev-cascade] initialising the dedicated cascade Postgres");
    runOrFail(
      "initdb",
      ["-D", pgDataDir, "-U", "voni", "-A", "trust", "--no-locale", "-E", "UTF8"],
      { encoding: "utf8" },
      "initdb",
    );
  }

  if (!postgresAlreadyRunning()) {
    mkdirSync(pgSocketDir, { recursive: true });
    console.log(`[dev-cascade] starting the dedicated cascade Postgres on :${PORTS.postgres}`);
    const started = spawnSync(
      "pg_ctl",
      [
        "-D",
        pgDataDir,
        "-l",
        pgLogFile,
        "-o",
        `-p ${PORTS.postgres} -h 127.0.0.1 -k ${pgSocketDir}`,
        "-w",
        "start",
      ],
      { encoding: "utf8" },
    );
    if (started.status !== 0) {
      let logTail = "";
      try {
        logTail = readFileSync(pgLogFile, "utf8").trim().split("\n").slice(-6).join("\n");
      } catch {}
      // A failed start must name the server's own reason, not an empty stderr;
      // pg_ctl sends the postmaster's output to the log file.
      throw new Error(
        `pg_ctl start failed${logTail ? `:\n${logTail}` : `: ${(started.stderr ?? "").trim()}`}`,
      );
    }
    state.managedPostgres = true;
  } else {
    console.log("[dev-cascade] reusing the Postgres already running from the cascade data dir");
  }

  const created = spawnSync(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(PORTS.postgres), "-U", "voni", "voni_pipeline"],
    { encoding: "utf8" },
  );
  if (created.status !== 0 && !/already exists/i.test(created.stderr ?? "")) {
    throw new Error(`createdb failed: ${(created.stderr ?? "").trim()}`);
  }
}

function stopManagedPostgres() {
  if (!state.managedPostgres) return;
  console.log("[dev-cascade] stopping the dedicated cascade Postgres");
  spawnSync("pg_ctl", ["-D", pgDataDir, "-m", "fast", "-w", "-t", "20", "stop"], {
    stdio: "ignore",
  });
  state.managedPostgres = false;
}

/** Read the durable routing switch, then make local calls eligible exactly once. */
function ensureRoutingDemo(python, databaseUrl) {
  const env = { ...process.env, [ENV.databaseUrl]: databaseUrl };
  const show = spawnSync(
    python,
    ["scripts/routing_switch.py", "show", "--database-url", databaseUrl, "--json"],
    { cwd: pipelineDir, env, encoding: "utf8" },
  );
  if (show.status !== 0) {
    throw new Error(
      `routing switch is unreadable: ${(show.stderr || show.stdout || "").trim()}`,
    );
  }
  const view = JSON.parse(show.stdout);
  if (view.mode === "demo") {
    console.log("[dev-cascade] routing switch: demo (already)");
    return "demo";
  }

  // A local store starts at the fail-safe `off`, which refuses every new call.
  // Setting the local switch is part of bringing the demo up; production's
  // switch is ticket 25's business.
  console.log(`[dev-cascade] routing switch: ${view.mode} -> demo (local store)`);
  const flipped = spawnSync(
    python,
    [
      "scripts/routing_switch.py",
      "set",
      "--mode",
      "demo",
      "--operator",
      "dev-cascade (ticket 21)",
      "--reason",
      "one-command local cascade",
      "--database-url",
      databaseUrl,
      "--json",
    ],
    { cwd: pipelineDir, env, encoding: "utf8" },
  );
  if (flipped.status !== 0) {
    throw new Error(
      `routing switch could not be set to demo: ${(flipped.stderr || flipped.stdout || "").trim()}`,
    );
  }
  return "demo";
}

async function teardown() {
  const children = state.children.splice(0);
  for (const { child } of children.reverse()) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await sleep(1500);
  for (const { child } of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  const ownedPostgres = state.managedPostgres;
  stopManagedPostgres();

  for (const process_ of PROCESSES) {
    // An external (or pre-existing) Postgres is not ours to stop or to claim
    // is free; only a postmaster this command started is verified.
    if (process_.name === "postgres" && !ownedPostgres) continue;
    const port = process_.name === "app" ? appPort : process_.port;
    let free = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await portOccupied(port))) {
        free = true;
        break;
      }
      await sleep(250);
    }
    if (free) {
      console.log(`[dev-cascade] :${port} free (${process_.name})`);
    } else {
      console.error(
        `[dev-cascade] WARN: :${port} still occupied after ${process_.name} stop — kill it manually.`,
      );
    }
  }
}

function stopAndExit(code) {
  if (state.stopping) return;
  state.stopping = true;
  console.log("\n[dev-cascade] stopping every process this command started...");
  teardown().finally(() => process.exit(code));
}

process.on("SIGINT", () => stopAndExit(130));
process.on("SIGTERM", () => stopAndExit(143));
process.on("SIGHUP", () => stopAndExit(129));
process.on("exit", () => {
  // Last resort: the async teardown cannot run from `exit`.
  for (const { child } of state.children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  stopManagedPostgres();
});

async function main() {
  const envelopeSecret = resolveEnvelopeSecret(process.env[ENV.envelopeSecret]);
  const toolSecret = resolveToolSecret(process.env[ENV.toolSecret]);
  const generatedEnvelope = !(process.env[ENV.envelopeSecret] ?? "").trim();
  const generatedTool = !(process.env[ENV.toolSecret] ?? "").trim();

  const certificatePlan = ensureCertificate({ generate: false, log: false });
  const python = resolvePython();
  const externalDatabaseUrl =
    values["database-url"] ?? process.env.CASCADE_DATABASE_URL ?? "";

  // An external DSN means the caller owns that Postgres; it is not stopped and
  // its port is not checked for occupation.
  const managedPostgres = !externalDatabaseUrl;
  const databaseUrl = externalDatabaseUrl || pipelineDatabaseUrl();

  const occupied = [];
  for (const [name, port] of [
    ["app", appPort],
    ["pipeline", PORTS.pipelineInternal],
    ["pipeline-tls", PORTS.pipeline],
  ]) {
    if (await portOccupied(port)) occupied.push(`:${port} (${name})`);
  }
  if (
    managedPostgres &&
    !postgresAlreadyRunning() &&
    (await portOccupied(PORTS.postgres))
  ) {
    occupied.push(`:${PORTS.postgres} (postgres)`);
  }

  const blockers = collectBlockers({
    env: process.env,
    python,
    occupied,
    cert: certificatePlan,
  });
  if (blockers.length > 0) {
    console.error("[dev-cascade] REFUSE: nothing was started.");
    for (const blocker of blockers) console.error(`  - ${blocker}`);
    console.error(
      "[dev-cascade] No managed fallback is attempted: the demo fails here, by name.",
    );
    process.exit(2);
  }

  const certificate = ensureCertificate({ generate: true });
  if (!certificate.ok) {
    await fail(certificate.blocker);
  }

  if (!hasCommand("initdb") || !hasCommand("pg_ctl") || !hasCommand("createdb")) {
    if (!externalDatabaseUrl) {
      await fail(
        "no local Postgres tooling (initdb, pg_ctl, createdb) on PATH. Install Postgres, or pass --database-url to an already-running server. The cascade service will not run without its store.",
      );
    }
  }

  const { app: appEnv, pipeline: pipelineEnv } = cascadeEnv({
    appPort,
    pipelinePort: PORTS.pipeline,
    pipelineInternalPort: PORTS.pipelineInternal,
    databaseUrl,
    envelopeSecret,
    toolSecret,
  });

  console.log("[dev-cascade] plan");
  console.log(`  app            :${appPort}  ${ENV.pipelineUrl}=${appEnv[ENV.pipelineUrl]}`);
  console.log(`  pipeline       :${PORTS.pipelineInternal}  (plain, internal only)`);
  console.log(`  pipeline-tls   :${PORTS.pipeline}  https://localhost:${PORTS.pipeline}`);
  console.log(
    `  postgres       :${PORTS.postgres}  ${externalDatabaseUrl ? "external (not stopped)" : "dedicated (stopped on exit)"}`,
  );
  console.log(
    `  envelope secret  ${generatedEnvelope ? "generated for this run" : "from .env.local"} — same value on both sides`,
  );
  console.log(
    `  tool secret      ${generatedTool ? "generated for this run" : "from .env.local"} — same value on both sides`,
  );

  // 1. The store.
  if (externalDatabaseUrl) {
    console.log("[dev-cascade] using the supplied cascade Postgres");
  } else {
    try {
      startManagedPostgres();
    } catch (error) {
      await fail(error.message);
    }
  }
  try {
    await waitForPort(databasePort(databaseUrl), 60_000);
  } catch (error) {
    await fail(error.message);
  }

  // 2. The pipeline, on its internal port.
  launch("pipeline", python.path, ["server.py"], {
    cwd: pipelineDir,
    env: { ...process.env, ...pipelineEnv },
    port: PORTS.pipelineInternal,
  });
  try {
    await waitForPort(PORTS.pipelineInternal, 60_000);
    await waitForHttp(`http://127.0.0.1:${PORTS.pipelineInternal}/healthz`, {
      label: "pipeline /healthz",
    });
    await waitForHttp(`http://127.0.0.1:${PORTS.pipelineInternal}/readyz`, {
      timeoutMs: 60_000,
      label: "pipeline /readyz (durable store)",
    });
  } catch (error) {
    await fail(error.message);
  }

  // 3. The local routing switch: a local store starts fail-safe `off`.
  try {
    state.routingMode = ensureRoutingDemo(python.path, databaseUrl);
  } catch (error) {
    await fail(error.message);
  }

  // 4. The https front the app's one runtime URL points at.
  launch(
    "pipeline-tls",
    process.execPath,
    [
      resolve(here, "pipeline-tls-front.mjs"),
      "--listen",
      String(PORTS.pipeline),
      "--target",
      String(PORTS.pipelineInternal),
      "--cert",
      certificate.certPath,
      "--key",
      certificate.keyPath,
    ],
    { cwd: voniDir, env: process.env, port: PORTS.pipeline },
  );
  try {
    await waitForPort(PORTS.pipeline, 30_000);
    await waitForHttp(`https://localhost:${PORTS.pipeline}/healthz`, {
      ca: readFileSync(certificate.certPath),
      label: "https pipeline /healthz",
    });
  } catch (error) {
    await fail(error.message);
  }

  // 5. The app, pointed at that one https base and trusting the local cert.
  launch(
    "app",
    "npm",
    ["run", "dev", "--", "--port", String(appPort)],
    {
      cwd: voniDir,
      env: {
        ...process.env,
        ...appEnv,
        NODE_EXTRA_CA_CERTS: certificate.certPath,
      },
      port: appPort,
    },
  );
  try {
    await waitForPort(appPort, 180_000);
    await waitForHttp(`http://127.0.0.1:${appPort}/`, {
      timeoutMs: 240_000,
      label: "app /",
    });
  } catch (error) {
    await fail(error.message);
  }

  // 6. Config parity: the app's URL is https, both sides share one secret, and
  // the service calls tools back at the app origin. Any mismatch is fatal.
  const checks = [
    [
      "app pipeline base is https",
      appEnv[ENV.pipelineUrl] === localPipelineUrl(PORTS.pipeline),
      appEnv[ENV.pipelineUrl],
    ],
    [
      "one envelope secret on both sides",
      appEnv[ENV.envelopeSecret] === pipelineEnv[ENV.envelopeSecret] &&
        appEnv[ENV.envelopeSecret].length > 0,
      "shared",
    ],
    [
      "service tool base is the app origin",
      pipelineEnv[ENV.toolBaseUrl] === localAppOrigin(appPort),
      pipelineEnv[ENV.toolBaseUrl],
    ],
    [
      "no build-time pipeline URL",
      !Object.keys(appEnv).some((name) => name.startsWith("NEXT_PUBLIC_")),
      "none",
    ],
    [
      "https endpoint answers with the local cert",
      true,
      "verified",
    ],
  ];
  const mismatched = checks.filter(([, ok]) => !ok);
  if (mismatched.length > 0) {
    await fail(
      `config parity failed: ${mismatched.map(([label]) => label).join(", ")}`,
    );
  }

  console.log("\n[dev-cascade] READY");
  for (const process_ of PROCESSES) {
    const port = process_.name === "app" ? appPort : process_.port;
    console.log(`  ${process_.name.padEnd(14)} :${port}  ${process_.label}`);
  }
  console.log("  config parity");
  for (const [label, ok, detail] of checks) {
    console.log(`    ${ok ? "ok" : "FAIL"}  ${label}  ${detail}`);
  }
  console.log(`  routing switch ${state.routingMode}`);
  console.log(
    `  browser wss    wss://localhost:${PORTS.pipeline}/v1/browser-call (derived from the https base)`,
  );
  console.log(`\n  open http://localhost:${appPort} — landing demo`);
  console.log(
    `  first time only: open https://localhost:${PORTS.pipeline}/healthz and accept the local certificate`,
  );
  console.log(
    `  call trace: ${resolve(pipelineDir, ".events")}/<call id>.jsonl — one file per call, keyed by call id`,
  );
  console.log("\n  manual acceptance:");
  console.log("    1. open the landing demo and start a call with a voice");
  console.log("    2. hear the greeting in the voice's language");
  console.log("    3. speak: hear a reply and see the email tool call with its test tag");
  console.log("    4. say goodbye: the call ends (hang-up), not a managed fallback");
  console.log(
    "\n  automated delivery parity (no vendor session): npm run dev:cascade -- --smoke",
  );
  console.log("  Ctrl-C stops every process this command started.\n");

  if (values.smoke) {
    console.log("[dev-cascade] running the key-gated parity delivery check...");
    const smoke = spawnSync(
      "npm",
      [
        "run",
        "parity:check",
        "--",
        "--pipeline-url",
        appEnv[ENV.pipelineUrl],
        "--service-url",
        `https://localhost:${PORTS.pipeline}`,
        "--tool-base-url",
        localAppOrigin(appPort),
        "--app-origin",
        localAppOrigin(appPort),
        "--database-url",
        databaseUrl,
        "--python",
        python.path,
      ],
      {
        cwd: voniDir,
        env: {
          ...process.env,
          ...appEnv,
          NODE_EXTRA_CA_CERTS: certificate.certPath,
        },
        stdio: "inherit",
      },
    );
    if (smoke.status !== 0) {
      await fail("the parity delivery smoke check failed (see the report above)");
    }
    console.log("[dev-cascade] smoke: app and service agree on the signed body.");
  }

  await new Promise(() => {});
}

main().catch((error) => fail(error.message ?? String(error)));
