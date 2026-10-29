/**
 * Compact scoreboard inspector (retro #2/#9).
 *
 *   npm run scoreboard:inspect -- --artifact <path> [--session <id>] [--events <path>] [--json]
 *
 * Reads one scoreboard artifact and prints the triage view: run identity,
 * scenario verdicts, gates/sub-scores, per-session Call-trace turn rows
 * (gap/cut/heard/resume/aside) with each turn's latency split and band, the
 * ordinary vs post-cut summary (`perceived` report-only), drain/aside/hang-up
 * numbers, playout timings and only the last failures. `--events <path>` summarizes the eval's opt-in
 * JSONL stream (`eval:demo-agent -- --events <path>`). `--json` prints the
 * same compact structure for a machine.
 *
 * Read-only and offline: no live audio, no network, no git. A missing or
 * unreadable artifact (or event file) is a clear error and exit 1; the command
 * never invents a blank report.
 */
import { resolve } from "node:path";
import { readEvalEvents, summarizeEvalEvents } from "../src/lib/demo/eval-events";
import { buildInspectReport, formatInspectReport } from "../src/lib/demo/scoreboard-report";
import { readScoreboardArtifactFile } from "../src/lib/demo/artifact-reader";

const USAGE = `Usage: npm run scoreboard:inspect -- --artifact <path> [options]

  --artifact <path>   scoreboard artifact JSON (required)
  --session <id>      only the Call-trace rows for this session (sess_…)
  --events <path>     eval event JSONL (eval:demo-agent -- --events <path>)
  --json              print the compact structure as JSON
  --help              this text

Read-only. Missing/unreadable files exit 1.`;

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const artifactPath = arg("--artifact", "");
  if (!artifactPath) throw new Error("--artifact <path> is required (see --help)");
  // The one reader: the same parse the runner and the matrix use, so a cascade
  // artifact and a managed artifact go through exactly one code path.
  const artifact = readScoreboardArtifactFile(resolve(artifactPath));
  const eventsPath = arg("--events", "");
  const events = eventsPath ? summarizeEvalEvents(readEvalEvents(resolve(eventsPath))) : null;
  const sessionId = arg("--session", "") || null;
  let report;
  try {
    report = buildInspectReport(artifact, { sessionId, events });
  } catch (error) {
    throw new Error(
      `artifact ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (sessionId && report.sessions.length === 0) {
    throw new Error(`artifact ${artifactPath}: no Call-trace session ${sessionId}`);
  }
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(report, null, 2)
      : formatInspectReport(report),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
