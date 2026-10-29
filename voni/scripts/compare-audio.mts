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
 * is measurements only; naming the first divergence is the verdict's job
 * (`lib/audio/comparison.ts` exposes the rows for it).
 */
import { resolve } from "node:path";
import {
  CAPTURE_ROLES,
  compareCaptures,
  formatComparisonTable,
  type CaptureInput,
  type CaptureRole,
} from "../src/lib/audio/comparison";
import { decodeAudioFile } from "../src/lib/audio/format-facts";

const USAGE = `Usage: npm run voice:compare -- <captures>

  --reference <file.wav>   rendering of the line in the same voice, outside a call
  --platform  <file.wav>   the agent channel of the platform's recording
  --delivered <file.wav>   what the browser's playout emitted

Compares three saved 16-bit PCM WAVs of one line. No call is placed. The
reference is the baseline for the distortion residual.`;

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
  console.log(formatComparisonTable(compareCaptures(captures)));
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
