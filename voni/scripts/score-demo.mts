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
 * No gates yet except filler-resume (ticket 04): every other gate reports
 * PASS/INFO and the command exits 0 once the artifact is written, even when
 * the eval runner itself fails (its exit code is recorded in the artifact).
 * A FAIL gate (filler back-channel stole the floor, or its resume missed
 * the tail/timing) exits non-zero so regressions block the merge.
 * Non-zero exit otherwise means the harness broke: unknown voice, bad
 * filler flags, spawn failure, or an unwritable artifact.
 *
 *   npm run scoreboard:demo -- [--gate-voice <demo-voice-id>] [--scenario greeting-cut] [--runs 1]
 *                           [--out scoreboard-runs/score-<ts>-<voice>.json] [--dry-run]
 *                           [--trace-session sess_...]
 *                           [--filler-text "Okaay so" --filler-cut-ms 320 ...]
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
  type FillerResumeEvidence,
  type FillerVerdict,
  type ScoreboardArtifact,
} from "../src/lib/demo/scoreboard";
import { judgeOverlap } from "../src/lib/voice/barge-in";

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

/**
 * Filler-beat evidence from explicit CLI flags (the observed floor behavior
 * for one filler overlap). The verdict defaults to what the overlap judge
 * says about the words; cut/resume/tail observations always come from the
 * run. Absent --filler-text, the filler-resume gate stays INFO (skeleton).
 *
 *   --filler-text "Okaay so" [--filler-agent-text "..."] [--filler-verdict ignore]
 *   [--filler-cut-ms 320] [--filler-resume-ms 1200]
 *   [--filler-resumed-text "..."] [--filler-heard-text "..."]
 *   [--filler-answered-over] [--filler-trace-turn sess_abc#turn]
 *
 * --trace-session fills --filler-trace-turn when the flag is absent, so a
 * failure still points at the Call trace turn.
 */
function readFillerEvidence(traceSession: string): FillerResumeEvidence | undefined {
  const visitorText = arg("--filler-text", "");
  if (!visitorText) return undefined;
  const agentText = arg("--filler-agent-text", "");
  const verdictRaw = arg("--filler-verdict", "");
  const verdict: FillerVerdict = (
    verdictRaw ? verdictRaw : judgeOverlap(visitorText, agentText)
  ) as FillerVerdict;
  if (!["yield", "ignore", "judge", "keep"].includes(verdict)) {
    throw new Error(`--filler-verdict needs one of yield|ignore|judge|keep, got "${verdictRaw}"`);
  }
  const ms = (flag: string): number | null => {
    const raw = arg(flag, "");
    if (raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative ms number, got "${raw}"`);
    return n;
  };
  return {
    visitorText,
    agentText,
    verdict,
    cutMs: ms("--filler-cut-ms"),
    resumeMs: ms("--filler-resume-ms"),
    resumedText: arg("--filler-resumed-text", ""),
    heardText: arg("--filler-heard-text", ""),
    answeredOver: process.argv.includes("--filler-answered-over"),
    traceTurn: arg("--filler-trace-turn", "") || traceSession || undefined,
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

  const evalSection = dryRun
    ? { stdout: "(dry run: eval runner skipped)", exitCode: null as number | null, durationMs: 0 }
    : runEvalRunner(voice, scenario, runs);

  const fillerResume = readFillerEvidence(traceSession);

  const artifact: ScoreboardArtifact = buildSkeletonArtifact({
    voice,
    scenario,
    runnerStdout: evalSection.stdout,
    exitCode: evalSection.exitCode,
    durationMs: evalSection.durationMs,
    runs: Number(runs) || 1,
    fillerResume,
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
  if (artifact.gates.some((gate) => gate.status === "FAIL")) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
