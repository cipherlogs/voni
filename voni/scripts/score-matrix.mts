/**
 * Subject regression matrix (tickets 10 and 73): one command that runs the
 * golden Demo call across a set of subjects and reports a verdict per subject.
 *
 * A **subject** is `{agent, Locale, transport}` (voice-parity ticket 72). Every
 * row is a subject and every row's gate verdict is derived from that subject's
 * own artifact through `subjectGateVerdict`. There is no gate voice and no
 * carried verdict: a failing subject cannot borrow a passing one, and a subject
 * with no run reports MISSING instead of copying a neighbour's row.
 *
 * The matrix still drives the existing score-demo orchestrator per subject and
 * adds the regression-only checks (probe counts plus redacted transcripts via
 * analyzeTagMentions). Non-featured subjects run regression-only (no clip, no
 * pop, no invented test tag): adding a subject never breaks an existing one.
 * Deploying a new voice is a registry entry plus a full matrix run.
 *
 *   npm run scoreboard:matrix -- [--voices anna,lola] [--tenant <agent-id>,<voice>,<locale>[,<transport>]]
 *                              [--scenario greeting-cut] [--runs 1]
 *                              [--expected-tag "Lime 42"] [--out matrix-<ts>.json]
 *                              [--dry-run] [--from scoreboard-runs/] [--strict]
 *
 * `--voices` names demo subjects (default: every registry voice when spawning,
 * every demo subject found when re-analyzing). `--tenant` may repeat and adds a
 * tenant agent as its own row; a tenant and the demo voice it shares are
 * different subjects. `--gate-voice` is accepted for compatibility but no longer
 * selects a verdict: it is validated and never carried.
 *
 * --dry-run spawns score-demo --dry-run per subject (no ASSEMBLYAI_API_KEY
 * needed) and assumes clean tag discipline: it proves the registry plumbing and
 * the per-subject rows, not the audio.
 *
 * --from re-analyzes saved score artifacts instead of spawning (air-gapped
 * re-check of a finished matrix). With no filter it measures every subject the
 * directory contains, tenants included. A requested subject with no artifact
 * becomes a MISSING row; it is never filled from another run.
 *
 * --strict exits non-zero when any subject is not clean (CI gate for deploying
 * a new subject). Reproducibility bar: three consecutive green runs on the
 * reference desktop setup before calling the harness solid.
 *
 * Exit 0 once the matrix artifact is written, even with FAIL/MISSING rows (like
 * score-demo: non-zero means the harness broke). --strict is the CI gate.
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
  subjectOfArtifact,
  subjectRowKey,
  validateProbeCounts,
  type RegressionMatrix,
  type RegressionSubjectInput,
  type ScoreboardArtifact,
  type ScoreboardGate,
  type SubScore,
} from "../src/lib/demo/scoreboard";
import {
  resolveSubject,
  sameSubject,
  type SubjectRecord,
} from "../src/lib/demo/subject";

const SCORE_DEMO = new URL("./score-demo.mts", import.meta.url).pathname;

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/** Every value following a repeated flag (`--tenant a --tenant b`). */
function argValues(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((value, index) => {
    if (value === name && index + 1 < process.argv.length) values.push(process.argv[index + 1]);
  });
  return values;
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** One subject the matrix will measure, plus the voice score-demo needs to spawn it. */
type MatrixTarget = {
  subject: SubjectRecord;
  /** Demo voice, or the voice a tenant subject's agent speaks (spawn input only). */
  voice: string;
};

/** One subject and the artifact its verdict came from. */
type MatrixRun = {
  subject: SubjectRecord;
  artifact: ScoreboardArtifact;
};

/**
 * The score-artifact fields the matrix validates before building a row. The
 * subject comes from the artifact itself (`subjectOfArtifact`), never from a
 * filename or from this invocation's flags.
 */
function readScoreArtifact(path: string): MatrixRun {
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
  // A verdict cites the run it came from. An artifact without a run id cannot
  // produce one, so it fails by name instead of inventing an identifier.
  if (typeof record.runId !== "string" || record.runId.trim() === "") {
    throw new Error(`matrix cannot read ${path}: no runId (a subject verdict must cite its own run)`);
  }
  const scenario = (record.evalRunner as { scenario?: unknown } | undefined)?.scenario;
  if (typeof scenario !== "string") {
    throw new Error(`matrix cannot read ${path}: no evalRunner scenario`);
  }
  // Narrow the record to the fields the row reads, then let the one subject
  // seam derive the row's subject and verdict.
  const artifact = {
    ...(record as object),
    voice,
    probes,
    transcripts: { ...(record.transcripts as object), redacted },
    gates: readGates(record.gates, path) ?? [],
    subScores: readSubScores(record.subScores, path) ?? [],
    runId: record.runId,
    evalRunner: { ...(record.evalRunner as object), scenario },
  } as unknown as ScoreboardArtifact;
  return { subject: subjectOfArtifact(artifact), artifact };
}

/** Read the artifact's own gate rows; absent rows stay absent (reported INFO). */
function readGates(raw: unknown, path: string): ScoreboardGate[] | undefined {
  if (raw === undefined) return undefined;
  return parseGateRows(raw, `matrix cannot read ${path}`);
}

/** Read the artifact's five sub-scores; the matrix never re-derives them. */
function readSubScores(raw: unknown, path: string): SubScore[] | undefined {
  if (raw === undefined) return undefined;
  return parseSubScoreRows(raw, `matrix cannot read ${path}`);
}

function runScoreDemo(target: MatrixTarget, scenario: string, runs: string, dryRun: boolean, out: string): void {
  const subject = target.subject;
  const result = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      SCORE_DEMO,
      ...(subject.agent.kind === "demo"
        ? ["--gate-voice", subject.agent.voice]
        : ["--agent", subject.agent.agentId, "--voice", target.voice, "--subject-locale", subject.locale]),
      // Only name the transport when it is not the default, so a demo run keeps
      // its `default` provenance instead of looking explicitly flagged.
      ...(subject.transport === "browser" ? [] : ["--subject-transport", subject.transport]),
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
      `score-demo failed for subject "${subjectRowKey(subject)}" (exit ${result.status}): ${(result.stderr ?? "").slice(0, 500)}`,
    );
  }
}

