import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { VOICES, getVoice } from "@/lib/agents/voices";
import { VONI_GREETINGS, voniConfig } from "./voni-agent";
import { defaultReferenceText } from "./reference-render";
import { mp3Facts } from "./mp3-facts";
import { silentGreetingSession } from "@/lib/voice/silent-greeting";
import {
  AUDITION_BITRATE_KBPS,
  AUDITION_CREST_TOLERANCE_DB,
  AUDITION_ENCODE_LEVEL_TOLERANCE_LU,
  AUDITION_LEVEL_TOLERANCE_LU,
  AUDITION_MANIFEST_PATH,
  AUDITION_SAMPLE_RATE,
  MIN_SURVIVING_BITRATE_KBPS,
  auditionClipFor,
  auditionClipPlan,
  auditionClipProblems,
  auditionPendingCommand,
  type AuditionClip,
  type AuditionClipRecord,
  type AuditionManifest,
} from "./audition-clips";

/**
 * W1 audition clips (voice-parity ticket 38): one committed recording per
 * offered voice, from the line the agent actually speaks, in that voice's own
 * Locale, at native level and at a bitrate that survives a delivery re-encode.
 *
 * The plan is pure: voice → Locale → greeting → level → bitrate. The evidence
 * file is what the checked-in script wrote about the committed audio, so the
 * test does not need a live call. Ticket 39 regenerates one clip against it.
 */

const manifest = (): AuditionManifest =>
  JSON.parse(
    readFileSync(new URL(`../../../${AUDITION_MANIFEST_PATH}`, import.meta.url), "utf8"),
  ) as AuditionManifest;

const assetBytes = (asset: string) =>
  new Uint8Array(readFileSync(new URL(`../../../${asset}`, import.meta.url)));

const assetExists = (asset: string) => existsSync(new URL(`../../../${asset}`, import.meta.url));

function recordFor(clip: AuditionClip, patch: Partial<AuditionClipRecord> = {}): AuditionClipRecord {
  return {
    voice: clip.voiceId,
    locale: clip.locale,
    line: clip.text,
    lineSha256: clip.textSha256,
    asset: clip.asset,
    url: clip.url,
    volume: 100,
    facts: {
      sampleRate: AUDITION_SAMPLE_RATE,
      channels: 1,
      bitrateKbps: AUDITION_BITRATE_KBPS,
      frames: 100,
      durationMs: 2_000,
    },
    level: {
      sourceIntegratedLufs: -22,
      assetIntegratedLufs: -22.05,
      assetTruePeakDbtp: -3,
      assetCrestDb: 12,
      secondEncodeLufs: -22.1,
      secondEncodeTruePeakDbtp: -3.1,
      secondEncodeCrestDb: 12.1,
      referenceIntegratedLufs: null,
    },
    generatedOn: "2026-10-29",
    ...patch,
  };
}

test("every offered voice is planned in its own Locale, and a voice speaks exactly one", () => {
  const plan = auditionClipPlan();
  assert.equal(plan.length, VOICES.length, "one clip per catalog voice: the picker offers them all");
  const seen = new Set<string>();
  for (const clip of plan) {
    const voice = getVoice(clip.voiceId);
    assert.ok(voice, `${clip.voiceId} is a catalog voice`);
    assert.equal(clip.locale, voice.languageCode, `${clip.voiceId} speaks exactly its own Locale`);
    assert.equal(clip.text, VONI_GREETINGS[clip.locale], `${clip.voiceId} greets in ${clip.locale}`);
    assert.equal(clip.url, `/voices/${clip.voiceId}.mp3`, "the picker's URL is the asset contract");
    assert.equal(clip.asset, `public/voices/${clip.voiceId}.mp3`);
    assert.equal(clip.volume, 100, "the clip is the voice at native level");
    assert.equal(seen.has(clip.voiceId), false, `${clip.voiceId} is planned once`);
    seen.add(clip.voiceId);
  }
  assert.throws(() => auditionClipFor("not-a-voice"), /unknown voice/, "a typo is refused");
});

test("the clip line is the same line the stored agent speaks", () => {
  for (const clip of auditionClipPlan()) {
    assert.equal(
      voniConfig(clip.voiceId).greeting,
      clip.text,
      `${clip.voiceId}'s greeting on the agent body is the clip's line`,
    );
    assert.equal(
      defaultReferenceText(clip.voiceId),
      clip.text,
      `${clip.voiceId}'s reference render uses the same line, not a copy`,
    );
  }
});

