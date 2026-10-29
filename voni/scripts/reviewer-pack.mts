/**
 * W5 parity proof — the only producer of `evidence/reviewer-packs/`.
 *
 *   npm run voice:packs                     # build every pack from the audition clips
 *   npm run voice:packs -- --voice lola     # rebuild one pack
 *   npm run voice:packs -- --check          # verify packs against the clips and bytes
 *   npm run voice:packs -- --strict         # exit non-zero until every pack is complete
 *
 * ── Why it exists ─────────────────────────────────────────────────────────
 * The acceptance bar needs a pack a named native reviewer can be handed without
 * anyone assembling it: one recording per voice and Locale, a ballot that
 * cannot be half-filled, written reasons kept with the scores, and the
 * reviewer's name and date. The recording is the committed audition clip
 * (`public/voices/<voice>.mp3`, tickets 38/39), referenced by its sha256, so the
 * parity proof runs while a Locale is still being judged.
 *
 * The script never invents a reviewer or a score. A pack is written **pending**;
 * the owner supplies the reviewer (spec: *Open dependency: named reviewers*).
 * A filed verdict is carried across regeneration only while the recording is
 * the same bytes the reviewer heard — a new clip invalidates the old verdict,
 * because it is a verdict about audio nobody can hear now.
 *
 * ── Filing a verdict ──────────────────────────────────────────────────────
 * A reviewer fills the ballot and an operator saves it as:
 *
 *   { "reviewer": "…", "reviewedOn": "YYYY-MM-DD", "locale": "es",
 *     "scores": { "timbre": 5, "accent": 4, "languageNaturalness": 5 },
 *     "reasons": { "accent": "…" } }
 *
 * then runs `npm run voice:packs -- --verdict <file> --voice lola`, which
 * refuses a missing reviewer, a missing date, a missing axis, a score below
 * five without a written reason, or a mismatched Locale — by name.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VOICES, getVoice } from "../src/lib/agents/voices";
import { AUDITION_MANIFEST_PATH, type AuditionClipRecord, type AuditionManifest } from "../src/lib/demo/audition-clips";
import {
  REVIEWER_PACK_COMMAND,
  REVIEWER_PACK_DIR,
  REVIEWER_PACK_INDEX_PATH,
  ReviewerPackError,
  buildPackIndex,
  carryVerdict,
  fileVerdict,
  formatReviewerPack,
  packMissing,
  packStatus,
  recordingBytesProblem,
  recordingProblems,
  recordingSha256,
  reviewerPackFor,
  reviewerPackProblems,
  type ReviewerPack,
  type ReviewerVerdict,
} from "../src/lib/demo/reviewer-pack";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACK_DIR = join(ROOT, REVIEWER_PACK_DIR);
const INDEX = join(ROOT, REVIEWER_PACK_INDEX_PATH);
const MANIFEST = join(ROOT, AUDITION_MANIFEST_PATH);

const USAGE = `Usage: npm run voice:packs -- [options]

  --voice <id>      rebuild only this catalog voice's pack
  --check           verify the packs against clips.json and the committed bytes
  --strict          exit non-zero unless every pack is complete (the acceptance bar)
  --verdict <file>  file a reviewer's verdict JSON into --voice <id>
  --force           rebuild even a pack whose recording is unchanged

Writes ${REVIEWER_PACK_DIR}/<voice>.json, <voice>.md and packs.json. No
credentials and no call: the recording is the committed audition clip.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

const flag = (name: string) => process.argv.includes(name);

function fail(message: string): never {
  console.error(`reviewer packs failed: ${message}`);
  process.exit(1);
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function readManifest(): AuditionManifest {
  if (!existsSync(MANIFEST)) {
    fail(`${AUDITION_MANIFEST_PATH} is missing: run \`npm run voice:clips\` first`);
  }
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8")) as AuditionManifest;
  } catch (error) {
    fail(`${AUDITION_MANIFEST_PATH} is not readable as evidence: ${String(error)}`);
  }
}

function readPack(voice: string): ReviewerPack | null {
  const path = join(PACK_DIR, `${voice}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ReviewerPack;
  } catch (error) {
    fail(`${REVIEWER_PACK_DIR}/${voice}.json is not readable: ${String(error)}`);
  }
}

/** The recorded hash of the committed clip, or a named failure. */
function committedSha(record: AuditionClipRecord): string {
  const asset = join(ROOT, record.asset);
  if (!existsSync(asset)) {
    fail(`${record.voice}: ${record.asset} is recorded in clips.json but not committed`);
  }
  return recordingSha256(new Uint8Array(readFileSync(asset)));
}

function writePack(pack: ReviewerPack): void {
  writeFileSync(join(PACK_DIR, `${pack.voice}.json`), `${JSON.stringify(pack, null, 2)}\n`);
  writeFileSync(join(PACK_DIR, `${pack.voice}.md`), `${formatReviewerPack(pack)}\n`);
}

