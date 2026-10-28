/**
 * Demo scoreboard orchestrator: one command that scores a full Demo call
 * with real audio and writes one JSON artifact plus a console pass/fail
 * table.
 *
 * Single seam at the npm-script level. This file drives the existing runners
 * — it forks none of their logic and invents no transport:
 *   - real-audio eval runner:  npm run eval:demo-agent -- --voice <v> --scenario <s> --runs <n>
 *   - Call trace merger:        npm run call:trace -- <sess_id>        (via --trace-session)
 *   - session evidence exporter: npm run qa:voice-session -- --session <id> --evidence-out <path>
 *   - browser e2e fakes live in tests/e2e/demo-fakes.ts (unchanged here).
 *
 * Gates: the reply-gap and end-of-turn gates fail the command (exit 1) when
 * measured evidence breaches the budget, so regressions never merge
 * silently. Without measured gaps both stay INFO and the command exits 0
 * once the artifact is written, even when the eval runner itself fails (its
 * exit code is recorded in the artifact). Non-zero exit otherwise means the
 * harness broke: unknown voice, bad --gap flag, spawn failure, or an
 * unwritable artifact.
 *
 *   npm run scoreboard:demo -- [--gate-voice <demo-voice-id>] [--scenario greeting-cut] [--runs 1]
 *                           [--out scoreboard-runs/score-<ts>-<voice>.json] [--dry-run]
 *                           [--trace-session sess_...] [--gap beat=ms ...]
 *
 * --gate-voice picks the gate voice through the shared voice registry
 * (--voice stays an alias); omitting both gates on DEFAULT_GATE_VOICE, never
 * on a literal in this file. New voices deploy as a registry entry plus a
 * regression run: the dry run lists the gate plus the regression set.
 *
 * --gap feeds a measured reply gap (visitor end-of-speech → first agent
 * audio) to a beat; repeat for several runs. --trace-session merges the
 * Call trace for a finished real-call session: its per-turn `gap Nms`
 * numbers feed the gate, with the first merged turn attributed to the
 * greeting-cut beat (golden runs open with the greeting cut).
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
  GOLDEN_BEATS,
  parseTraceGaps,
  redactLines,
  resolveGateVoice,
  sha256Hex,
  type GoldenBeat,
  type ScoreboardArtifact,
  type TraceGap,
} from "../src/lib/demo/scoreboard";
import { buildDemoAgentBody } from "../src/lib/demo/stored-agents";

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

/** Repeatable --gap beat=ms: measured reply gaps per beat (one per run). */
function parseGapFlags(argv: string[]): Partial<Record<GoldenBeat, number[]>> {
  const gaps: Partial<Record<GoldenBeat, number[]>> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--gap") continue;
    const raw = argv[i + 1] ?? "";
    const match = /^([a-z-]+)=(\d+)$/.exec(raw);
    const beat = match?.[1] as GoldenBeat | undefined;
    const ms = match ? Number(match[2]) : NaN;
    if (!match || !(GOLDEN_BEATS as readonly string[]).includes(beat as string) || !Number.isFinite(ms)) {
      throw new Error(
        `--gap needs beat=ms with a golden beat (one of ${GOLDEN_BEATS.join(", ")}), got "${raw}"`,
      );
    }
    gaps[beat as GoldenBeat] = [...(gaps[beat as GoldenBeat] ?? []), ms];
  }
  return gaps;
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

  const gaps = parseGapFlags(process.argv);
  let excerpt: string[] | null = null;
  let traceGaps: TraceGap[] = [];
  if (traceSession) {
    excerpt = runCallTrace(traceSession);
    traceGaps = parseTraceGaps(excerpt);
  }
  const agentInput = buildDemoAgentBody(voice).input;

  const artifact: ScoreboardArtifact = buildSkeletonArtifact({
    voice,
    scenario,
    runnerStdout: evalSection.stdout,
    exitCode: evalSection.exitCode,
    durationMs: evalSection.durationMs,
    runs: Number(runs) || 1,
    gaps,
    traceGaps,
    traceSessionId: traceSession || null,
    agentInput,
    traceExcerpt: excerpt ?? [],
  });
  if (excerpt) {
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
  if (artifact.gates.some((gate) => gate.status === "FAIL")) {
    console.log("scoreboard: FAIL — a measured gate breached its budget; see the failing gate detail above");
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
