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
 *                           [--probe-json probes.json] [--recording <sha256>] [--rate rater:timbre,accent ...]
 *
 * --probe-json carries the session onAudioProbe counts plus the optional
 * qa-voice-session agent-channel PCM analysis; it drives the timbre-probes
 * gate (any clip, pop, jump, underrun, or input-drop FAILs the gate but the
 * artifact is still written). --rate files blind 1-5 human ballots, all
 * bound to --recording; auto timbre checks must pass before ballots count.
 *
 * --gate-voice picks the gate voice through the shared voice registry
 * (--voice stays an alias); omitting both gates on DEFAULT_GATE_VOICE, never
 * on a literal in this file. New voices deploy as a registry entry plus a
 * regression run: the dry run lists the gate plus the regression set.
 *
 * --dry-run skips spawning the runner (no ASSEMBLYAI_API_KEY needed) and
 * records a placeholder eval section. --trace-session merges the Call trace
 * for a finished real-call session into the artifact excerpt.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  addHumanRating,
  buildSkeletonArtifact,
  DEFAULT_GATE_VOICE,
  emptyHumanRatings,
  formatGateTable,
  formatGoldenScript,
  redactLines,
  resolveGateVoice,
  sha256Hex,
  type AgentChannelEvidence,
  type HumanRatings,
  type ScoreboardArtifact,
  type TimbreProbes,
} from "../src/lib/demo/scoreboard";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/** Every value passed to a repeatable flag, in order. */
function argAll(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && i + 1 < process.argv.length) values.push(process.argv[i + 1]);
  }
  return values;
}

/**
 * Session probe counts collected during the golden run
 * (VoiceSession onAudioProbe plus the qa-voice-session agent-channel PCM
 * analysis). Missing counts default to zero; anything negative or
 * non-integer is a harness bug, not a clean run.
 */
function readProbeJson(path: string): { probes: TimbreProbes; agentChannel: AgentChannelEvidence | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`--probe-json ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`--probe-json ${path} must be an object of probe counts`);
  }
  const record = parsed as Record<string, unknown>;
  const probes = {} as TimbreProbes;
  for (const kind of ["jump", "overload", "clip", "underrun", "inputDrop"] as const) {
    const value = record[kind] ?? 0;
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(`--probe-json ${path}: probe count "${kind}" must be a non-negative int, got ${JSON.stringify(value)}`);
    }
    probes[kind] = value as number;
  }
  const rawChannel = record.agentChannel ?? null;
  if (rawChannel === null || rawChannel === undefined) return { probes, agentChannel: null };
  if (typeof rawChannel !== "object") {
    throw new Error(`--probe-json ${path}: agentChannel must be an object or absent`);
  }
  const channel = rawChannel as Record<string, unknown>;
  const agentChannel: AgentChannelEvidence = { peakDbfs: null, clippedSampleRatio: null, largestAdjacentStep: null };
  for (const field of ["peakDbfs", "clippedSampleRatio", "largestAdjacentStep"] as const) {
    const value = channel[field] ?? null;
    if (value !== null && typeof value !== "number") {
      throw new Error(`--probe-json ${path}: agentChannel.${field} must be a number or null`);
    }
    agentChannel[field] = value;
  }
  return { probes, agentChannel };
}

/**
 * File blind ballots from `--rate rater:timbre,accent` (repeatable) against
 * the shared golden recording (`--recording <sha256>`). Ballots without a
 * recording are rejected: unbound ears never count.
 */
function readHumanRatings(rates: string[], recording: string): HumanRatings {
  if (rates.length > 0 && !recording) {
    throw new Error("--rate ballots need --recording <sha256 of the golden recording they judge>");
  }
  if (recording && !/^[0-9a-f]{64}$/i.test(recording)) {
    throw new Error(`--recording needs a sha256 hex digest, got "${recording}"`);
  }
  let slots = emptyHumanRatings(recording || null);
  for (const rate of rates) {
    const match = /^([^:]+):([^,]+),([^,]+)$/.exec(rate.trim());
    if (!match) throw new Error(`--rate needs rater:timbre,accent (ints 1-5), got "${rate}"`);
    slots = addHumanRating(
      slots,
      { rater: match[1].trim(), timbre: Number(match[2]), accent: Number(match[3]) },
      recording,
    );
  }
  return slots;
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

function main(): void {
  const voice = resolveGateVoice(arg("--gate-voice", "") || arg("--voice", DEFAULT_GATE_VOICE));
  const scenario = arg("--scenario", "greeting-cut");
  const runs = arg("--runs", "1");
  const dryRun = process.argv.includes("--dry-run");
  const traceSession = arg("--trace-session", "");
  if (traceSession && !/^sess_[A-Za-z0-9_-]+$/.test(traceSession)) {
    throw new Error(`--trace-session needs a session id like sess_abc, got "${traceSession}"`);
  }

  const evalSection = dryRun
    ? { stdout: "(dry run: eval runner skipped)", exitCode: null as number | null, durationMs: 0 }
    : runEvalRunner(voice, scenario, runs);

  const probePath = arg("--probe-json", "");
  const { probes, agentChannel } = probePath ? readProbeJson(resolve(probePath)) : { probes: undefined, agentChannel: undefined };
  const humanRatings = readHumanRatings(argAll("--rate"), arg("--recording", ""));

  const artifact: ScoreboardArtifact = buildSkeletonArtifact({
    voice,
    scenario,
    runnerStdout: evalSection.stdout,
    exitCode: evalSection.exitCode,
    durationMs: evalSection.durationMs,
    runs: Number(runs) || 1,
    probes,
    agentChannel,
    humanRatings,
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
