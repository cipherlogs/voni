/**
 * W0 comparison — one table over three saved captures of the same line.
 *
 *   npm run voice:compare -- \
 *     --reference .voice-references/anna-<hash>.wav \
 *     --platform  voice-captures/<session>-agent-24000hz.wav \
 *     --delivered .captures/delivered-20261029-140506.wav
 *
 * The reference is a rendering of the line in the same voice outside a
 * conversation, the platform file is the agent channel the platform recorded,
 * and the delivered file is what the browser's playout actually emitted. All
 * three are read from disk: no call is placed, no network is used, and an old
 * call can be re-analysed as often as needed.
 *
 * Every file is decoded before anything is measured, so a missing or
 * unreadable capture fails by path before a table is printed. The table itself
 * is measurements only; the verdict after it names the first divergence as
 * reference, platform, model text or client. `--line` and `--transcript` are
 * what let it attribute a divergence to the model's words; without them the
 * verdict says model text was not checked rather than guessing.
 */
import { resolve } from "node:path";
import {
  CAPTURE_ROLES,
  compareCaptures,
  formatComparisonTable,
  type CaptureInput,
  type CaptureRole,
} from "../src/lib/audio/comparison";
import { decideVerdict } from "../src/lib/audio/verdict";
import { decodeAudioFile } from "../src/lib/audio/format-facts";

const USAGE = `Usage: npm run voice:compare -- <captures>

  --reference <file.wav>   rendering of the line in the same voice, outside a call
  --platform  <file.wav>   the agent channel of the platform's recording
  --delivered <file.wav>   what the browser's playout emitted

Optional, for attributing model text:

  --line        <text>     the line the agent was meant to say
  --transcript  <text>     the platform transcript of what it said

Compares three saved 16-bit PCM WAVs of one line and prints the table followed
by the first-divergence verdict. No call is placed. The reference is the
baseline for the distortion residual.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function fail(message: string): never {
  console.error(`comparison failed: ${message}`);
  process.exit(1);
}

function requiredPath(role: CaptureRole): string {
  const path = arg(`--${role}`);
  if (!path) fail(`--${role} is required\n\n${USAGE}`);
  return path;
}

function load(role: CaptureRole, path: string): CaptureInput {
  try {
    return { role, path: resolve(path), audio: decodeAudioFile(path) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`${role} capture unreadable: ${path}: ${reason}`);
  }
}

function main(): void {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  // Decode all three first: a refused capture must never leave a half table.
  const captures = CAPTURE_ROLES.map((role) => load(role, requiredPath(role)));
  const comparison = compareCaptures(captures);
  console.log(formatComparisonTable(comparison));

  const verdict = decideVerdict({
    comparison,
    intendedLine: arg("--line"),
    transcript: arg("--transcript"),
  });
  console.log("");
  console.log(`Verdict: ${verdict.sentence}`);
  console.log(
    `  thresholds: ${verdict.thresholds
      .map((entry) => `${entry.key} ${entry.value} ${entry.unit}`)
      .join(", ")} (src/lib/demo/scoreboard-budgets.ts)`,
  );
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
