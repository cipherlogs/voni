import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VONI_GREETINGS } from "./voni-agent";
import { pcm16Wav } from "./reference-render";
import { mp3Facts } from "./mp3-facts";
import {
  AUDITION_REGENERATION_CREST_TOLERANCE_DB,
  AUDITION_REGENERATION_DURATION_RATIO,
  AUDITION_REGENERATION_LEVEL_TOLERANCE_LU,
  MIN_SURVIVING_BITRATE_KBPS,
  auditionClipFor,
  auditionClipPlan,
  auditionLineSha256,
  type AuditionClip,
  type AuditionClipRecord,
  type AuditionManifest,
} from "./audition-clips";
import {
  AuditionClipMissingError,
  AuditionTakeError,
  committedClipFor,
  readAuditionTake,
  regenerationProblems,
  regenerationPrerequisite,
} from "./clip-regeneration";
import { produceAuditionClip } from "../../../scripts/lib/audition-produce";
import { encodeAuditionMp3, hasFfmpeg } from "../../../scripts/lib/mp3-encode";

/**
 * W1 audition clips (voice-parity ticket 39): regenerate one clip from a
 * recorded take and compare it with the committed asset.
 *
 * The take is a **committed regeneration sample** of anna's greeting, rendered
 * after `public/voices/anna.mp3` was committed. The test drives the real
 * comparison (`regenerationProblems`) and the real encoder
 * (`produceAuditionClip`), but never a live session: no token, no socket, no
 * credential. The live path stays with `npm run voice:clips -- --check`, which
 * verifies the plan, the evidence and the committed bytes without a call.
 *
 * Vendor synthesis is nondeterministic (a fresh take is not a byte copy), so
 * the gate is the named tolerance table: 5% duration, 1 LU level, 3 dB crest.
 * A clip whose Locale or level does not match its voice fails; a missing clip
 * fails rather than skipping.
 */

const ROOT = new URL("../../../", import.meta.url);
const TAKE = new URL("evidence/audition-clips/takes/anna-en.json", ROOT);
const MANIFEST = new URL("evidence/audition-clips/clips.json", ROOT);

const manifest = (): AuditionManifest =>
  JSON.parse(readFileSync(MANIFEST, "utf8")) as AuditionManifest;

const assetExists = (asset: string) => existsSync(new URL(asset, ROOT));

const committedAnna = (): AuditionClipRecord =>
  committedClipFor(manifest(), "anna", { assetExists });

/** ffmpeg is the only prerequisite; the policy is proven below. */
function requireEncoder(t: TestContext): boolean {
  const decision = regenerationPrerequisite({
    name: "ffmpeg",
    present: hasFfmpeg(),
    ci: Boolean(process.env.CI),
    remedy: "install ffmpeg (the audition-clip encoder)",
  });
  if (decision.action === "fail") assert.fail(decision.reason);
  if (decision.action === "skip") {
    t.skip(decision.reason);
    return false;
  }
  return true;
}

function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "clip-regeneration-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Encode a take and measure it exactly as the generator would commit it. */
function regenerated(
  take: ReturnType<typeof readAuditionTake>,
  clip: AuditionClip,
  dir: string,
  opts: { suffix: string; gain?: number },
): AuditionClipRecord {
  const source = take.audio;
  const gain = opts.gain ?? 1;
  const pcm = Buffer.alloc(source.samples.length * 2);
  for (let i = 0; i < source.samples.length; i++) {
    const value = Math.max(-32_768, Math.min(32_767, Math.round(source.samples[i] * gain)));
    pcm.writeInt16LE(value, i * 2);
  }
  const sourceWav = join(dir, `${opts.suffix}-source.wav`);
  writeFileSync(sourceWav, pcm16Wav(pcm));

  const produced = produceAuditionClip({ sourceWav, output: join(dir, `${opts.suffix}.mp3`) });
  return {
    voice: take.evidence.voice,
    locale: take.evidence.locale,
    line: take.evidence.line,
    lineSha256: auditionLineSha256(take.evidence.line),
    asset: clip.asset,
    url: clip.url,
    volume: 100,
    facts: produced.facts,
    level: produced.level,
    generatedOn: "2026-10-29",
  };
}

/** The measured take, encoded once, is the regeneration the test compares. */
function freshTake(dir: string): { clip: AuditionClip; record: AuditionClipRecord } {
  const clip = auditionClipFor("anna");
  return {
    clip,
    record: regenerated(readAuditionTake(fileURLToPath(TAKE)), clip, dir, { suffix: "fresh" }),
  };
}

