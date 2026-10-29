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
 *                               [--behavior <evidence.json>
 *                                | --behavior-exit <code>
 *                                  --behavior-fingerprint <head>:<dirtyHash>:<clean|dirty>]
 *
 * Produce the behavior evidence on a built bundle (temp candidate: it runs
 * `npm ci` + `next build` + `next start` + the behavior Playwright specs, and
 * never touches a running dev server):
 *
 *   npm run test:e2e:behavior -- --evidence /tmp/voni-behavior.json
 *
 * The runner writes that file on green and red, carrying its exit code and
 * the same code fingerprint shape the artifacts use. Exit result only:
 * pass the code it ran on explicitly (head:dirtyHash:clean|dirty).
 *
 * Exit 0 only when the streak claim holds; 1 for a failed or unprovable claim.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  BEHAVIOR_RUN_EVIDENCE_KIND,
  BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION,
  DEFAULT_GATE_VOICE,
  evaluateScoreStreak,
  formatStreakVerdict,
  parseBehaviorRunEvidence,
  resolveGateVoice,
  type BehaviorRunEvidence,
  type CodeFingerprint,
  type ScoreboardGate,
  type StreakArtifact,
} from "../src/lib/demo/scoreboard";

const USAGE = `Usage: npm run scoreboard:streak -- [options]

Judges the last three scoreboard artifacts for the gate voice plus the
candidate behavior run, and prints a PASS/FAIL streak verdict.

  --gate-voice <id>       gate voice (--voice is an alias); default ${DEFAULT_GATE_VOICE}
  --dir <path>            artifact directory; default scoreboard-runs
  --artifacts a,b,c       explicit artifacts (any order; judged oldest→newest)
  --behavior <path>       behavior-run evidence JSON (preferred)
  --behavior-exit <code>  only the runner's exit result; needs
  --behavior-fingerprint <head>:<dirtyHash>:<clean|dirty>
  --help                  this text

Produce the behavior evidence on a built bundle (temp candidate: npm ci +
next build + next start + Playwright behavior specs; no dev server touched):

  npm run test:e2e:behavior -- --evidence /tmp/voni-behavior.json

A missing behavior file, a red exit, or a different code fingerprint fails
the streak. Accent ballots, the real-phone checklist and Talk/Hold pinning
stay informational and can never block it.`;

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

const GATE_STATUSES = new Set(["PASS", "INFO", "FAIL"]);

/**
 * Read one artifact as the streak sees it. Anything that is not a scoreboard
 * artifact is rejected for an explicit path; the directory scan skips other
 * JSON so a matrix artifact is never mistaken for a run.
 */
function readArtifact(path: string): StreakArtifact | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.voice !== "string" ||
    typeof record.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(record.recordedAt)) ||
    typeof record.runId !== "string" ||
    typeof record.schemaVersion !== "number" ||
    !Array.isArray(record.gates)
  ) {
    return null;
  }
  const gates: ScoreboardGate[] = [];
  for (const value of record.gates) {
    if (value === null || typeof value !== "object") return null;
    const gate = value as Record<string, unknown>;
    if (
      typeof gate.name !== "string" ||
      typeof gate.detail !== "string" ||
      typeof gate.status !== "string" ||
      !GATE_STATUSES.has(gate.status)
    ) {
      return null;
    }
    gates.push({ name: gate.name, detail: gate.detail, status: gate.status as ScoreboardGate["status"] });
  }
  const fingerprintRaw = record.codeFingerprint;
  let codeFingerprint: CodeFingerprint | null = null;
  if (fingerprintRaw !== null && fingerprintRaw !== undefined) {
    if (typeof fingerprintRaw !== "object") return null;
    const fingerprint = fingerprintRaw as Record<string, unknown>;
    if (
      typeof fingerprint.head !== "string" ||
      typeof fingerprint.dirtyHash !== "string" ||
      typeof fingerprint.dirty !== "boolean"
    ) {
      return null;
    }
    codeFingerprint = {
      head: fingerprint.head,
      dirtyHash: fingerprint.dirtyHash,
      dirty: fingerprint.dirty,
    };
  }
  return {
    voice: record.voice,
    recordedAt: record.recordedAt,
    runId: record.runId,
    schemaVersion: record.schemaVersion,
    gates,
    codeFingerprint,
  };
}