/** Demo subjects: a registry parameter, never literals in this file. */
function demoTargets(csv: string): MatrixTarget[] {
  return resolveMatrixVoices(csv).map((voice) => ({
    subject: resolveSubject({ voice }),
    voice,
  }));
}

/** `--tenant <agent-id>,<voice>,<locale>[,<transport>]`, repeatable. */
function tenantTargets(): MatrixTarget[] {
  return argValues("--tenant").map((raw) => {
    const [agentId, voice, locale, transport, ...extra] = raw.split(",").map((part) => part.trim());
    if (!agentId || !voice || !locale || extra.length > 0) {
      throw new Error(`--tenant needs "<agent-id>,<voice>,<locale>[,<transport>]", got "${raw}"`);
    }
    return {
      subject: resolveSubject({
        agent: agentId,
        voice,
        locale,
        ...(transport ? { transport } : {}),
        explicit: true,
      }),
      voice,
    };
  });
}

/** One row per subject: a repeated flag never measures the same subject twice. */
function dedupeTargets(targets: MatrixTarget[]): MatrixTarget[] {
  const unique: MatrixTarget[] = [];
  for (const target of targets) {
    if (!unique.some((known) => sameSubject(known.subject, target.subject))) unique.push(target);
  }
  return unique;
}

/** Latest saved run per subject (`--from` can see several runs of one subject). */
function latestRunPerSubject(runs: MatrixRun[]): MatrixRun[] {
  const byKey = new Map<string, MatrixRun>();
  for (const run of runs) {
    const key = subjectRowKey(run.subject);
    const known = byKey.get(key);
    if (!known || run.artifact.recordedAt >= known.artifact.recordedAt) byKey.set(key, run);
  }
  return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, run]) => run);
}

function main(): void {
  // The featured subject is named for report emphasis only. No row reads its
  // verdict from here (ticket 73).
  const featured = resolveSubject({ voice: DEFAULT_GATE_VOICE });
  const gateVoiceFlag = arg("--gate-voice", "") || arg("--voice", "");
  if (gateVoiceFlag) {
    // Validated for a clear typo failure, but it can no longer carry a verdict.
    resolveGateVoice(gateVoiceFlag);
  }
  const voicesFlag = arg("--voices", "");
  const scenario = arg("--scenario", "greeting-cut");
  const runs = arg("--runs", "1");
  const expectedTag = arg("--expected-tag", "Lime 42");
  const dryRun = process.argv.includes("--dry-run");
  const fromDir = arg("--from", "");
  const strict = process.argv.includes("--strict");
  const tenants = tenantTargets();

  const entries: RegressionSubjectInput[] = [];
  if (fromDir) {
    const dir = resolve(fromDir);
    let files: string[];
    try {
      files = readdirSync(dir).filter((file) => file.endsWith(".json"));
    } catch {
      throw new Error(`matrix cannot read --from ${dir}: not a directory`);
    }
    const saved = latestRunPerSubject(files.map((file) => readScoreArtifact(resolve(dir, file))));
    if (!voicesFlag.trim() && tenants.length === 0) {
      // No filter: every subject the directory measured, tenants included.
      for (const run of saved) entries.push({ subject: run.subject, artifact: run.artifact });
    } else {
      for (const target of dedupeTargets([...demoTargets(voicesFlag), ...tenants])) {
        const found = saved.find((run) => sameSubject(run.subject, target.subject));
        // A requested subject with no artifact is MISSING, never another row's.
        entries.push({ subject: target.subject, ...(found ? { artifact: found.artifact } : {}) });
      }
    }
  } else {
    const scratch = mkdtempSync(join(tmpdir(), "score-matrix-"));
    for (const target of dedupeTargets([...demoTargets(voicesFlag), ...tenants])) {
      const tmp = resolve(scratch, `${subjectRowKey(target.subject).replace(/[^a-zA-Z0-9]+/g, "-")}.json`);
      runScoreDemo(target, scenario, runs, dryRun, tmp);
      const run = readScoreArtifact(tmp);
      const artifact = dryRun
        ? {
            ...run.artifact,
            // --dry-run assumes clean tag discipline; every other field is the
            // dry-run run's own.
            transcripts: {
              ...run.artifact.transcripts,
              redacted: [`send it with ${expectedTag} in the subject (dry run: tag discipline assumed clean)`],
            },
          }
        : run.artifact;
      entries.push({ subject: target.subject, artifact });
    }
  }

  const matrix: RegressionMatrix = buildRegressionMatrix({
    featuredSubject: featured,
    entries,
    expectedTag,
  });
  const out = resolve(arg("--out", `scoreboard-runs/matrix-${stamp()}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(matrix, null, 2)}\n`, { mode: 0o600 });

  console.log(formatMatrixTable(matrix));
  console.log(`artifact: ${out}`);
  if (strict && matrix.gates.find((gate) => gate.name === "matrix")?.status === "FAIL") {
    console.error("matrix: a subject regressed or is missing (see FAIL/MISSING rows above)");
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