test("a fresh take of the committed clip regenerates within the named tolerances", (t) => {
  if (!requireEncoder(t)) return;
  withTemp((dir) => {
    const { clip, record } = freshTake(dir);
    const committed = committedAnna();
    assert.deepEqual(
      regenerationProblems(clip, committed, record),
      [],
      "the committed anna clip is still this voice, this Locale and this line at native level",
    );
    // The take is a different performance, not a byte copy: the tolerances are
    // doing the work rather than an accidental match.
    assert.notEqual(record.facts.durationMs, committed.facts.durationMs);
    assert.notEqual(record.level.assetIntegratedLufs, committed.level.assetIntegratedLufs);
  });
});

test("a take that speaks another Locale fails", (t) => {
  if (!requireEncoder(t)) return;
  withTemp((dir) => {
    const german = auditionClipFor("juergen");
    const take = readAuditionTake(fileURLToPath(TAKE));
    // The defect the old hand captures recorded: a German voice's clip that
    // greets in English. The bytes are a real render; the identity says "en".
    const record = regenerated(
      {
        ...take,
        evidence: { ...take.evidence, voice: "juergen", locale: "en", line: VONI_GREETINGS.en },
      },
      german,
      dir,
      { suffix: "wrong-locale" },
    );
    const problems = regenerationProblems(
      german,
      committedClipFor(manifest(), "juergen", { assetExists }),
      record,
    );
    assert.ok(
      problems.some((problem) => /speaks English, not its own Locale de/.test(problem)),
      `a clip in the wrong Locale is named: ${problems.join(" | ")}`,
    );
  });
});

test("a take at the wrong level fails", (t) => {
  if (!requireEncoder(t)) return;
  withTemp((dir) => {
    const clip = auditionClipFor("anna");
    const take = readAuditionTake(fileURLToPath(TAKE));
    // +2 dB baked into the take, the kind of shift the deleted client table
    // applied (up to 12 dB). Small enough not to clip, so this is the level
    // leg rather than the peak or crest legs.
    const boosted = regenerated(take, clip, dir, { suffix: "boosted", gain: 1.26 });
    const problems = regenerationProblems(clip, committedAnna(), boosted);
    assert.ok(
      problems.some((problem) => /LU from the committed/.test(problem)),
      `+2 dB is not native level: ${problems.join(" | ")}`,
    );
    assert.ok(
      Math.abs(boosted.level.assetIntegratedLufs - committedAnna().level.assetIntegratedLufs) >
        AUDITION_REGENERATION_LEVEL_TOLERANCE_LU,
      "the measured level really is outside the regeneration tolerance",
    );
  });
});

test("a stale greeting fails", (t) => {
  if (!requireEncoder(t)) return;
  withTemp((dir) => {
    const clip = auditionClipFor("anna");
    const take = readAuditionTake(fileURLToPath(TAKE));
    const stale = regenerated(
      { ...take, evidence: { ...take.evidence, line: "Hello! I am Voni. Ready to chat?" } },
      clip,
      dir,
      { suffix: "stale" },
    );
    const problems = regenerationProblems(clip, committedAnna(), stale);
    assert.ok(
      problems.some((problem) => /greeting/.test(problem)),
      `a greeting the agent no longer speaks is named: ${problems.join(" | ")}`,
    );
  });
});

test("a bitrate too low to survive a delivery encode fails", (t) => {
  if (!requireEncoder(t)) return;
  withTemp((dir) => {
    const { clip, record } = freshTake(dir);
    const lowBitrateBytes = join(dir, "64k.mp3");
    encodeAuditionMp3({
      input: join(dir, "fresh-source.wav"),
      output: lowBitrateBytes,
      bitrateKbps: 64,
    });
    const facts = mp3Facts(new Uint8Array(readFileSync(lowBitrateBytes)));
    const problems = regenerationProblems(clip, committedAnna(), {
      ...record,
      facts: { ...record.facts, ...facts },
    });
    assert.ok(
      facts.bitrateKbps < MIN_SURVIVING_BITRATE_KBPS,
      "the 64 kbps encode really is below the floor",
    );
    assert.ok(
      problems.some((problem) => /second encode/.test(problem)),
      `64 kbps does not survive a second encode: ${problems.join(" | ")}`,
    );
  });
});