type Candidate = { path: string; artifact: StreakArtifact; mtimeMs: number };

function readExplicit(paths: string[]): Candidate[] {
  return paths.map((path) => {
    const resolved = resolve(path);
    if (!existsSync(resolved)) throw new Error(`--artifacts ${path} does not exist`);
    const artifact = readArtifact(resolved);
    if (!artifact) throw new Error(`--artifacts ${path} is not a scoreboard artifact`);
    return { path: resolved, artifact, mtimeMs: statSync(resolved).mtimeMs };
  });
}

function scanDirectory(dir: string, voice: string): Candidate[] {
  if (!existsSync(dir)) return [];
  const candidates: Candidate[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const path = resolve(dir, entry);
    const artifact = readArtifact(path);
    if (!artifact || artifact.voice !== voice) continue;
    candidates.push({ path, artifact, mtimeMs: statSync(path).mtimeMs });
  }
  return candidates;
}

/** Oldest→newest by recordedAt, mtime as the tiebreaker for same-second runs. */
function chronological(candidates: Candidate[]): Candidate[] {
  return candidates.toSorted((a, b) => {
    const recorded = Date.parse(a.artifact.recordedAt) - Date.parse(b.artifact.recordedAt);
    if (recorded !== 0) return recorded;
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.path.localeCompare(b.path);
  });
}

function readBehavior(): BehaviorRunEvidence | null {
  const path = arg("--behavior", "");
  const exitRaw = arg("--behavior-exit", "");
  if (path && exitRaw !== "") {
    throw new Error("pass either --behavior <evidence.json> or --behavior-exit <code>, not both");
  }
  if (path) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(path), "utf8"));
    } catch (error) {
      throw new Error(`--behavior ${path}: cannot read behavior-run evidence (${error instanceof Error ? error.message : String(error)})`);
    }
    return parseBehaviorRunEvidence(raw);
  }
  if (exitRaw === "") return null;
  if (!/^\d+$/.test(exitRaw)) throw new Error(`--behavior-exit needs an exit code, got "${exitRaw}"`);
  const fingerprintRaw = arg("--behavior-fingerprint", "");
  if (!fingerprintRaw) {
    throw new Error(
      "--behavior-exit needs --behavior-fingerprint <head>:<dirtyHash>:<clean|dirty> so the exit result is bound to code (or pass --behavior <evidence.json>)",
    );
  }
  const match = /^([0-9a-f]{7,64}):([0-9a-f]{64}):(clean|dirty)$/i.exec(fingerprintRaw);
  if (!match) {
    throw new Error(
      `--behavior-fingerprint needs <git-head>:<sha256-dirty-hash>:<clean|dirty>, got "${fingerprintRaw}"`,
    );
  }
  const exitCode = Number(exitRaw);
  return {
    kind: BEHAVIOR_RUN_EVIDENCE_KIND,
    schemaVersion: BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION,
    mode: "behavior",
    passed: exitCode === 0,
    exitCode,
    recordedAt: new Date().toISOString(),
    command: "npm run test:e2e:behavior (exit result)",
    codeFingerprint: { head: match[1], dirtyHash: match[2], dirty: match[3].toLowerCase() === "dirty" },
  };
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
  const artifacts = candidates.slice(-3).map((candidate) => candidate.artifact);
  const behavior = readBehavior();
  const result = evaluateScoreStreak({ artifacts, gateVoice: voice, behavior });
  console.log(formatStreakVerdict(result));
  if (candidates.length > 0) {
    console.log(`artifacts: ${candidates.slice(-3).map((candidate) => basename(candidate.path)).join(", ")}`);
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
