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
 * Overheard recall (ticket 06) is the first enforced gate: every aside
 * spoken while Voni holds the floor must be marked Overheard speech and
 * counted in the call ledger, with steering answered and filler
 * resumed-from. Other gates still report PASS/INFO. The command exits 0
 * once the artifact is written, even when a gate FAILs or the eval runner
 * itself fails (both are recorded in the artifact). Non-zero exit means
 * the harness broke: unknown voice, bad --overheard-json, spawn failure,
 * or an unwritable artifact.
 *
 *   npm run scoreboard:demo -- [--gate-voice <demo-voice-id>] [--scenario greeting-cut] [--runs 1]
 *                           [--out scoreboard-runs/score-<ts>-<voice>.json] [--dry-run]
 *                           [--trace-session sess_...] [--overheard-json asides.json]
 *
 * --gate-voice picks the gate voice through the shared voice registry
 * (--voice stays an alias); omitting both gates on DEFAULT_GATE_VOICE, never
 * on a literal in this file. New voices deploy as a registry entry plus a
 * regression run: the dry run lists the gate plus the regression set.
 *
 * --dry-run skips spawning the runner (no ASSEMBLYAI_API_KEY needed) and
 * records a placeholder eval section. --trace-session merges the Call trace
 * for a finished real-call session into the artifact excerpt, and its HEARD
 * rows become ledger-counted overheard asides (handling from the CLIENT
 * barge-in verdicts). --overheard-json feeds explicit asides (marked,
 * ledger, handling, trace pointer per beat); it merges with trace-derived
 * ones.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildSkeletonArtifact,
  DEFAULT_GATE_VOICE,
  formatGateTable,
  formatGoldenScript,
  formatOverheardReport,
  GOLDEN_BEATS,
  overheardFromTraceExcerpt,
  redactLines,
  resolveGateVoice,
  sha256Hex,
  type GoldenBeat,
  type OverheardAside,
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

const OVERHEARD_HANDLINGS = ["answered", "resumed-from", "heard-only", "lost"] as const;

/** Load and validate explicit overheard asides; throws (exit 1, no artifact) on bad input. */
function loadOverheardJson(path: string): OverheardAside[] {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`--overheard-json ${path} must be a JSON array of asides`);
  return raw.map((entry, index) => {
    const aside = entry as Partial<OverheardAside>;
    if (aside === null || typeof aside !== "object") {
      throw new Error(`--overheard-json[${index}]: must be an object`);
    }
    if (!(GOLDEN_BEATS as readonly string[]).includes(String(aside.beat))) {
      throw new Error(`--overheard-json[${index}]: beat must be one of ${GOLDEN_BEATS.join(", ")}`);
    }
    if (typeof aside.text !== "string" || !aside.text.trim()) {
      throw new Error(`--overheard-json[${index}]: text must be a non-empty string`);
    }
    if (typeof aside.markedOverheard !== "boolean" || typeof aside.inLedger !== "boolean") {
      throw new Error(`--overheard-json[${index}]: markedOverheard and inLedger must be booleans`);
    }
    if (!(OVERHEARD_HANDLINGS as readonly string[]).includes(String(aside.handling))) {
      throw new Error(`--overheard-json[${index}]: handling must be one of ${OVERHEARD_HANDLINGS.join(", ")}`);
    }
    if (typeof aside.tracePointer !== "string" || !aside.tracePointer.trim()) {
      throw new Error(`--overheard-json[${index}]: tracePointer must be a non-empty string`);
    }
    return {
      beat: aside.beat as GoldenBeat,
      text: aside.text,
      ...(typeof aside.agentText === "string" ? { agentText: aside.agentText } : {}),
      markedOverheard: aside.markedOverheard,
      inLedger: aside.inLedger,
      handling: aside.handling as OverheardAside["handling"],
      tracePointer: aside.tracePointer,
    };
  });
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
  const overheardJsonPath = arg("--overheard-json", "");

  const evalSection = dryRun
    ? { stdout: "(dry run: eval runner skipped)", exitCode: null as number | null, durationMs: 0 }
    : runEvalRunner(voice, scenario, runs);

  const explicitAsides = overheardJsonPath ? loadOverheardJson(overheardJsonPath) : null;
  let traceExcerpt: string[] | null = null;
  if (traceSession) {
    traceExcerpt = runCallTrace(traceSession);
  }
  const traceAsides =
    traceExcerpt && traceSession ? overheardFromTraceExcerpt(traceExcerpt, traceSession) : [];
  const overheardAsides =
    explicitAsides !== null || traceAsides.length > 0 ? [...(explicitAsides ?? []), ...traceAsides] : undefined;

  const artifact: ScoreboardArtifact = buildSkeletonArtifact({
    voice,
    scenario,
    runnerStdout: evalSection.stdout,
    exitCode: evalSection.exitCode,
    durationMs: evalSection.durationMs,
    runs: Number(runs) || 1,
    ...(overheardAsides !== undefined ? { overheardAsides } : {}),
  });
  if (traceSession && traceExcerpt) {
    artifact.callTrace = {
      sessionId: traceSession,
      excerptSha256: sha256Hex(traceExcerpt.join("\n")),
      excerpt: traceExcerpt.slice(0, 120),
    };
  }

  const out = resolve(arg("--out", `scoreboard-runs/score-${stamp()}-${voice}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });

  console.log(formatGoldenScript(voice));
  console.log(formatGateTable(artifact));
  console.log(formatOverheardReport(artifact));
  console.log(`artifact: ${out}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
