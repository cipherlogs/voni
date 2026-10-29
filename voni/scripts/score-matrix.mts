/**
 * Demo voice regression matrix (ticket 10): one command that runs the golden
 * Demo call across every demo voice and reports regression-only verdicts.
 *
 * Single seam at the npm-script level. This file drives the existing
 * score-demo orchestrator per voice, then derives each voice's regression
 * verdict from its own artifact (probe counts plus redacted transcripts via
 * analyzeTagMentions). The gate verdict and sub-scores are carried verbatim
 * from the gate voice's artifact, never re-evaluated here: regression rows
 * cannot turn required green red (or red green). No new transport, no
 * parallel pipeline, no new demo app.
 *
 * Ticket 72 makes every artifact carry its subject and exports
 * `subjectGateVerdict(artifact)` / `subjectOfArtifact(artifact)` from
 * `scoreboard.ts`. Ticket 73 replaces the carried verdict with one derived per
 * subject from that subject's own artifact (each subject's runs are its own).
 * This file deliberately still carries the gate voice's verdict until then.
 *
 * Non-gate voices run regression-only (no clip, no pop, no invented test
 * tag): adding voices never breaks existing ones. Deploying a new voice is a
 * registry entry plus a full matrix run: --voices is a registry parameter,
 * never a literal list in this file.
 *
 *   npm run scoreboard:matrix -- [--gate-voice <demo-voice-id>] [--voices anna,lola] [--scenario greeting-cut]
 *                              [--runs 1] [--expected-tag "Lime 42"] [--out matrix-<ts>-<voice>.json]
 *                              [--dry-run] [--from scoreboard-runs/] [--strict]
 *
 * --dry-run spawns score-demo --dry-run per voice (no ASSEMBLYAI_API_KEY
 * needed) and assumes clean tag discipline: it proves the registry plumbing
 * and the per-voice rows, not the audio. Real runs derive everything from
 * each voice's transcripts.
 *
 * --from re-analyzes saved per-voice score artifacts instead of spawning
 * (air-gapped re-check of a finished matrix).
 *
 * Extensions kept beyond the ticket scope (documented, not silent): --strict
 * exits non-zero when any voice regresses (CI gate for deploying a new
 * voice); --from re-analyzes saved artifacts instead of spawning.
 * Reproducibility bar: three consecutive green runs on the reference desktop
 * setup before calling the harness solid. Flaky beats are quarantined by
 * beat name (scoreboard artifact quarantinedBeats, empty for now), never by
 * loosening thresholds.
 *
 * Exit 0 once the matrix artifact is written, even with FAIL rows (like
 * score-demo: non-zero means the harness broke). --strict exits non-zero when
 * any voice regresses: use it in CI when deploying a new voice.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  buildRegressionMatrix,
  DEFAULT_GATE_VOICE,
  formatMatrixTable,
  parseGateRows,
  parseSubScoreRows,
  resolveGateVoice,
  resolveMatrixVoices,
  validateProbeCounts,
  type RegressionMatrix,
  type RegressionVoiceInput,
  type ScoreboardGate,
  type SubScore,
  type TimbreProbes,
} from "../src/lib/demo/scoreboard";

const SCORE_DEMO = new URL("./score-demo.mts", import.meta.url).pathname;

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** The score-artifact keys the matrix reads: regression evidence plus the carried gate verdict. */
function readScoreArtifact(path: string): {
  voice: string;
  probes: TimbreProbes;
  tagLines: string[];
  gates: ScoreboardGate[] | undefined;
  subScores: SubScore[] | undefined;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`matrix cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`matrix cannot read ${path}: not a score artifact`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.voice !== "string") throw new Error(`matrix cannot read ${path}: no voice`);
  const voice = resolveGateVoice(record.voice);
  // Probe-count shape lives in scoreboard.ts (validateProbeCounts): one
  // validator for the orchestrator and the matrix.
  const probes = validateProbeCounts(
    (record.probes ?? {}) as Record<string, unknown>,
    `matrix cannot read ${path}`,
  );
  const redacted = (record.transcripts as { redacted?: unknown } | undefined)?.redacted;
  if (!Array.isArray(redacted) || !redacted.every((line) => typeof line === "string")) {
    throw new Error(`matrix cannot read ${path}: no redacted transcripts`);
  }
  return {
    voice,
    probes,
    tagLines: redacted as string[],
    gates: readGates(record.gates, path),
    subScores: readSubScores(record.subScores, path),
  };
}

/** Carry the gate rows verbatim; absent rows stay absent (reported INFO, never invented). */
function readGates(raw: unknown, path: string): ScoreboardGate[] | undefined {
  if (raw === undefined) return undefined;
  return parseGateRows(raw, `matrix cannot read ${path}`);
}

/** Carry the five sub-scores verbatim; the matrix never re-derives them. */
function readSubScores(raw: unknown, path: string): SubScore[] | undefined {
  if (raw === undefined) return undefined;
  return parseSubScoreRows(raw, `matrix cannot read ${path}`);
}

function runScoreDemo(voice: string, scenario: string, runs: string, dryRun: boolean, out: string): void {
  const result = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      SCORE_DEMO,
      "--gate-voice",
      voice,
      "--scenario",
      scenario,
      "--runs",
      runs,
      ...(dryRun ? ["--dry-run"] : []),
      "--out",
      out,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `score-demo failed for voice "${voice}" (exit ${result.status}): ${(result.stderr ?? "").slice(0, 500)}`,
    );
  }
}

function main(): void {
  const gateVoice = resolveGateVoice(arg("--gate-voice", "") || arg("--voice", DEFAULT_GATE_VOICE));
  const voices = resolveMatrixVoices(arg("--voices", ""));
  const scenario = arg("--scenario", "greeting-cut");
  const runs = arg("--runs", "1");
  const expectedTag = arg("--expected-tag", "Lime 42");
  const dryRun = process.argv.includes("--dry-run");
  const fromDir = arg("--from", "");
  const strict = process.argv.includes("--strict");

  const entries: RegressionVoiceInput[] = [];
  if (fromDir) {
    const dir = resolve(fromDir);
    let files: string[];
    try {
      files = readdirSync(dir).filter((file) => file.endsWith(".json"));
    } catch {
      throw new Error(`matrix cannot read --from ${dir}: not a directory`);
    }
    const byVoice = new Map(files.map((file) => {
      const entry = readScoreArtifact(resolve(dir, file));
      return [entry.voice, entry] as const;
    }));
    for (const voice of voices) {
      const found = byVoice.get(voice);
      if (!found) throw new Error(`matrix --from ${dir} has no score artifact for voice "${voice}"`);
      entries.push({
        voice,
        probes: found.probes,
        tagLines: found.tagLines,
        gates: found.gates,
        subScores: found.subScores,
        expectedTag,
      });
    }
  } else {
    const scratch = mkdtempSync(join(tmpdir(), "score-matrix-"));
    for (const voice of voices) {
      const tmp = resolve(scratch, `${voice}.json`);
      runScoreDemo(voice, scenario, runs, dryRun, tmp);
      const artifact = readScoreArtifact(tmp);
      entries.push({
        voice,
        probes: artifact.probes,
        tagLines: dryRun
          ? [`send it with ${expectedTag} in the subject (dry run: tag discipline assumed clean)`]
          : artifact.tagLines,
        gates: artifact.gates,
        subScores: artifact.subScores,
        expectedTag,
      });
    }
  }

  const matrix: RegressionMatrix = buildRegressionMatrix({ gateVoice, entries, expectedTag });
  const out = resolve(arg("--out", `scoreboard-runs/matrix-${stamp()}-${gateVoice}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(matrix, null, 2)}\n`, { mode: 0o600 });

  console.log(formatMatrixTable(matrix));
  console.log(`artifact: ${out}`);
  if (strict && matrix.gates.find((gate) => gate.name === "matrix")?.status === "FAIL") {
    console.error("matrix: a voice regressed (see FAIL rows above)");
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
