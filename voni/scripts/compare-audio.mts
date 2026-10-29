/**
 * W0 comparison — one table over three saved captures of the same line, and
 * optionally the vendor-floor verdict.
 *
 *   npm run voice:compare -- \
 *     --reference .voice-references/anna-<hash>.wav \
 *     --platform  voice-captures/<session>-agent-24000hz.wav \
 *     --delivered .captures/delivered-20261029-140506.wav
 *
 *   npm run voice:compare -- --floor \
 *     --reference .voice-references/anna-<hash>.wav \
 *     --delivered .captures/delivered-20261029-140506.wav
 *
 * The reference is a rendering of the line in the same voice outside a
 * conversation, the platform file is the agent channel the platform recorded,
 * and the delivered file is what the browser's playout actually emitted. All
 * files are read from disk: no call is placed, no network is used, and an old
 * call can be re-analysed as often as needed.
 *
 * Every file is decoded before anything is measured, so a missing or
 * unreadable capture fails by path before a table is printed. The table itself
 * is measurements only; naming the first divergence is the verdict's job
 * (`lib/audio/comparison.ts` exposes the rows for it).
 *
 * `--floor` adds floor mode: the subject is judged against the committed vendor
 * floor (`lib/audio/vendor-floor.ts`) instead of against the previous take. It
 * fails only when it is *worse* than the floor on a measured axis — level,
 * peak headroom, distortion, breakups or modulation — and names that axis.
 * Being merely different does not fail; an axis the file cannot carry is
 * inconclusive rather than a pass.
 */
import { resolve } from "node:path";
import {
  CAPTURE_ROLES,
  compareCaptures,
  formatComparisonTable,
  type CaptureInput,
  type CaptureRole,
} from "../src/lib/audio/comparison";
import { compareToFloor, formatFloorVerdict } from "../src/lib/audio/floor-mode";
import { decodeAudioFile } from "../src/lib/audio/format-facts";
import { loadVendorFloor } from "../src/lib/audio/vendor-floor";

const USAGE = `Usage: npm run voice:compare -- <captures> [--floor]

  --reference <file.wav>   rendering of the line in the same voice, outside a call
  --platform  <file.wav>   the agent channel of the platform's recording
  --delivered <file.wav>   what the browser's playout emitted

  --floor                  judge the subject against the committed vendor floor
  --floor-voice <voice>    floor voice id (default anna)
  --floor-locale <locale>  floor Locale (default en)

Compares three saved 16-bit PCM WAVs of one line. No call is placed. The
reference is the baseline for the distortion residual.

With --floor, --reference and --delivered are required and the subject is judged
against the committed vendor floor: it fails when it is worse than the floor on
any measured axis (level, peak headroom, distortion, breakups, modulation), not
merely different from before. --platform is optional in floor mode; when given,
the three-way table is printed too.

Exit codes: 0 pass (or a table with no --floor), 1 fail, 2 inconclusive.`;

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

/** Three-way table mode: every role is required. */
function printTable(): void {
  const captures = CAPTURE_ROLES.map((role) => load(role, requiredPath(role)));
  console.log(formatComparisonTable(compareCaptures(captures)));
}

/**
 * Floor mode: the subject is its reference plus its delivered capture, and the
 * bar is the committed floor. The platform recording is not needed to judge the
 * subject, so it is only used when the caller also wants the three-way table.
 */
function printFloorVerdict(): void {
  const reference = load("reference", requiredPath("reference"));
  const delivered = load("delivered", requiredPath("delivered"));

  const platformPath = arg("--platform");
  if (platformPath) {
    const platform = load("platform", platformPath);
    console.log(formatComparisonTable(compareCaptures([reference, platform, delivered])));
    console.log("");
  }

  const floor = loadVendorFloor({
    voice: arg("--floor-voice"),
    locale: arg("--floor-locale"),
  });
  const comparison = compareToFloor({
    floor,
    subject: {
      reference: { path: reference.path, audio: reference.audio },
      delivered: { path: delivered.path, audio: delivered.audio },
    },
  });
  console.log(formatFloorVerdict(comparison));
  if (comparison.verdict === "fail") process.exitCode = 1;
  else if (comparison.verdict === "inconclusive") process.exitCode = 2;
}

function main(): void {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  if (process.argv.includes("--floor")) printFloorVerdict();
  else printTable();
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
