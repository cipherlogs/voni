/**
 * Demo streak command: prove the exit claim for the gate voice.
 *
 * Reads the last three scoreboard artifacts for the gate voice (or an
 * explicit --artifacts list), then asserts:
 *   - every REQUIRED gate is PASS (accent-human, phone-checklist and
 *     talk-hold-pinned stay review-only; email-invite INFO is allowed only
 *     for unmeasured prospect-capture memory, ticket 27);
 *   - all three carry the same gate voice and schema version;
 *   - recordedAt strictly increases;
 *   - one identical code fingerprint (git HEAD + dirty hash) covers all
 *     three, so a green streak cannot survive a code change;
 *   - the candidate behavior suite ran green on that same code.
 *
 * The judgement is pure (src/lib/demo/scoreboard.ts evaluateScoreStreak); this
 * file only reads files, git and argv. No live audio, no browser, no
 * thresholds, no invented evidence: a missing or red behavior run fails the
 * claim instead of being omitted.
 *
 *   npm run scoreboard:streak -- [--gate-voice <demo-voice-id>]
 *                               [--dir scoreboard-runs]
 *                               [--artifacts a.json,b.json,c.json]
 *                               [--behavior <evidence.json>]
 *
 * Produce the behavior evidence on a built bundle (temp candidate: it runs
 * `npm ci` + `next build` + `next start` + the behavior Playwright specs, and
 * never touches a running dev server):
 *
 *   npm run test:e2e:behavior -- --evidence /tmp/voni-behavior.json
 *
 * The runner writes that file on green and red, carrying its exit code and
 * the same code fingerprint shape the artifacts use. Evidence is a file, never
 * a typed exit code: a human cannot type a green streak.
 *
 * Exit 0 only when the streak claim holds; 1 for a failed or unprovable claim.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  DEFAULT_GATE_VOICE,
  evaluateScoreStreak,
  formatStreakVerdict,
  parseBehaviorRunEvidence,
  parseGateRows,
  resolveGateVoice,
  STREAK_SIZE,
  type BehaviorRunEvidence,
  type CodeFingerprint,
  type StreakArtifact,
  type UnreadableArtifact,
} from "../src/lib/demo/scoreboard";

const USAGE = `Usage: npm run scoreboard:streak -- [options]

Judges the last three scoreboard artifacts for the gate voice plus the
candidate behavior run, and prints a PASS/FAIL streak verdict.

  --gate-voice <id>       gate voice (--voice is an alias); default ${DEFAULT_GATE_VOICE}
  --dir <path>            artifact directory; default scoreboard-runs
  --artifacts a,b,c       explicit artifacts (any order; judged oldest→newest)
  --behavior <path>       behavior-run evidence JSON written by the runner
  --help                  this text

Produce the behavior evidence on a built bundle (temp candidate: npm ci +
next build + next start + Playwright behavior specs; no dev server touched):

  npm run test:e2e:behavior -- --evidence /tmp/voni-behavior.json

A missing behavior file, a red exit, or a different code fingerprint fails
the streak. An unreadable artifact in the evaluated window also fails it by
name, so a crashed newer run can never be skipped. Accent ballots, the
real-phone checklist and Talk/Hold pinning stay informational and can never
block it.`;

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function argAll(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((value, index) => {
    if (value !== name) return;
    const next = process.argv[index + 1] ?? "";
    values.push(...next.split(",").map((part) => part.trim()).filter(Boolean));
  });
  return values;
}

type ReadResult = { artifact: StreakArtifact } | { broken: UnreadableArtifact };

/**
 * Read one artifact as the streak sees it. Gate rows go through the shared
 * validator in scoreboard.ts; a JSON that cannot be read is reported, never
 * skipped, so a crashed run still names itself in the verdict.
 */
