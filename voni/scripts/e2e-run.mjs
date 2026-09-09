#!/usr/bin/env node
// Isolated production-mode test runner (myplan.md Task 4).
// Builds + serves a separate temp copy of the app so the running
// `next dev` server and its `.next` directory are never touched.
//
// Guarantees:
// - temp build dir per run (per candidate/differential)
// - excludes .git/.next/.open-next/local env/browser state/artifacts
// - includes tracked modifications + relevant untracked source files
// - lockfile + `npm ci`
// - source-content fingerprint (HEAD alone insufficient for dirty baseline)
// - owns + cleans up its server process group
// - fails on occupied test port instead of attaching to an unknown server
//
// Ports: 3100 = Next production (`next start`), 3101 = Cloudflare preview.
// Env: VONI_INSTANT_TEST_BUILD=1 only inside the candidate build (ordinary
// builds leave it unset; see next.config.ts).
//
// Modes: instant | behavior | cloudflare | all
// Authenticated fixtures (Task 5) are NOT run here — E2E DB creds unavailable;
// the runner refuses to fall back to ordinary DATABASE_URL.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const mode = process.argv[2] ?? "instant";
const valid = new Set(["instant", "behavior", "cloudflare", "all"]);
if (!valid.has(mode)) {
  console.error(`usage: e2e-run.mjs <${[...valid].join("|")}>`);
  process.exit(2);
}

const NEXT_PORT = 3100;
const CF_PORT = 3101;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  // Throw instead of process.exit so `finally` cleanup (server stop + temp
  // dir removal) always runs. Top-level dispatch maps this to exit code 1.
  if (r.status !== 0) throw new Error(`command failed: ${cmd} ${args.join(" ")}`);
}

function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return (r.stdout ?? "").trim();
}

function portOccupied(port) {
  return new Promise((resolvePort) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => { s.end(); resolvePort(true); });
    s.on("error", () => resolvePort(false));
  });
}

function fingerprint() {
  const head = capture("git", ["rev-parse", "HEAD"], { cwd: appDir });
  const status = capture("git", ["status", "--porcelain=v1"], { cwd: appDir });
  const diff = capture("git", ["diff", "HEAD", "--stat"], { cwd: appDir });
  const h = createHash("sha256").update(head + "\n" + status + "\n" + diff).digest("hex").slice(0, 16);
  return { head, statusLines: status.split("\n").filter(Boolean).length, hash: h };
}

// Relevant untracked source files = app source under src/scripts/tests that
// is part of the current app (Task 1 rule 5). Resolved live from git status
// so new files (e.g. shell-auth.tsx) are never silently left out of the
// candidate. Dotfiles (.env*, .dev.vars) and evidence JSON are excluded.
function untrackedSourceFiles() {
  const out = capture("git", ["status", "--porcelain=v1"], { cwd: appDir });
  return out.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(2).trim().replace(/\/$/, ""))
    // git prints repo-root-relative paths (voni/...) even when cwd is the
    // app dir; strip the prefix back to app-relative.
    .map((p) => (p === "voni" ? "" : p.startsWith("voni/") ? p.slice(5) : p))
    .filter(Boolean)
    .filter((p) => /^(src|scripts|tests)\//.test(p) || p === "playwright.config.ts")
    .filter((p) => !/(^|\/)\./.test(p))
    .filter((p) => !p.endsWith(".json"));
}
function buildCandidate(fp) {
  const dir = mkdtempSync(join(tmpdir(), "voni-e2e-"));
  console.log(`[e2e] candidate dir: ${dir}`);
  console.log(`[e2e] fingerprint: HEAD=${fp.head} files=${fp.statusLines} hash=${fp.hash}`);
  // Tracked files at HEAD + tracked modifications via git archive of worktree?
  // Use `git archive HEAD` for tracked baseline, then overlay worktree diffs
  // for tracked-modified files, then overlay allowlisted untracked source.
  sh("git", ["archive", "HEAD", "voni", "-o", join(dir, "head.tar")], { cwd: resolve(appDir, "..") });
  sh("tar", ["-xf", join(dir, "head.tar"), "-C", dir]);
  const cand = join(dir, "voni");
  // Overlay tracked modifications (worktree version wins).
  const modified = capture("git", ["diff", "--name-only", "HEAD", "--", "voni"], { cwd: resolve(appDir, "..") })
    .split("\n").map((s) => s.trim()).filter(Boolean);
  for (const rel of modified) {
    const repoRel = rel.startsWith("voni/") ? rel.slice(5) : rel;
    const src = join(appDir, repoRel);
    const dst = join(cand, repoRel);
    if (existsSync(src)) {
      cpSync(src, dst, { recursive: true });
    }
  }
  // Mirror tracked deletions (e.g. a removed component): git archive carries
  // HEAD's copy, and the overlay above only adds — so delete these.
  const deleted = capture("git", ["diff", "--name-only", "--diff-filter=D", "HEAD", "--", "voni"], { cwd: resolve(appDir, "..") })
    .split("\n").map((s) => s.trim()).filter(Boolean);
  for (const rel of deleted) {
    const repoRel = rel.startsWith("voni/") ? rel.slice(5) : rel;
    rmSync(join(cand, repoRel), { recursive: true, force: true });
  }
  // Overlay allowlisted untracked source files (resolved live).
  for (const rel of untrackedSourceFiles()) {
    const src = join(appDir, rel);
    const dst = join(cand, rel);
    if (existsSync(src)) cpSync(src, dst, { recursive: true });
  }
  // Our new rig files are untracked-but-required: always include them.
  for (const rel of ["playwright.config.ts", "tests/e2e", "scripts/e2e-run.mjs", "next.config.ts", "package.json", "package-lock.json", "wrangler.preview.jsonc"]) {
    const src = join(appDir, rel);
    const dst = join(cand, rel);
    if (existsSync(src)) cpSync(src, dst, { recursive: true });
  }
  writeFileSync(join(dir, "FINGERPRINT.txt"), `HEAD=${fp.head}\nstatusFiles=${fp.statusLines}\nhash=${fp.hash}\n`);
  return cand;
}

