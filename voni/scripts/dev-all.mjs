#!/usr/bin/env node
// Dev orchestrator: `next dev` + optional cascade + bridge with guaranteed cleanup.
//
//   node scripts/dev-all.mjs [--cascade] [--bridge] [--port 3000]
//
// - app always runs (`npm run dev -- --port <port>` in voni/)
// - --cascade runs voice-pipeline/server.py on :8766 (needs bridge venv + keys)
// - --bridge runs telephony-bot/server.py on :8765 (needs VONI_API_URL etc)
// - Refuses occupied ports, validates env upfront, traps SIGINT/SIGTERM/exit,
//   kills whole process groups (SIGTERM -> SIGKILL) and verifies ports free.
// Pattern follows scripts/e2e-run.mjs: detached groups, waitForPort, teardown.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const voniDir = resolve(here, "..");
const repoDir = resolve(voniDir, "..");
const cascadeDir = resolve(repoDir, "voice-pipeline");
const bridgeDir = resolve(repoDir, "telephony-bot");
const venvPython = resolve(bridgeDir, ".venv/bin/python");

const APP_PORT = Number(process.env.PORT ?? 3000);
const CASCADE_PORT = Number(process.env.VOICE_PIPELINE_PORT ?? 8766);
const BRIDGE_PORT = 8765;

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`usage: node scripts/dev-all.mjs [--cascade] [--bridge] [--port N]
  --cascade  also run voice-pipeline on :8766
  --bridge   also run telephony-bot bridge on :8765 (needs PUBLIC_HOST tunnel)
  --port N   Next dev port (default 3000, or PORT env)`);
  process.exit(0);
}
const wantCascade = args.has("--cascade");
const wantBridge = args.has("--bridge");
const portFlag = process.argv.indexOf("--port");
const appPort = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : APP_PORT;
if (!Number.isInteger(appPort) || appPort <= 0) {
  console.error("[dev-all] --port must be a positive integer");
  process.exit(2);
}

function parseDotFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
    if (k) out[k] = v;
  }
  return out;
}
const devVars = parseDotFile(resolve(voniDir, ".dev.vars"));
const envLocal = parseDotFile(resolve(voniDir, ".env.local"));
const get = (k) => process.env[k] ?? devVars[k] ?? envLocal[k] ?? "";

function requireKeys(keys, label) {
  const missing = keys.filter((k) => !get(k));
  if (missing.length > 0) {
    console.error(`[dev-all] REFUSE: missing ${label}: ${missing.join(", ")}`);
    console.error(`[dev-all] Set them in voni/.dev.vars (see ENVIRONMENT.md).`);
    process.exit(2);
  }
}

// Fail fast before spawning anything.
if (!get("DATABASE_URL")) {
  console.error("[dev-all] REFUSE: DATABASE_URL missing (.env.local per ENVIRONMENT.md).");
  process.exit(2);
}
requireKeys(["BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], "app keys");
if (wantCascade) {
  if (!existsSync(venvPython)) {
    console.error("[dev-all] REFUSE: bridge venv missing at telephony-bot/.venv/bin/python.");
    process.exit(2);
  }
  requireKeys(["ASSEMBLYAI_API_KEY", "AI_GATEWAY_API_KEY", "CARTESIA_API_KEY"], "cascade keys");
}
if (wantBridge) {
  if (!existsSync(venvPython)) {
    console.error("[dev-all] REFUSE: bridge venv missing at telephony-bot/.venv/bin/python.");
    process.exit(2);
  }
  requireKeys(["VONI_API_URL", "VONI_TOOL_SECRET", "PUBLIC_HOST", "DATABASE_URL"], "bridge keys");
}

function portOccupied(port) {
  return new Promise((res) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => { s.end(); res(true); });
    s.on("error", () => res(false));
  });
}
function waitForPort(port, timeoutMs = 90000) {
  const start = Date.now();
  return new Promise((res, rej) => {
    (function poll() {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.end(); res(true); });
      s.on("error", () => {
        if (Date.now() - start > timeoutMs) rej(new Error(`timeout waiting for :${port}`));
        else setTimeout(poll, 500);
      });
    })();
  });
}
async function waitForHealth(url, timeoutMs = 90000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
function tag(prefix, chunk) {
  for (const line of String(chunk).split("\n")) console.log(`[${prefix}] ${line}`);
}
function launch(name, cmd, cmdArgs, opts) {
  console.log(`[dev-all] start ${name}: ${cmd} ${cmdArgs.join(" ")} (cwd=${opts.cwd})`);
  const child = spawn(cmd, cmdArgs, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => tag(name, d));
  child.stderr.on("data", (d) => tag(name, d));
  child.on("exit", (code) => console.log(`[dev-all] ${name} exited (${code ?? "signal"})`));
  children.push({ name, child });
  return child;
}

async function teardown() {
  if (teardown.done) return;
  teardown.done = true;
  console.log("[dev-all] stopping...");
  for (const { child } of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  await sleep(3000);
  for (const { child } of children) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  await sleep(1000);
  for (const [name, port] of [["app", appPort], ...(wantCascade ? [["cascade", CASCADE_PORT]] : []), ...(wantBridge ? [["bridge", BRIDGE_PORT]] : [])]) {
    if (await portOccupied(port)) console.error(`[dev-all] WARN: :${port} still occupied after ${name} stop — kill manually.`);
    else console.log(`[dev-all] :${port} free (${name}).`);
  }
}
teardown.done = false;
process.on("SIGINT", async () => { await teardown(); process.exit(130); });
process.on("SIGTERM", async () => { await teardown(); process.exit(143); });
process.on("exit", () => {
  for (const { child } of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
});

const targets = [["app", appPort], ...(wantCascade ? [["cascade", CASCADE_PORT]] : []), ...(wantBridge ? [["bridge", BRIDGE_PORT]] : [])];
for (const [name, port] of targets) {
  if (await portOccupied(port)) {
    console.error(`[dev-all] REFUSE: :${port} occupied (${name}) — not attaching to unknown server.`);
    process.exit(1);
  }
}

const childEnv = { ...devVars, ...envLocal, ...process.env };
launch("app", "npm", ["run", "dev", "--", "--port", String(appPort)], { cwd: voniDir, env: process.env });
if (wantCascade) {
  launch("cascade", venvPython, ["server.py"], {
    cwd: cascadeDir,
    env: { ...childEnv, VOICE_PIPELINE_PORT: String(CASCADE_PORT) },
  });
}
if (wantBridge) {
  launch("bridge", venvPython, ["server.py"], {
    cwd: bridgeDir,
    env: childEnv,
  });
}

try {
  await waitForPort(appPort);
  console.log(`[dev-all] app up http://localhost:${appPort}`);
  if (wantCascade) {
    await waitForHealth(`http://127.0.0.1:${CASCADE_PORT}/healthz`);
    console.log(`[dev-all] cascade up ws://127.0.0.1:${CASCADE_PORT}/v1/browser-call`);
  }
  if (wantBridge) {
    await waitForPort(BRIDGE_PORT);
    console.log(`[dev-all] bridge up :${BRIDGE_PORT}`);
  }
  console.log("[dev-all] all requested services up. Ctrl-C stops everything.");
} catch (err) {
  console.error(`[dev-all] FAILED: ${err.message}`);
  await teardown();
  process.exit(1);
}
await new Promise(() => {});
