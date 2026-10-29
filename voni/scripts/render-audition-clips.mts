/**
 * W1 audition clips — the only producer of `public/voices/*.mp3`.
 *
 *   npm run voice:clips                    # render every catalog voice
 *   npm run voice:clips -- --voice lola    # finish one voice (the pending list's command)
 *   npm run voice:clips -- --voice lola --force   # ignore the cached native render
 *   npm run voice:clips -- --check         # no credentials: plan vs evidence vs bytes
 *   npm run voice:clips -- --strict        # exit non-zero if any voice is pending
 *
 * ── Why it exists ─────────────────────────────────────────────────────────
 * The old clips were hand captures made once through the Voice Agent API: six
 * were re-encoded twice at a low bitrate, gain was baked into some, and the
 * German and Italian files greeted in English. There was no script, so a clip
 * could drift from the voice it claimed to be and nothing would notice.
 *
 * Each clip comes from the same place the agent speaks: a silent-greeting
 * session with the voice and the greeting text — the same payload
 * `silentGreetingSession` gives the agent — at the voice's native level (the
 * payload carries no `output.volume`). The line is `voniConfig(voice).greeting`,
 * i.e. `VONI_GREETINGS[voice.languageCode]`, so the clip cannot speak a
 * different sentence, or a different Locale, than the agent.
 *
 * The native PCM is written under `.voice-clips/` (gitignored working files),
 * encoded once to the committed MP3 at 160 kbps mono 24 kHz, then decoded,
 * measured, and re-encoded at the 128 kbps delivery bitrate to prove the clip
 * survives it. What was measured is written to
 * `evidence/audition-clips/clips.json`, which the test reads without a call.
 *
 * ── Missing credentials are visible, never faked ──────────────────────────
 * A voice that cannot be rendered gets no file (any stale file is removed),
 * a named reason and the exact command in the pending list. `--strict` turns
 * that into a failing run for CI.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VOICES, getVoice } from "../src/lib/agents/voices";
import { voiceLevelMeasurement } from "../src/lib/agents/voice-levels";
import {
  AUDITION_ASSET_DIR,
  AUDITION_BITRATE_KBPS,
  AUDITION_LEVEL_TOLERANCE_LU,
  AUDITION_MANIFEST_PATH,
  AUDITION_SECOND_ENCODE_KBPS,
  AUDITION_SOURCE_DIR,
  MIN_SURVIVING_BITRATE_KBPS,
  auditionClipFor,
  auditionClipPlan,
  auditionClipProblems,
  auditionPendingCommand,
  type AuditionClipRecord,
  type AuditionManifest,
  type AuditionPending,
} from "../src/lib/demo/audition-clips";
import { mp3Facts } from "../src/lib/demo/mp3-facts";
import { referencePath, renderReference } from "../src/lib/demo/reference-render";
import { collectSilentGreeting } from "../src/lib/voice/silent-greeting";
import { produceAuditionClip } from "./lib/audition-produce";
import { hasFfmpeg } from "./lib/mp3-encode";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASSET_DIR = join(ROOT, AUDITION_ASSET_DIR);
const SOURCE_DIR = join(ROOT, AUDITION_SOURCE_DIR);
const MANIFEST = join(ROOT, AUDITION_MANIFEST_PATH);

const USAGE = `Usage: npm run voice:clips -- [options]

  --voice <id>   render or refresh only this catalog voice
  --force        ignore the cached native render for this voice
  --check        verify the plan, evidence and committed bytes (no credentials)
  --strict       exit non-zero when any voice is pending

Needs ASSEMBLYAI_API_KEY for a render. Writes public/voices/<id>.mp3 and
${AUDITION_MANIFEST_PATH}. Never fabricates audio for a voice it cannot render.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

const flag = (name: string) => process.argv.includes(name);

function fail(message: string): never {
  console.error(`audition clips failed: ${message}`);
  process.exit(1);
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

async function token(): Promise<string> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new Error("ASSEMBLYAI_API_KEY is not set: run with --env-file-if-exists=.dev.vars");
  }
  const url = new URL("https://agents.assemblyai.com/v1/token");
  url.searchParams.set("expires_in_seconds", "60");
  url.searchParams.set("max_session_duration_seconds", "60");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`token ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { token: string }).token;
}

async function renderVoice(voiceId: string, opts: { force: boolean }): Promise<AuditionClipRecord> {
  const clip = auditionClipFor(voiceId);
  const assetPath = join(ROOT, clip.asset);

  if (opts.force) {
    const cached = referencePath(SOURCE_DIR, clip.voiceId, clip.text);
    if (existsSync(cached)) rmSync(cached);
    if (existsSync(assetPath)) rmSync(assetPath);
  }

  // One token per voice: a run of sixteen greetings is longer than one token's
  // life, and a cache hit must not need a token at all.
  const sessionToken = existsSync(referencePath(SOURCE_DIR, clip.voiceId, clip.text))
    ? null
    : await token();

  const rendered = await renderReference({
    voiceId: clip.voiceId,
    dir: SOURCE_DIR,
    synth: async ({ voiceId: voice, text }) =>
      collectSilentGreeting({
        voiceId: voice,
        text,
        // `renderReference` only calls the synth on a cache miss, so the token
        // above exists exactly when this branch is reached.
        token: sessionToken ?? (await token()),
      }),
  });

  const produced = produceAuditionClip({ sourceWav: rendered.path, output: assetPath });
  const record: AuditionClipRecord = {
    voice: clip.voiceId,
    locale: clip.locale,
    line: clip.text,
    lineSha256: clip.textSha256,
    asset: clip.asset,
    url: clip.url,
    volume: clip.volume,
    facts: produced.facts,
    level: {
      ...produced.level,
      // Audit only: the standalone TTS measurement, when the voice has one.
      // The session and TTS paths normalize differently, so this is recorded,
      // never used as the clip's level gate.
      referenceIntegratedLufs: voiceLevelMeasurement(clip.voiceId)?.integratedLufs ?? null,
    },
    generatedOn: today(),
  };

  const problems = auditionClipProblems(clip, record);
  if (problems.length > 0) {
    rmSync(assetPath, { force: true });
    throw new Error(`the committed clip would not match its voice: ${problems.join(" | ")}`);
  }
  return record;
}

function emptyManifest(): AuditionManifest {
  return {
    schemaVersion: 1,
    generatedOn: today(),
    command: "cd voni && npm run voice:clips",
    source:
      "silent-greeting Voice Agent session (output.voice only: no output.volume, no gain, no limiter), " +
      "the same payload the agent speaks through",
    bitrateKbps: AUDITION_BITRATE_KBPS,
    minSurvivingBitrateKbps: MIN_SURVIVING_BITRATE_KBPS,
    secondEncodeKbps: AUDITION_SECOND_ENCODE_KBPS,
    levelToleranceLu: AUDITION_LEVEL_TOLERANCE_LU,
    clips: [],
    pending: [],
  };
}

function readManifest(): AuditionManifest | null {
  if (!existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8")) as AuditionManifest;
  } catch (error) {
    fail(`${AUDITION_MANIFEST_PATH} is not readable as evidence: ${String(error)}`);
  }
}

function sortManifest(manifest: AuditionManifest): AuditionManifest {
  const order = new Map(VOICES.map((voice, index) => [voice.id, index]));
  const byVoice = (a: { voice: string }, b: { voice: string }) =>
    (order.get(a.voice) ?? 99) - (order.get(b.voice) ?? 99);
  return { ...manifest, clips: [...manifest.clips].sort(byVoice), pending: [...manifest.pending].sort(byVoice) };
}

function pendingFor(voiceId: string, reason: string): AuditionPending {
  const clip = auditionClipFor(voiceId);
  return {
    voice: voiceId,
    locale: clip.locale,
    reason,
    command: auditionPendingCommand(voiceId),
  };
}

/** Render the requested voices, keeping every voice's evidence honest. */
async function generate(): Promise<void> {
  if (!hasFfmpeg()) fail("ffmpeg is not on PATH: the clip encoder needs it");

  const only = arg("--voice");
  if (only && !getVoice(only)) fail(`unknown voice "${only}": audition clips need a catalog voice`);

  // A full run is authoritative: a voice removed from the catalog loses its
  // record and its asset rather than living on as an unplanned preview.
  const previous = only ? readManifest() : null;
  const clips = new Map((previous?.clips ?? []).map((record) => [record.voice, record]));
  const pending = new Map((previous?.pending ?? []).map((entry) => [entry.voice, entry]));

  const targets = only ? [auditionClipFor(only)] : auditionClipPlan();
  for (const clip of targets) {
    const voiceId = clip.voiceId;
    try {
      const record = await renderVoice(voiceId, { force: flag("--force") });
      clips.set(voiceId, record);
      pending.delete(voiceId);
      console.log(
        `${voiceId.padEnd(9)} ${clip.locale}  ${record.facts.durationMs} ms  ` +
          `${record.facts.bitrateKbps} kbps  ${record.level.assetIntegratedLufs} LUFS  ` +
          `peak ${record.level.assetTruePeakDbtp} dBTP  → ${record.asset}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // No audio is fabricated for a voice that could not be rendered; a stale
      // file from a previous run must not stand in for it either.
      rmSync(join(ROOT, clip.asset), { force: true });
      clips.delete(voiceId);
      pending.set(voiceId, pendingFor(voiceId, reason));
      console.error(`${voiceId.padEnd(9)} ${clip.locale}  PENDING: ${reason}`);
    }
  }

  if (!only) {
    // The script is the only producer: a preview no plan asks for is a hand
    // capture, and a full run removes it rather than leaving it to be played.
    const planned = new Set(auditionClipPlan().map((clip) => `${clip.voiceId}.mp3`));
    for (const name of readdirSync(ASSET_DIR).filter((entry) => entry.endsWith(".mp3"))) {
      if (!planned.has(name)) {
        rmSync(join(ASSET_DIR, name), { force: true });
        console.error(`removed ${name}: not a planned audition clip`);
      }
    }
  }

  if (only) {
    // A one-voice run does not claim the other voices were rendered now: a
    // voice with no evidence and no committed asset is visibly pending.
    for (const clip of auditionClipPlan()) {
      if (clips.has(clip.voiceId) || pending.has(clip.voiceId)) continue;
      pending.set(
        clip.voiceId,
        pendingFor(clip.voiceId, "not rendered in this run: run the full clips command"),
      );
    }
  }

  const manifest = sortManifest({ ...emptyManifest(), clips: [...clips.values()], pending: [...pending.values()] });
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  report(manifest);
}

/** Verify the plan, the evidence and the committed bytes without a call. */
function check(): void {
  const manifest = readManifest();
  if (!manifest) fail(`${AUDITION_MANIFEST_PATH} is missing: run the clips command first`);

  const problems: string[] = [];
  const covered = new Map<string, "clip" | "pending">();
  for (const record of manifest.clips) {
    covered.set(record.voice, "clip");
    const clip = auditionClipFor(record.voice);
    for (const problem of auditionClipProblems(clip, record)) problems.push(`${record.voice}: ${problem}`);
    const asset = join(ROOT, record.asset);
    if (!existsSync(asset)) {
      problems.push(`${record.voice}: ${record.asset} is recorded but not committed`);
      continue;
    }
    const facts = mp3Facts(new Uint8Array(readFileSync(asset)));
    if (facts.bitrateKbps !== record.facts.bitrateKbps) {
      problems.push(`${record.voice}: the committed bytes are ${facts.bitrateKbps} kbps, not ${record.facts.bitrateKbps}`);
    }
    if (facts.bitrateKbps < MIN_SURVIVING_BITRATE_KBPS) {
      problems.push(`${record.voice}: ${facts.bitrateKbps} kbps does not survive a second encode`);
    }
  }
  for (const entry of manifest.pending) {
    covered.set(entry.voice, "pending");
    if (!entry.reason.trim()) problems.push(`${entry.voice}: pending without a reason`);
    if (entry.command !== auditionPendingCommand(entry.voice)) {
      problems.push(`${entry.voice}: pending command is not the exact one to run`);
    }
    if (existsSync(join(ROOT, `public/voices/${entry.voice}.mp3`))) {
      problems.push(`${entry.voice}: is pending but has a committed asset`);
    }
  }
  for (const voice of VOICES) {
    if (!covered.has(voice.id)) problems.push(`${voice.id}: neither a clip nor visibly pending`);
  }

  const planned = new Set(manifest.clips.map((record) => `voices/${record.voice}.mp3`));
  for (const name of readdirSync(ASSET_DIR).filter((entry) => entry.endsWith(".mp3"))) {
    if (!planned.has(`voices/${name}`)) problems.push(`public/voices/${name}: not produced by the script`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    fail(`${problems.length} problem(s) in the audition clips`);
  }
  report(manifest);
}

function report(manifest: AuditionManifest): void {
  const measured = manifest.clips.length;
  console.log(`\naudition clips: ${measured} committed, ${manifest.pending.length} pending`);
  if (manifest.pending.length > 0) {
    console.error("PENDING — no clip committed, no audio fabricated:");
    for (const entry of manifest.pending) {
      console.error(`  ${entry.voice} (${entry.locale}): ${entry.reason}`);
      console.error(`    run: ${entry.command}`);
    }
  }
}

async function main(): Promise<void> {
  if (flag("--help")) {
    console.log(USAGE);
    return;
  }
  if (flag("--check")) {
    check();
    return;
  }
  await generate();
  if (flag("--strict")) {
    const manifest = readManifest();
    if (manifest && manifest.pending.length > 0) {
      fail(`${manifest.pending.length} voice(s) pending: ${manifest.pending.map((entry) => entry.voice).join(", ")}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(`audition clips failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