function readArtifact(path: string): ReadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { broken: { name: basename(path), reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})` } };
  }
  const name = basename(path);
  if (raw === null || typeof raw !== "object") {
    return { broken: { name, reason: "not a scoreboard artifact object" } };
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.voice !== "string" ||
    typeof record.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(record.recordedAt)) ||
    typeof record.runId !== "string" ||
    typeof record.schemaVersion !== "number"
  ) {
    return { broken: { name, reason: "missing voice/recordedAt/runId/schemaVersion" } };
  }
  let gates;
  try {
    gates = parseGateRows(record.gates, name);
  } catch (error) {
    return { broken: { name, reason: error instanceof Error ? error.message : String(error) } };
  }
  const fingerprintRaw = record.codeFingerprint;
  let codeFingerprint: CodeFingerprint | null = null;
  if (fingerprintRaw !== null && fingerprintRaw !== undefined) {
    if (typeof fingerprintRaw !== "object") {
      return { broken: { name, reason: "codeFingerprint is not an object" } };
    }
    const fingerprint = fingerprintRaw as Record<string, unknown>;
    if (
      typeof fingerprint.head !== "string" ||
      typeof fingerprint.dirtyHash !== "string" ||
      typeof fingerprint.dirty !== "boolean"
    ) {
      return { broken: { name, reason: "codeFingerprint needs head/dirtyHash/dirty" } };
    }
    codeFingerprint = {
      head: fingerprint.head,
      dirtyHash: fingerprint.dirtyHash,
      dirty: fingerprint.dirty,
    };
  }
  return {
    artifact: {
      voice: record.voice,
      recordedAt: record.recordedAt,
      runId: record.runId,
      schemaVersion: record.schemaVersion,
      gates,
      codeFingerprint,
    },
  };
}

type Candidate = {
  path: string;
  artifact: StreakArtifact | null;
  /** Why an unreadable candidate cannot be judged; null when it parsed. */
  broken: UnreadableArtifact | null;
  mtimeMs: number;
};

function readExplicit(paths: string[]): Candidate[] {
  return paths.map((path) => {
    const resolved = resolve(path);
    if (!existsSync(resolved)) throw new Error(`--artifacts ${path} does not exist`);
    const read = readArtifact(resolved);
    if ("broken" in read) {
      throw new Error(`--artifacts ${path} is not a scoreboard artifact (${read.broken.reason})`);
    }
    return { path: resolved, artifact: read.artifact, broken: null, mtimeMs: statSync(resolved).mtimeMs };
  });
}

/**
 * Scan the run directory. Only `score-*.json` files are candidates (a matrix
 * artifact is never mistaken for a run). A score artifact that cannot be read
 * stays in the candidate set as broken: a crashed newer run must break the
 * streak, not disappear from it.
 */
function scanDirectory(dir: string, voice: string): Candidate[] {
  if (!existsSync(dir)) return [];
  const candidates: Candidate[] = [];
  for (const entry of readdirSync(dir)) {
    if (!/^score-.*\.json$/.test(entry)) continue;
    const path = resolve(dir, entry);
    const read = readArtifact(path);
    if ("broken" in read) {
      candidates.push({ path, artifact: null, broken: read.broken, mtimeMs: statSync(path).mtimeMs });
      continue;
    }
    if (read.artifact.voice !== voice) continue;
    candidates.push({ path, artifact: read.artifact, broken: null, mtimeMs: statSync(path).mtimeMs });
  }
  return candidates;
}

/** Oldest→newest by recordedAt (mtime for an unreadable run), path as the tiebreaker. */
function chronological(candidates: Candidate[]): Candidate[] {
  const at = (candidate: Candidate) =>
    candidate.artifact ? Date.parse(candidate.artifact.recordedAt) : candidate.mtimeMs;
  return candidates.toSorted((a, b) => {
    const recorded = at(a) - at(b);
    if (recorded !== 0) return recorded;
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.path.localeCompare(b.path);
  });
}

function readBehavior(): BehaviorRunEvidence | null {
  const path = arg("--behavior", "");
  if (process.argv.includes("--behavior-exit") || process.argv.includes("--behavior-fingerprint")) {
    throw new Error(
      "--behavior-exit is not evidence: run npm run test:e2e:behavior -- --evidence <path> and pass --behavior <path>",
    );
  }
  if (!path) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`--behavior ${path}: cannot read behavior-run evidence (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseBehaviorRunEvidence(raw);
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const voice = resolveGateVoice(arg("--gate-voice", arg("--voice", DEFAULT_GATE_VOICE)));
  const explicit = argAll("--artifacts");
  const dir = resolve(arg("--dir", "scoreboard-runs"));
  const candidates = chronological(explicit.length > 0 ? readExplicit(explicit) : scanDirectory(dir, voice));
  const window = candidates.slice(-STREAK_SIZE);
  const artifacts = window.flatMap((candidate) => (candidate.artifact ? [candidate.artifact] : []));
  const unreadable = window.flatMap((candidate) => (candidate.broken ? [candidate.broken] : []));
  const behavior = readBehavior();
  const result = evaluateScoreStreak({ artifacts, gateVoice: voice, behavior, unreadable });
  console.log(formatStreakVerdict(result));
  if (window.length > 0) {
    console.log(`artifacts: ${window.map((candidate) => basename(candidate.path)).join(", ")}`);
    if (explicit.length === 0) console.log(`directory: ${dir}`);
  }
  if (!result.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