test("the source session carries the voice and nothing else: no gain, no volume", () => {
  for (const clip of auditionClipPlan().slice(0, 3)) {
    const session = silentGreetingSession({ voiceId: clip.voiceId, text: clip.text });
    assert.deepEqual(
      session.session.output,
      { voice: clip.voiceId },
      "native level by construction: any volume or gain key here would bake a level in",
    );
  }
});

test("a clip that speaks the wrong Locale or a stale greeting is detectable", () => {
  const german = auditionClipFor("jorg");
  const problems = auditionClipProblems(
    german,
    recordFor(german, { locale: "en", line: VONI_GREETINGS.en }),
  );
  assert.ok(
    problems.some((problem) => /Locale/.test(problem)),
    `speaking en for a de voice is named: ${problems.join(" | ")}`,
  );
  assert.ok(
    problems.some((problem) => /greeting/.test(problem)),
    `a stale greeting line is named: ${problems.join(" | ")}`,
  );
});

test("a gain baked into the committed copy is detectable", () => {
  const spanish = auditionClipFor("lola");
  const native = -23.75; // lola's measured native render
  for (const gain of [-6, 6]) {
    const problems = auditionClipProblems(
      spanish,
      recordFor(spanish, {
        level: {
          sourceIntegratedLufs: native,
          assetIntegratedLufs: native + gain,
          assetTruePeakDbtp: -3,
          assetCrestDb: 12,
          secondEncodeLufs: native + gain,
          secondEncodeTruePeakDbtp: -3,
          secondEncodeCrestDb: 12.1,
          referenceIntegratedLufs: native,
        },
      }),
    );
    assert.ok(
      problems.some((problem) => /gain is baked in/.test(problem)),
      `${gain > 0 ? "+" : ""}${gain} LU is not the native level: ${problems.join(" | ")}`,
    );
  }
});

test("a second encode that flattens the waveform is detectable", () => {
  const clip = auditionClipFor("anna");
  const problems = auditionClipProblems(
    clip,
    recordFor(clip, {
      level: {
        ...recordFor(clip).level,
        assetCrestDb: 12,
        secondEncodeCrestDb: 8,
      },
    }),
  );
  assert.ok(
    problems.some((problem) => /crest/.test(problem)),
    `4 dB of crest is a flattened preview: ${problems.join(" | ")}`,
  );
});

test("a bitrate too low to survive a second encode is detectable", () => {
  const clip = auditionClipFor("anna");
  const problems = auditionClipProblems(
    clip,
    recordFor(clip, {
      facts: {
        sampleRate: AUDITION_SAMPLE_RATE,
        channels: 1,
        bitrateKbps: MIN_SURVIVING_BITRATE_KBPS - 32,
        frames: 100,
        durationMs: 2_000,
      },
    }),
  );
  assert.ok(
    problems.some((problem) => /second encode/.test(problem)),
    `96 kbps is refused: ${problems.join(" | ")}`,
  );
});

test("a correct record has no problems", () => {
  for (const clip of auditionClipPlan()) {
    const problems = auditionClipProblems(clip, recordFor(clip));
    assert.deepEqual(problems, [], `${clip.voiceId}: ${problems.join(" | ")}`);
  }
});

test("the committed evidence covers every voice, clip or visibly pending", () => {
  const committed = manifest();
  assert.equal(committed.schemaVersion, 1);
  assert.match(committed.command, /voice:clips/, "the record names the command that produced it");
  const covered = new Map<string, "clip" | "pending">();
  for (const record of committed.clips) {
    assert.equal(covered.has(record.voice), false, `${record.voice} appears once`);
    covered.set(record.voice, "clip");
  }
  for (const pending of committed.pending) {
    assert.equal(covered.has(pending.voice), false, `${pending.voice} appears once`);
    covered.set(pending.voice, "pending");
    assert.ok(pending.reason.trim().length > 0, `${pending.voice}: a pending entry names why`);
    assert.equal(
      pending.command,
      auditionPendingCommand(pending.voice),
      `${pending.voice}: the exact command another operator must run`,
    );
    assert.equal(
      assetExists(`public/voices/${pending.voice}.mp3`),
      false,
      `${pending.voice}: no fabricated or stale audio sits in place of the missing clip`,
    );
  }
  for (const voice of VOICES) {
    assert.ok(covered.has(voice.id), `${voice.id} is either a clip or visibly pending`);
  }
});

