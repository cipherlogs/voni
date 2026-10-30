/**
 * The kill-criterion gate (meta-cascade M13, ticket 119).
 *
 * `evaluateKillCriterion` is the seam; this command is its caller, so the
 * criterion can actually stop a cutover instead of living as an unused library.
 * It reads measured round artifacts off disk (one subdirectory per round, or a
 * flat directory as one round), judges them through the same artifact reader
 * every scoreboard uses, and prints one status:
 *
 *   OK            the criterion is clear; automatic cutover may proceed
 *   BLOCKED       a round passed the reply gap but failed another required gate
 *   KILLED        three measured rounds failed the reply-gap budget
 *   RISK-ACCEPTED the owner recorded a dated risk acceptance; never a pass
 *   INCOMPLETE    not enough measured rounds to judge
 *
 * Exit 0 only for OK. KILLED is always non-zero, and a dated risk acceptance is
 * not a pass either: it is a decision record, so the cutover stays stopped.
 *
 *   npm run scoreboard:kill -- --from scoreboard-runs/rounds
 *   npm run scoreboard:kill -- --from scoreboard-runs/round-1
 *   npm run scoreboard:kill -- --from scoreboard-runs/rounds \
 *     --acceptance docs/adr/0012-risk-acceptance.json --out kill.json
 *
 * Round layout: every immediate subdirectory of `--from` is one round, labelled
 * by its directory name, and its `*.json` files are that round's measured runs.
 * A `--from` with only files is one round named after the directory. Artifacts
 * are ordered by their own `recordedAt` (then run id), never by filename, so a
 * subject's consecutive clean pair is the measured order.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  evaluateKillCriterion,
  validateOwnerRiskAcceptance,
  type KillCriterionStatus,
  type KillCriterionVerdict,
  type OwnerRiskAcceptance,
  type RoundInput,
} from "../src/lib/demo/kill-criterion";
import { readScoreboardArtifactFile } from "../src/lib/demo/artifact-reader";
import type { ScoreboardArtifact } from "../src/lib/demo/scoreboard";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/** The report's display vocabulary: PASS is the only status that opens a gate. */
function displayStatus(status: KillCriterionStatus): "OK" | KillCriterionStatus {
  return status === "PASS" ? "OK" : status;
}

function artifactFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json") && !file.startsWith("."))
    .sort();
}

function readArtifacts(dir: string, label: string): ScoreboardArtifact[] {
  const files = artifactFiles(dir);
  const artifacts = files.map((file) => {
    const path = resolve(dir, file);
    try {
      return readScoreboardArtifactFile(path);
    } catch (error) {
      throw new Error(
        `kill criterion cannot read ${label}/${file}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
  // A subject's two consecutive clean runs are a measured-order property, not
  // a filename property (ticket 119): sort by the artifact's own clock.
  return artifacts.sort(
    (left, right) =>
      left.recordedAt.localeCompare(right.recordedAt) || left.runId.localeCompare(right.runId),
  );
}

/**
 * Read the round artifacts. One subdirectory is one measured round; a flat
 * directory is one round named after itself. Mixed layouts fail by name
 * instead of silently leaving one set of runs out of the criterion.
 */
export function readRounds(root: string): RoundInput[] {
  const dir = resolve(root);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`kill criterion cannot read --from ${dir}: not a directory`);
  }
  const entries = readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => !entry.name.startsWith("."),
  );
  const rounds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const files = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  );
  if (rounds.length > 0 && files.length > 0) {
    throw new Error(
      `kill criterion cannot read ${dir}: mixed layout; use one subdirectory per round or a flat directory of runs, not both`,
    );
  }
  if (rounds.length > 0) {
    return rounds
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .map((label) => ({ label, artifacts: readArtifacts(join(dir, label), label) }));
  }
  if (files.length === 0) {
    throw new Error(
      `kill criterion cannot read ${dir}: no round artifacts (expected <round>/*.json or *.json)`,
    );
  }
  const label = arg("--round-label", basename(dir));
  return [{ label, artifacts: readArtifacts(dir, label) }];
}

function readAcceptance(path: string): OwnerRiskAcceptance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(
      `kill criterion cannot read --acceptance ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // Validated here too, so a bad record fails before any round is judged and
  // the message names the field that cannot stand.
  return validateOwnerRiskAcceptance(parsed);
}

function formatRound(round: KillCriterionVerdict["rounds"][number]): string {
  const gap = round.replyGap === null ? "not judged" : `reply-gap ${round.replyGap.status}`;
  return (
    `${round.label.padEnd(16)} ${round.disposition.padEnd(10)} ${gap.padEnd(16)} ` +
    `${round.runs.length} run${round.runs.length === 1 ? "" : "s"}`
  );
}

function main(): void {
  const from = arg("--from", "");
  if (from === "") {
    throw new Error(
      "kill criterion needs --from <rounds-root>; one subdirectory per measured round, or a flat directory of runs",
    );
  }
  const rounds = readRounds(from);
  const acceptance = arg("--acceptance", "");
  const verdict = evaluateKillCriterion({
    rounds,
    ...(acceptance === "" ? {} : { acceptance: readAcceptance(acceptance) }),
  });
  const status = displayStatus(verdict.status);

  console.log(
    `rounds: ${verdict.rounds.length} (${verdict.measuredCount} measured, ${verdict.rerunRounds.length} re-run)`,
  );
  for (const round of verdict.rounds) console.log(formatRound(round));
  if (verdict.acceptance !== null) {
    console.log(
      `acceptance: ${verdict.acceptance.owner} on ${verdict.acceptance.acceptedOn} in ${verdict.acceptance.decisionRecord}`,
    );
  }
  console.log(`${status}  ${verdict.detail}`);

  const out = arg("--out", "");
  if (out !== "") {
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ status, verdict }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(`artifact: ${path}`);
  }

  // Only OK opens the cutover. KILLED must fail the command by name; a dated
  // risk acceptance is a decision record, never a pass; too little evidence is
  // not a green gate either.
  if (status !== "OK") process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
