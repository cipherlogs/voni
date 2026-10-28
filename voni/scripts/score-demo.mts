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
 * Gates: the reply-gap, end-of-turn, filler-resume and barge-in-cut gates
 * fail the command (exit 1) when measured evidence breaches the budget, so
 * regressions never merge silently. Without measured gaps, filler or
 * real-cut evidence the gates stay INFO and the command exits 0 once the
 * artifact is written, even when the eval runner itself fails (its exit code
 * is recorded in the artifact). Non-zero exit otherwise means the harness
 * broke: unknown voice, bad --gap/--filler/--cut flag, spawn failure, or an
 * unwritable artifact.
 *
 *   npm run scoreboard:demo -- [--gate-voice <demo-voice-id>] [--scenario greeting-cut] [--runs 1]
 *                           [--out scoreboard-runs/score-<ts>-<voice>.json] [--dry-run]
 *                           [--trace-session sess_...] [--gap beat=ms ...]
 *                           [--filler-text "Okaay so" --filler-cut-ms 320 ...]
 *                           [--cut-ms <n> | --cut-never] [--cut-verdict <v>] [--cut-answered]
 *                           [--cut-resumed] [--cut-ended] [--trace-turn <text>]
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
 * --filler-text feeds the observed floor behavior for one filler overlap;
 * without it the filler-resume gate stays INFO. --trace-session fills
 * --filler-trace-turn when the flag is absent, so a failure still points
 * at the Call trace turn.
 *
 * --dry-run skips spawning the runner (no ASSEMBLYAI_API_KEY needed) and
 * records a placeholder eval section. --trace-session merges the Call trace
 * for a finished real-call session into the artifact excerpt.
 *
 * Real-cut gate (ticket 05): when the eval output carries a real-cut
 * scenario (stop-over, hang-up-over, hang-up-fast), the barge-in-cut gate is
 * evaluated from the runner's cut milliseconds, verdict, and resume lines,
 * and the real-cut-answered beat carries the measured cut. The same evidence
 * can be passed explicitly (dry-run friendly): --cut-ms with --cut-answered
 * passes a fast answered cut, --cut-never / a late --cut-ms / --cut-resumed /
 * a missing --cut-answered fails with cut ms plus verdict and trace turn.
 * Explicit flags override the parsed runner output per field. With neither
 * parsed nor explicit evidence the gate stays INFO: recorded, not failed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyRealCutGate,
  buildSkeletonArtifact,
  DEFAULT_GATE_VOICE,
  extractRealCutEvidence,
  formatGateTable,
  formatGoldenScript,
  GOLDEN_BEATS,
  parseTraceGaps,
  redactLines,
  resolveGateVoice,
  sha256Hex,
  type FillerResumeEvidence,
  type FillerVerdict,
  type GoldenBeat,
  type RealCutEvidence,
  type ScoreboardArtifact,
  type TraceGap,
} from "../src/lib/demo/scoreboard";
import { buildDemoAgentBody } from "../src/lib/demo/stored-agents";
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
  const cutMsArg = arg("--cut-ms", "");
  if (cutMsArg !== "" && !/^\d+$/.test(cutMsArg)) {
    throw new Error(`--cut-ms needs milliseconds, got "${cutMsArg}"`);
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
  const fillerResume = readFillerEvidence(traceSession);

  let artifact: ScoreboardArtifact = buildSkeletonArtifact({
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
    fillerResume,
  });
  const parsed = extractRealCutEvidence(evalSection.stdout);
  const hasCutFlags =
    cutMsArg !== "" ||
    process.argv.includes("--cut-never") ||
    arg("--cut-verdict", "") !== "" ||
    process.argv.includes("--cut-answered") ||
    process.argv.includes("--cut-resumed") ||
    process.argv.includes("--cut-ended") ||
    arg("--trace-turn", "") !== "";
  if (parsed || hasCutFlags) {
    const base: RealCutEvidence = parsed ?? {
      cutMs: null,
      verdict: null,
      verdictSource: null,
      answered: false,
      resumed: false,
      ended: false,
      traceTurn: null,
    };
    const evidence: RealCutEvidence = {
      cutMs: process.argv.includes("--cut-never")
        ? null
        : cutMsArg !== "" ? Number(cutMsArg) : base.cutMs,
      verdict: arg("--cut-verdict", "") || base.verdict,
      verdictSource: base.verdictSource,
      answered: process.argv.includes("--cut-answered") || base.answered,
      resumed: process.argv.includes("--cut-resumed") || base.resumed,
      ended: process.argv.includes("--cut-ended") || base.ended,
      traceTurn: arg("--trace-turn", "") || base.traceTurn,
    };
    artifact = applyRealCutGate(artifact, evidence);
  }
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