test("a flattened crest fails", (t) => {
  if (!requireEncoder(t)) return;
  withTemp((dir) => {
    const clip = auditionClipFor("anna");
    const take = readAuditionTake(fileURLToPath(TAKE));
    // Four times the level, clamped: the squared-off waveform a gain-baked,
    // clipped preview has. The encoder preserves the crest it is given, so the
    // comparison against the committed clip is what must catch it.
    const flattened = regenerated(take, clip, dir, { suffix: "flattened", gain: 4 });
    const committed = committedAnna();
    assert.ok(
      flattened.level.assetCrestDb < committed.level.assetCrestDb - AUDITION_REGENERATION_CREST_TOLERANCE_DB,
      `the clipped take really is ${flattened.level.assetCrestDb} dB of crest against ${committed.level.assetCrestDb}`,
    );
    const problems = regenerationProblems(clip, committed, flattened);
    assert.ok(
      problems.some((problem) => /crest/.test(problem)),
      `a flattened preview is named: ${problems.join(" | ")}`,
    );
  });
});

test("the comparison is deterministic for one take", (t) => {
  if (!requireEncoder(t)) return;
  withTemp((dir) => {
    const clip = auditionClipFor("anna");
    const take = readAuditionTake(fileURLToPath(TAKE));
    const first = regenerated(take, clip, dir, { suffix: "one" });
    const second = regenerated(take, clip, dir, { suffix: "two" });
    assert.deepEqual(first, second, "the same take encodes to the same measured facts on every run");
    assert.deepEqual(
      regenerationProblems(clip, committedAnna(), first),
      regenerationProblems(clip, committedAnna(), second),
    );
  });
});

test("the live path actually renders one clip and compares it within tolerance", (t) => {
  // Opt-in: a real vendor render needs the key. Absent, this is a named skip,
  // never a silent pass. The deterministic committed-take test above stays the
  // gate CI runs; this one proves the render itself still matches.
  if (!process.env.ASSEMBLYAI_API_KEY) {
    t.skip("ASSEMBLYAI_API_KEY is not set: live regeneration was not run");
    return;
  }
  if (!requireEncoder(t)) return;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/render-audition-clips.mts",
      "--verify-regeneration",
      "--voice",
      "anna",
    ],
    {
      cwd: fileURLToPath(ROOT),
      env: process.env,
      encoding: "utf8",
      timeout: 180_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `live regeneration failed:\n${result.stderr || result.stdout}`,
  );
  assert.match(result.stdout, /rendered anna now: \d+ ms/, "the fresh take was really rendered");
  assert.match(result.stdout, /regeneration PASS: anna is within/);
});

test("a committed clip in the wrong Locale fails even if the take is right", () => {
  const clip = auditionClipFor("anna");
  const committed = committedAnna();
  const problems = regenerationProblems(
    clip,
    { ...committed, locale: "de" },
    committed,
  );
  assert.ok(
    problems.some((problem) => /^committed clip: speaks de, not its own Locale en/.test(problem)),
    `a wrong committed Locale is named, not excused by the take: ${problems.join(" | ")}`,
  );
});

test("a missing clip fails rather than skipping", () => {
  const base = manifest();
  const anna = committedClipFor(base, "anna", { assetExists });

  const pending: AuditionManifest = {
    ...base,
    clips: base.clips.filter((record) => record.voice !== "anna"),
    pending: [
      {
        voice: "anna",
        locale: "en",
        reason: "ASSEMBLYAI_API_KEY is not set",
        command: "cd voni && npm run voice:clips -- --voice anna",
      },
    ],
  };
  assert.throws(
    () => committedClipFor(pending, "anna", { assetExists }),
    (error: unknown) =>
      error instanceof AuditionClipMissingError &&
      error.code === "pending" &&
      /no committed clip for anna: pending/.test(error.message) &&
      /voice:clips -- --voice anna/.test(error.message),
    "a pending voice is a named failure with the command that finishes it",
  );

  assert.throws(
    () => committedClipFor({ ...base, clips: [], pending: [] }, "anna", { assetExists }),
    (error: unknown) => error instanceof AuditionClipMissingError && error.code === "unrecorded",
    "a voice with no evidence is named, not silently absent",
  );

  assert.throws(
    () => committedClipFor(base, "anna", { assetExists: (asset) => asset !== anna.asset }),
    (error: unknown) => error instanceof AuditionClipMissingError && error.code === "asset-missing",
    "a record whose committed asset is gone fails",
  );
});

test("the take fixture is the voice, Locale and line it claims", () => {
  const take = readAuditionTake(fileURLToPath(TAKE));
  const clip = auditionClipFor("anna");
  assert.equal(take.evidence.voice, clip.voiceId);
  assert.equal(take.evidence.locale, clip.locale);
  assert.equal(take.evidence.line, clip.text, "the take speaks the line the agent speaks");
  assert.equal(take.audio.facts.sampleRate, 24_000);
  assert.equal(take.audio.facts.channels, 1);
  assert.equal(take.audio.facts.bitsPerSample, 16);
});