function bootEnv(baseUrl) {
  // Boot-only env for the isolated candidate. Ephemeral test-only
  // BETTER_AUTH_SECRET so Better Auth doesn't abort renders with
  // "using the default secret" (the candidate excludes real local env
  // files by design). NOT session fixtures — Task 5 stays incomplete
  // without real E2E DB creds. Never reads the app's real secrets.
  // DATABASE_URL intentionally unset: src/lib/db falls back to its
  // placeholder and session lookups fail soft to signed-out; if a page
  // hard-errors without a DB, that spec stays red until Task 5 creds exist.
  const secret = `e2e-boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}-0123456789abcdef`;
  return {
    ...process.env,
    VONI_INSTANT_TEST_BUILD: "1",
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: baseUrl,
  };
}

function waitForPort(port, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolveWait, reject) => {
    (function poll() {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.end(); resolveWait(true); });
      s.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting for :${port}`));
        else setTimeout(poll, 500);
      });
    })();
  });
}

async function runPlaywright(cand, baseUrl, specs) {
  const args = ["playwright", "test", "-c", "playwright.config.ts", ...(Array.isArray(specs) ? specs : [specs])];
  const env = { ...process.env, PLAYWRIGHT_BASE_URL: baseUrl };
  console.log(`[e2e] playwright: npx ${args.join(" ")} (baseURL=${baseUrl})`);
  const r = spawnSync("npx", args, { cwd: cand, stdio: "inherit", env });
  if (r.status !== 0) throw new Error(`playwright failed (exit ${r.status ?? 1})`);
}

async function serveNext(cand, port) {
  if (await portOccupied(port)) {
    console.error(`[e2e] REFUSE: port ${port} occupied — not attaching to unknown server.`);
    process.exit(1);
  }
  console.log(`[e2e] npm ci (candidate)…`);
  sh("npm", ["ci", "--no-audit", "--no-fund"], { cwd: cand });
  console.log(`[e2e] next build (VONI_INSTANT_TEST_BUILD=1, ephemeral boot secret)…`);
  sh("npm", ["run", "build"], { cwd: cand, env: bootEnv(`http://localhost:${port}`) });
  const server = spawn("npm", ["run", "start", "--", "-p", String(port)], {
    cwd: cand, stdio: "inherit", detached: true,
    env: { ...bootEnv(`http://localhost:${port}`), PORT: String(port) },
  });
  process.on("exit", () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} });
  process.on("SIGINT", () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} process.exit(130); });
  await waitForPort(port);
  return server;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function teardown(server, candDir) {
  // SIGTERM the whole process group (wrangler orphans workerd grandchildren
  // past a single TERM), escalate to KILL, then remove the temp dir and
  // verify — a leftover dir means the next run inherits stale state.
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
  await sleep(3000);
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
  await sleep(1000);
  rmSync(candDir, { recursive: true, force: true });
  if (existsSync(candDir)) {
    console.error(`[e2e] WARN: temp dir survived cleanup: ${candDir} — remove manually and check for orphaned workerd processes.`);
  }
}