function sortByVoice<T extends { voice: string }>(items: T[]): T[] {
  const order = new Map(VOICES.map((voice, index) => [voice.id, index]));
  return [...items].sort((a, b) => (order.get(a.voice) ?? 99) - (order.get(b.voice) ?? 99));
}

function indexFor(packs: ReviewerPack[]) {
  return buildPackIndex(sortByVoice(packs), {
    generatedOn: today(),
    source: AUDITION_MANIFEST_PATH,
  });
}

/** Build the requested packs, preserving any verdict that judged the same bytes. */
function generate(): void {
  const manifest = readManifest();
  const only = arg("--voice");
  if (only && !getVoice(only)) fail(`unknown voice "${only}": a pack judges a catalog voice`);
  if (only && !manifest.clips.some((clip) => clip.voice === only)) {
    fail(`${only}: has no committed audition clip; run \`npm run voice:clips -- --voice ${only}\` first`);
  }

  mkdirSync(PACK_DIR, { recursive: true });

  const targets = only ? manifest.clips.filter((clip) => clip.voice === only) : manifest.clips;
  const packs = new Map<string, ReviewerPack>();

  if (!only) {
    // A full run is authoritative: every voice's pack comes from the evidence.
    for (const entry of readdirSync(PACK_DIR)) {
      if (/\.(json|md)$/.test(entry) && entry !== "packs.json" && entry !== "README.md") {
        rmSync(join(PACK_DIR, entry), { force: true });
      }
    }
  } else {
    for (const voice of VOICES) {
      const existing = readPack(voice.id);
      if (existing) packs.set(voice.id, existing);
    }
  }

  for (const record of targets) {
    const sha256 = committedSha(record);
    const next = reviewerPackFor(record, sha256, {
      generatedOn: today(),
      source: AUDITION_MANIFEST_PATH,
    });
    const previous = flag("--force") ? null : readPack(record.voice);
    const pack = carryVerdict(previous, next);
    if (previous?.verdict && !pack.verdict) {
      console.log(
        `${record.voice}: the recording changed, so the previous verdict was dropped: ` +
          "the reviewer judged audio nobody can hear now",
      );
    }
    packs.set(record.voice, pack);
    writePack(pack);
    reportPack(pack);
  }

  if (only) {
    for (const clip of manifest.clips) {
      if (packs.has(clip.voice)) continue;
      fail(`${clip.voice}: no pack on disk; run the full \`npm run voice:packs\``);
    }
  }

  const index = indexFor([...packs.values()]);
  writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`);
  reportIndex(index);
}

/** Verify the packs against the clips evidence and the committed bytes. */
function check(): void {
  const manifest = readManifest();
  const problems: string[] = [];
  const packs: ReviewerPack[] = [];

  for (const record of manifest.clips) {
    const pack = readPack(record.voice);
    if (!pack) {
      problems.push(`${record.voice}: no pack at ${REVIEWER_PACK_DIR}/${record.voice}.json`);
      continue;
    }
    packs.push(pack);

    for (const problem of recordingProblems(pack)) {
      problems.push(`${record.voice}: ${problem.field}: ${problem.message}`);
    }
    if (pack.recording) {
      if (pack.recording.asset !== record.asset) {
        problems.push(`${record.voice}: pack recording is ${pack.recording.asset}, not the committed ${record.asset}`);
      }
      if (pack.recording.locale !== record.locale) {
        problems.push(`${record.voice}: pack recording is the ${pack.recording.locale} clip, not ${record.locale}`);
      }
      if (pack.recording.lineSha256 !== record.lineSha256) {
        problems.push(`${record.voice}: pack line does not hash to the committed greeting`);
      }
      if (pack.recording.durationMs !== record.facts.durationMs) {
        problems.push(`${record.voice}: pack recording duration drifted from the committed clip`);
      }
      const bytes = recordingBytesProblem(pack, committedSha(record));
      if (bytes) problems.push(`${record.voice}: ${bytes.field}: ${bytes.message}`);
    }

    const status = packStatus(pack);
    if (status === "incomplete") {
      for (const problem of reviewerPackProblems(pack)) {
        problems.push(`${record.voice}: ${problem.field}: ${problem.message}`);
      }
    }
    if (pack.verdict && packMissing(pack).length > 0) {
      problems.push(`${record.voice}: verdict is missing ${packMissing(pack).join(", ")}`);
    }

    const sheet = join(PACK_DIR, `${record.voice}.md`);
    if (!existsSync(sheet)) {
      problems.push(`${record.voice}: no hand-off sheet at ${REVIEWER_PACK_DIR}/${record.voice}.md`);
    } else if (readFileSync(sheet, "utf8") !== `${formatReviewerPack(pack)}\n`) {
      problems.push(`${record.voice}: the hand-off sheet does not match the pack record; rebuild it`);
    }
  }

  const packed = new Set(manifest.clips.map((clip) => `${clip.voice}.json`));
  for (const entry of readdirSync(PACK_DIR)) {
    if ((entry.endsWith(".json") || entry.endsWith(".md")) && entry !== "packs.json" && entry !== "README.md") {
      if (!packed.has(entry) && !packed.has(entry.replace(/\.md$/, ".json"))) {
        problems.push(`${REVIEWER_PACK_DIR}/${entry}: not a pack for a committed audition clip`);
      }
    }
  }

  if (!existsSync(INDEX)) {
    problems.push(`${REVIEWER_PACK_INDEX_PATH} is missing`);
  } else {
    const expected = indexFor(packs);
    const committed = JSON.parse(readFileSync(INDEX, "utf8")) as ReturnType<typeof indexFor>;
    const strip = (index: ReturnType<typeof indexFor>) => ({ ...index, generatedOn: "" });
    if (JSON.stringify(strip(committed)) !== JSON.stringify(strip(expected))) {
      problems.push(`${REVIEWER_PACK_INDEX_PATH} does not match the packs on disk; rebuild it`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    fail(`${problems.length} problem(s) in the reviewer packs`);
  }
  reportIndex(indexFor(packs));
}

/** File a reviewer's verdict JSON, refusing anything incomplete by name. */
function fileFromFile(): void {
  const voice = arg("--voice");
  const path = arg("--verdict");
  if (!voice) fail("--verdict needs --voice <id>: a verdict belongs to one Locale's pack");
  if (!path) fail("--verdict needs a path to the reviewer's verdict JSON");
  const pack = readPack(voice);
  if (!pack) fail(`no pack for ${voice}: run \`npm run voice:packs -- --voice ${voice}\` first`);

  let verdict: ReviewerVerdict;
  try {
    verdict = JSON.parse(readFileSync(path, "utf8")) as ReviewerVerdict;
  } catch (error) {
    fail(`${path} is not readable as a verdict JSON: ${String(error)}`);
  }

  const filed = fileVerdict(pack, verdict);
  writePack(filed);
  const index = indexFor(VOICES.map((known) => readPack(known.id) ?? null).filter((p): p is ReviewerPack => p !== null));
  writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`);
  reportPack(filed);
  if (packStatus(filed) !== "complete") fail(`${voice}: the verdict did not complete the pack`);
}

function reportPack(pack: ReviewerPack): void {
  const status = packStatus(pack);
  const recording = pack.recording ? pack.recording.sha256.slice(0, 12) : "no recording";
  const reviewer = pack.verdict?.reviewer ?? `pending: ${packMissing(pack).join(", ")}`;
  console.log(`${pack.voice.padEnd(9)} ${pack.locale}  ${recording}  ${status.padEnd(10)} ${reviewer}`);
}

function reportIndex(index: ReturnType<typeof indexFor>): void {
  console.log(
    `\nreviewer packs: ${index.counts.total} total, ${index.counts.complete} complete, ` +
      `${index.counts.pending} pending reviewer, ${index.counts.incomplete} incomplete`,
  );
  if (index.counts.pending > 0) {
    console.log(
      "PENDING — owner input: a named native reviewer and date for each Locale. " +
        "A pending Locale is not done; it is not labelled beta and it is not dropped.",
    );
  }
  if (index.counts.incomplete > 0) {
    console.error("INCOMPLETE — not a pass:");
    for (const entry of index.packs.filter((pack) => pack.status === "incomplete")) {
      console.error(`  ${entry.voice} (${entry.locale}): ${entry.pack}`);
    }
  }
}

function main(): void {
  if (flag("--help")) {
    console.log(USAGE);
    return;
  }
  if (flag("--verdict")) {
    fileFromFile();
    return;
  }
  if (flag("--check")) {
    if (flag("--verdict")) fail("--check and --verdict are different runs");
    check();
    return;
  }
  generate();

  if (flag("--strict")) {
    const manifest = readManifest();
    const pending = manifest.clips
      .map((clip) => readPack(clip.voice))
      .filter((pack): pack is ReviewerPack => pack !== null && packStatus(pack) !== "complete");
    if (pending.length > 0) {
      fail(`${pending.length} pack(s) not complete: ${pending.map((pack) => pack.voice).join(", ")}`);
    }
  }
}

try {
  main();
} catch (error) {
  if (error instanceof ReviewerPackError) {
    console.error(`reviewer packs refused ${error.problems.length} problem(s):`);
    for (const problem of error.problems) {
      const field = problem.axis ? `${problem.field}:${problem.axis}` : problem.field;
      console.error(`  ${field}: ${problem.message}`);
    }
    process.exit(1);
  }
  console.error(`reviewer packs failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