test("a missing or tampered take is a named failure, never a skip", () => {
  assert.throws(
    () => readAuditionTake(fileURLToPath(new URL("not-a-take.json", TAKE))),
    (error: unknown) => error instanceof AuditionTakeError && error.code === "missing",
    "a missing take cannot pass the gate",
  );

  withTemp((dir) => {
    const evidence = JSON.parse(readFileSync(TAKE, "utf8")) as {
      line: string;
      audio: Record<string, unknown>;
    };
    const original = fileURLToPath(new URL("anna-en.wav", TAKE));

    const tamperedWav = join(dir, "tampered.wav");
    const bytes = readFileSync(original);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(tamperedWav, bytes);
    const tampered = join(dir, "tampered.json");
    writeFileSync(
      tampered,
      JSON.stringify({ ...evidence, audio: { ...evidence.audio, file: basename(tamperedWav) } }),
    );
    assert.throws(
      () => readAuditionTake(tampered),
      (error: unknown) => error instanceof AuditionTakeError && error.code === "hash-mismatch",
      "a tampered take is refused by its recorded hash",
    );

    const honestWav = join(dir, "anna-en.wav");
    copyFileSync(original, honestWav);
    const wrongLine = join(dir, "wrong-line.json");
    writeFileSync(
      wrongLine,
      JSON.stringify({
        ...evidence,
        line: "Hello! I am Voni. Ready to chat?",
        audio: { ...evidence.audio, file: basename(honestWav) },
      }),
    );
    assert.throws(
      () => readAuditionTake(wrongLine),
      (error: unknown) => error instanceof AuditionTakeError && error.code === "line-mismatch",
      "a take whose recorded line hash does not match its line is refused",
    );
  });
});

test("the 5% duration ratio is real: the other takes of the same line would fail", () => {
  const committed = committedAnna();
  const clip = auditionClipFor("anna");
  for (const durationMs of [5_630, 6_360]) {
    const ratio = Math.abs(durationMs - committed.facts.durationMs) / committed.facts.durationMs;
    assert.ok(
      ratio > AUDITION_REGENERATION_DURATION_RATIO,
      `${durationMs} ms really is outside the ratio (${(ratio * 100).toFixed(1)}%)`,
    );
    const problems = regenerationProblems(clip, committed, {
      ...committed,
      facts: { ...committed.facts, durationMs },
    });
    assert.ok(
      problems.some((problem) => /duration/.test(problem)),
      `${durationMs} ms is a different performance: ${problems.join(" | ")}`,
    );
  }
});

test("the no-call check runs without credentials, so CI never needs a live session", () => {
  // `--check` is the live path's credential-free half: plan vs evidence vs
  // committed bytes. The regeneration test's take is committed, so the unit
  // gate needs neither a token nor a socket.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ASSEMBLYAI_API_KEY;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/render-audition-clips.mts", "--check"],
    { cwd: fileURLToPath(ROOT), env, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `voice:clips --check failed without credentials:\n${result.stderr || result.stdout}`,
  );
  assert.match(result.stdout, /audition clips: \d+ committed, \d+ pending/);
});

test("ffmpeg absent is a named skip locally and a named failure in CI", () => {
  assert.deepEqual(
    regenerationPrerequisite({ name: "ffmpeg", present: true, ci: false, remedy: "install ffmpeg" }),
    { action: "run" },
  );
  assert.deepEqual(
    regenerationPrerequisite({ name: "ffmpeg", present: true, ci: true, remedy: "install ffmpeg" }),
    { action: "run" },
  );
  const local = regenerationPrerequisite({
    name: "ffmpeg",
    present: false,
    ci: false,
    remedy: "install ffmpeg",
  });
  assert.equal(local.action, "skip");
  assert.match("reason" in local ? local.reason : "", /ffmpeg is not on PATH.*install ffmpeg/);
  const ci = regenerationPrerequisite({
    name: "ffmpeg",
    present: false,
    ci: true,
    remedy: "install ffmpeg",
  });
  assert.equal(ci.action, "fail");
  assert.match("reason" in ci ? ci.reason : "", /ffmpeg is not on PATH.*install ffmpeg/);
});

test("the committed evidence still covers every planned voice", () => {
  // The regeneration gate is only meaningful while anna is a committed clip.
  const covered = new Set([
    ...manifest().clips.map((record) => record.voice),
    ...manifest().pending.map((entry) => entry.voice),
  ]);
  for (const clip of auditionClipPlan()) {
    assert.ok(covered.has(clip.voiceId), `${clip.voiceId} has a clip or a visible pending entry`);
  }
  assert.equal(
    manifest().clips.find((record) => record.voice === "anna")?.line,
    VONI_GREETINGS.en,
    "the committed anna clip still speaks the English greeting",
  );
});