async function modeInstant() {
  const fp = fingerprint();
  const cand = buildCandidate(fp);
  const server = await serveNext(cand, NEXT_PORT);
  try {
    await runPlaywright(cand, `http://localhost:${NEXT_PORT}`, ["tests/e2e/rig-liveness.spec.ts", "tests/e2e/instant-shell.spec.ts"]);
  } finally {
    await teardown(server, dirname(cand));
  }
}

async function modeBehavior() {
  // Unauthenticated behavior regressions only until Task 5 creds exist.
  const fp = fingerprint();
  const cand = buildCandidate(fp);
  const server = await serveNext(cand, NEXT_PORT);
  try {
    await runPlaywright(cand, `http://localhost:${NEXT_PORT}`, "tests/e2e/rig-liveness.spec.ts");
    console.log("[e2e] behavior: authenticated specs deferred — no E2E DB creds (Task 5 blocker recorded in instant-nav.rig.md).");
  } finally {
    await teardown(server, dirname(cand));
  }
}

async function modeCloudflare() {
  const fp = fingerprint();
  const cand = buildCandidate(fp);
  // Workers don't read process.env — wrangler dev loads .dev.vars from cwd.
  // Write an ephemeral boot-only copy into the temp candidate (deleted with
  // it). Never real secrets; Task 5 fixtures still pending.
  const boot = bootEnv(`http://localhost:${CF_PORT}`);
  writeFileSync(
    join(cand, ".dev.vars"),
    `BETTER_AUTH_SECRET=${boot.BETTER_AUTH_SECRET}\nBETTER_AUTH_URL=http://localhost:${CF_PORT}\n`,
  );
  if (await portOccupied(CF_PORT)) {
    console.error(`[e2e] REFUSE: port ${CF_PORT} occupied.`);
    process.exit(1);
  }
  console.log(`[e2e] npm ci (candidate)…`);
  sh("npm", ["ci", "--no-audit", "--no-fund"], { cwd: cand });
  console.log(`[e2e] opennext build…`);
  sh("npx", ["@opennextjs/cloudflare", "build"], { cwd: cand, env: bootEnv(`http://localhost:${CF_PORT}`) });
  // Separate preview config: local R2 emulation, cache bucket isolated from
  // CSV staging, no --remote, no creates. Worker entrypoint retained.
  const server = spawn("npx", ["@opennextjs/cloudflare", "preview", "--port", String(CF_PORT), "--config", "wrangler.preview.jsonc"], {
    cwd: cand, stdio: "inherit", detached: true,
    env: bootEnv(`http://localhost:${CF_PORT}`),
  });
  const cleanup = () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} };
  process.on("exit", cleanup);
  try {
    await waitForPort(CF_PORT, 90000);
    await runPlaywright(cand, `http://localhost:${CF_PORT}`, ["tests/e2e/rig-liveness.spec.ts", "tests/e2e/instant-shell.spec.ts"]);
  } finally {
    await teardown(server, dirname(cand));
  }
}

if (process.env.E2E_DATABASE_URL) {
  console.error("[e2e] REFUSE: E2E_DATABASE_URL must never point at the app DATABASE_URL flow — Task 5 allowlist check lives in fixture setup, not here. Refusing to run with E2E_DATABASE_URL set until Task 5 lands.");
  process.exit(1);
}

try {
  if (mode === "instant") await modeInstant();
  else if (mode === "behavior") await modeBehavior();
  else if (mode === "cloudflare") await modeCloudflare();
  else { await modeInstant(); await modeBehavior(); await modeCloudflare(); }
} catch (err) {
  console.error(`[e2e] FAILED (${mode}): ${err.message}`);
  process.exit(1);
}
console.log(`[e2e] done (${mode}).`);