test("every committed clip matches its plan, its bytes and the surviving bitrate", () => {
  const committed = manifest();
  for (const record of committed.clips) {
    const clip = auditionClipFor(record.voice);
    assert.deepEqual(auditionClipProblems(clip, record), [], `${record.voice}: clip does not match`);
    assert.ok(assetExists(record.asset), `${record.voice}: ${record.asset} is committed`);
    const bytes = assetBytes(record.asset);
    // Read the facts from the bytes rather than trusting the manifest.
    const facts = mp3Facts(bytes);
    assert.equal(facts.sampleRate, record.facts.sampleRate, `${record.voice}: rate matches the bytes`);
    assert.equal(facts.channels, record.facts.channels, `${record.voice}: channels match the bytes`);
    assert.equal(facts.bitrateKbps, record.facts.bitrateKbps, `${record.voice}: bitrate matches`);
    assert.ok(
      facts.bitrateKbps >= MIN_SURVIVING_BITRATE_KBPS,
      `${record.voice}: ${facts.bitrateKbps} kbps survives a second encode`,
    );
    assert.ok(
      Math.abs(facts.durationMs - record.facts.durationMs) <= 100,
      `${record.voice}: the bytes are the recorded duration`,
    );
  }
});

test("no hand capture remains: the committed previews are exactly the planned clips", () => {
  const committed = manifest();
  const planned = new Set(committed.clips.map((record) => `public/voices/${record.voice}.mp3`));
  const onDisk = readdirSync(new URL("../../../public/voices/", import.meta.url))
    .filter((name) => name.endsWith(".mp3"))
    .map((name) => `public/voices/${name}`);
  assert.deepEqual(
    [...onDisk].sort(),
    [...planned].sort(),
    "the script is the only producer: an unlisted mp3 would be a hand capture",
  );
});

test("no level was baked in, voices are not gain-matched, and the level survives a re-encode", () => {
  const levels: number[] = [];
  for (const record of manifest().clips) {
    levels.push(record.level.assetIntegratedLufs);
    assert.ok(
      Math.abs(record.level.assetIntegratedLufs - record.level.sourceIntegratedLufs) <=
        AUDITION_LEVEL_TOLERANCE_LU,
      `${record.voice}: the committed clip is the native render ` +
        `(${record.level.assetIntegratedLufs} vs ${record.level.sourceIntegratedLufs} LUFS), ` +
        "not a pre-gained copy",
    );
    assert.ok(
      Math.abs(record.level.secondEncodeLufs - record.level.assetIntegratedLufs) <=
        AUDITION_ENCODE_LEVEL_TOLERANCE_LU,
      `${record.voice}: a 128 kbps delivery re-encode keeps the level`,
    );
    assert.ok(
      Math.abs(record.level.secondEncodeCrestDb - record.level.assetCrestDb) <=
        AUDITION_CREST_TOLERANCE_DB,
      `${record.voice}: the delivery re-encode keeps the waveform's crest`,
    );
    assert.ok(record.level.assetTruePeakDbtp < 0, `${record.voice}: the clip does not clip`);
  }
  if (levels.length > 1) {
    const spread = Math.max(...levels) - Math.min(...levels);
    assert.ok(
      spread > 1,
      `the clips span ${spread.toFixed(2)} LU, so they are each voice's native level rather than ` +
        "one gain-matched level",
    );
  }
});

test("the plan and the committed evidence are the same voices and greetings", () => {
  const committed = manifest();
  const plan = auditionClipPlan();
  const byVoice = new Map(committed.clips.map((record) => [record.voice, record]));
  for (const clip of plan) {
    const record = byVoice.get(clip.voiceId);
    if (!record) {
      assert.ok(
        committed.pending.some((pending) => pending.voice === clip.voiceId),
        `${clip.voiceId} is visibly pending, not silently missing`,
      );
      continue;
    }
    assert.equal(record.line, clip.text, `${clip.voiceId}: the evidence line is the planned greeting`);
    assert.equal(record.locale, clip.locale, `${clip.voiceId}: the evidence Locale is the voice's`);
  }
});
