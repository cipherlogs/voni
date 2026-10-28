/**
 * Demo scoreboard orchestrator (ticket 01 skeleton): one command that scores
 * a full Demo call with real audio and writes one JSON artifact plus a
 * console pass/fail table.
 *
 * Single seam at the npm-script level. This file drives the existing runners
 * — it forks none of their logic and invents no transport:
 *   - real-audio eval runner:  npm run eval:demo-agent -- --voice <v> --scenario <s> --runs <n>
 *   - Call trace merger:        npm run call:trace -- <sess_id>        (via --trace-session)
 *   - session evidence exporter: npm run qa:voice-session -- --session <id> --evidence-out <path>
 *   - browser e2e fakes live in tests/e2e/demo-fakes.ts (unchanged here).
 *
 * No gates yet: every gate reports PASS/INFO and the command exits 0 once the
 * artifact is written, even when the eval runner itself fails (its exit code
 * is recorded in the artifact). Non-zero exit means the harness broke:
 * unknown voice, spawn failure, or an unwritable artifact.
 *
 *   npm run scoreboard:demo -- [--gate-voice <demo-voice-id>] [--scenario greeting-cut] [--runs 1]
 *                           [--out scoreboard-runs/score-<ts>-<voice>.json] [--dry-run]
 *                           [--trace-session sess_...]
 *                           [--dead-air-gaps 400,1200] [--longest-silence-ms 16000]
 *                           [--check-in-at-ms 15200] [--check-in-over-caller]
 *
 * --gate-voice picks the gate voice through the shared voice registry
 * (--voice stays an alias); omitting both gates on DEFAULT_GATE_VOICE, never
 * on a literal in this file. New voices deploy as a registry entry plus a
 * regression run: the dry run lists the gate plus the regression set.
 *
 * Dead-air evidence is measured outside the harness (browser e2e fakes,
 * session evidence) and handed in: uncovered silences via --dead-air-gaps,
 * the longest silence stretch via --longest-silence-ms, and check-in timings
 * via --check-in-at-ms (comma-separated atSilenceMs, one per check-in).
 * --check-in-over-caller marks the listed check-ins as overlapping caller
 * speech. Omit all four and the dead-air gate stays INFO (unmeasured, never
 * PASS). The gate never changes the exit code: FAIL is recorded in the
 * artifact plus the console table, exit 0 once the artifact is written.
 *
 * --dry-run skips spawning the runner (no ASSEMBLYAI_API_KEY needed) and
 * records a placeholder eval section. --trace-session merges the Call trace
 * for a finished real-call session into the artifact excerpt.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildSkeletonArtifact,
  DEFAULT_GATE_VOICE,
  formatGateTable,
  formatGoldenScript,
  redactLines,
  resolveGateVoice,
  sha256Hex,
  type DeadAirEvidence,
  type ScoreboardArtifact,
} from "../src/lib/demo/scoreboard";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function runEvalRunner(voice: string, scenario: string, runs: string): { stdout: string; exitCode: number | null; durationMs: number } {
  const started = Date.now();
  const result = spawnSync(
    "npm",
    ["run", "eval:demo-agent", "--", "--voice", voice, "--scenario", scenario, "--runs", runs],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { stdout, exitCode: result.status, durationMs: Date.now() - started };
}

function runCallTrace(sessionId: string): string[] {
  const result = spawnSync("npm", ["run", "call:trace", "--", sessionId], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`call:trace failed for ${sessionId}: ${(result.stderr ?? "").slice(0, 500)}`);
  }
  return redactLines(result.stdout ?? "");
}

/** Comma-separated milliseconds flag; empty means the flag was not given. */
function parseMsList(raw: string, flag: string): number[] {
  if (!raw.trim()) return [];
  const out = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number);
  if (out.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`${flag} needs comma-separated milliseconds >= 0, got "${raw}"`);
  }
  return out;
}

/**
 * Dead-air evidence from CLI flags. Returns undefined when no dead-air flag
 * was given, so the gate stays INFO (unmeasured) instead of claiming PASS.
 */
function parseDeadAirEvidence(input: {
  gaps: string;
  longestSilenceMs: string;
  checkInAtMs: string;
  checkInOverCaller: boolean;
  trace?: string;
}): DeadAirEvidence | undefined {
  const gapsMs = parseMsList(input.gaps, "--dead-air-gaps");
  const checkInAtMs = parseMsList(input.checkInAtMs, "--check-in-at-ms");
  let longestSilenceMs: number | null = null;
  if (input.longestSilenceMs.trim()) {
    longestSilenceMs = Number(input.longestSilenceMs);
    if (!Number.isFinite(longestSilenceMs) || longestSilenceMs < 0) {
      throw new Error(`--longest-silence-ms needs milliseconds >= 0, got "${input.longestSilenceMs}"`);
    }
  }
  if (gapsMs.length === 0 && longestSilenceMs === null && checkInAtMs.length === 0) {
    return undefined;
  }
  return {
    gapsMs,
    longestSilenceMs,
    checkIns: checkInAtMs.map((atSilenceMs) => ({ atSilenceMs, overCaller: input.checkInOverCaller })),
    ...(input.trace ? { trace: input.trace } : {}),
  };
}

function main(): void {
  const voice = resolveGateVoice(arg("--gate-voice", "") || arg("--voice", DEFAULT_GATE_VOICE));
  const scenario = arg("--scenario", "greeting-cut");
  const runs = arg("--runs", "1");
  const dryRun = process.argv.includes("--dry-run");
  const traceSession = arg("--trace-session", "");
  if (traceSession && !/^sess_[A-Za-z0-9_-]+$/.test(traceSession)) {
    throw new Error(`--trace-session needs a session id like sess_abc, got "${traceSession}"`);
  }
  const deadAir = parseDeadAirEvidence({
    gaps: arg("--dead-air-gaps", ""),
    longestSilenceMs: arg("--longest-silence-ms", ""),
    checkInAtMs: arg("--check-in-at-ms", ""),
    checkInOverCaller: process.argv.includes("--check-in-over-caller"),
    trace: traceSession || undefined,
  });

  const evalSection = dryRun
    ? { stdout: "(dry run: eval runner skipped)", exitCode: null as number | null, durationMs: 0 }
    : runEvalRunner(voice, scenario, runs);

  const artifact: ScoreboardArtifact = buildSkeletonArtifact({
    voice,
    scenario,
    runnerStdout: evalSection.stdout,
    exitCode: evalSection.exitCode,
    durationMs: evalSection.durationMs,
    runs: Number(runs) || 1,
    deadAir,
  });
  if (traceSession) {
    const excerpt = runCallTrace(traceSession);
    artifact.callTrace = {
      sessionId: traceSession,
      excerptSha256: sha256Hex(excerpt.join("\n")),
      excerpt: excerpt.slice(0, 120),
    };
  }

  const out = resolve(arg("--out", `scoreboard-runs/score-${stamp()}-${voice}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });

  console.log(formatGoldenScript(voice));
  console.log(formatGateTable(artifact));
  console.log(`artifact: ${out}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
