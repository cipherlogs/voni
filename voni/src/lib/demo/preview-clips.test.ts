import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { VOICES, getVoice } from "@/lib/agents/voices";
import { decodePcm } from "@/lib/audio/format-facts";
import { analyseLevel } from "@/lib/audio/level-facts";
import { VONI_GREETINGS, voniConfig } from "./voni-agent";
import { mp3Facts } from "./mp3-facts";
import {
  AUDITION_BITRATE_KBPS,
  AUDITION_CHANNELS,
  AUDITION_SAMPLE_RATE,
  auditionLineSha256,
  type AuditionManifest,
} from "./audition-clips";
import { regenerationPrerequisite } from "./clip-regeneration";
import {
  previewGate,
  type MeasuredPreview,
  type PreviewMeasurement,
} from "./preview-clips";
import { decodeAuditionMp3, hasFfmpeg } from "../../../scripts/lib/mp3-encode";

/**
 * W5 parity proof (voice-parity ticket 79): the picker's previews are covered
 * by the clip test.
 *
 * `public/voices/<voice>.mp3` is the promise "the voice you auditioned is the
 * voice you get". Ticket 38 proved the plan and the evidence agree; this test
 * proves the **offered preview itself** is that voice: its one Locale, its
 * line, its native level, and the recorded format. Every offered voice is
 * covered, not only the featured one.
 *
 * No live call and no credential: the evidence record is what the shipped
 * script measured, the bytes are the committed file. ffmpeg is only needed for
 * the stronger leg that re-measures the decoded audio; absent locally that leg
 * is a **named skip**, absent in CI a **named failure**, and the pure-MP3 legs
 * (frame facts + evidence level) still run.
 */

const ROOT = new URL("../../../", import.meta.url);

const manifest = (): AuditionManifest =>
  JSON.parse(
    readFileSync(new URL("evidence/audition-clips/clips.json", ROOT), "utf8"),
  ) as AuditionManifest;

/** The committed file, or `null` when nothing is committed for that asset. */
function readAsset(asset: string): Uint8Array | null {
  const path = new URL(asset, ROOT);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

/**
 * The pure-MP3 path: frames and the evidence record are enough to gate Locale,
 * format and native level. It is named so a reader can see the decode did not
 * run — never an implicit absence.
 */
const PURE_MP3: PreviewMeasurement = {
  kind: "pure-mp3",
  reason: "this leg reads the frame headers and the evidence record; it does not decode",
};

function recordFor(voiceId: string) {
  const record = manifest().clips.find((candidate) => candidate.voice === voiceId);
  assert.ok(record, `${voiceId} has a committed clip to synthesise a defect from`);
  return record;
}

test("every offered voice's preview is its own Locale, line and native level", () => {
  const gate = previewGate({ manifest: manifest(), readAsset, measurement: PURE_MP3 });

  assert.equal(VOICES.length, 16, "the picker offers sixteen voices, so sixteen previews are covered");
  assert.deepEqual(
    gate.checks.map((check) => check.voiceId).sort(),
    VOICES.map((voice) => voice.id).sort(),
    "one check per offered voice: the featured voice is not the only one gated",
  );
  assert.deepEqual(
    gate.failures.map((failure) => failure.voiceId),
    ["jorg"],
    `the only unpreviewed managed voice is the pending German re-cast: ${gate.failures
      .map((failure) => failure.problems.join(" | "))
      .join(" ;; ")}`,
  );
  const german = gate.failures[0]!;
  assert.ok(
    german.problems.some((problem) => /voice "jorg" \(de\): no committed clip for jorg: pending/.test(problem)),
    `the pending managed clip is named: ${german.problems.join(" | ")}`,
  );
  assert.ok(
    german.problems.some((problem) => /voice:clips -- --voice jorg/.test(problem)),
    "the pending entry names the exact command that finishes it",
  );

  for (const check of gate.checks) {
    const voice = getVoice(check.voiceId);
    assert.ok(voice, `${check.voiceId} is a catalog voice`);
    assert.equal(check.locale, voice.languageCode, `${check.voiceId} speaks exactly its own Locale`);
    assert.equal(check.asset, `public/voices/${check.voiceId}.mp3`, `${check.voiceId}: its own asset`);
    assert.equal(check.measurement, "pure-mp3", `${check.voiceId}: the decode leg is named when absent`);
    assert.equal(check.note, PURE_MP3.reason, `${check.voiceId}: the pure-MP3 path says why it did not decode`);
    assert.equal(
      voniConfig(check.voiceId).greeting,
      VONI_GREETINGS[check.locale],
      `${check.voiceId}: the preview line is the greeting the agent speaks`,
    );
  }
});

test("every committed managed preview's bytes are its recorded format and surviving bitrate", () => {
  for (const record of manifest().clips) {
    const voice = getVoice(record.voice);
    assert.ok(voice, `${record.voice} is a catalog voice`);
    const bytes = readAsset(record.asset);
    assert.ok(bytes, `${voice.id}: ${record.asset} is committed`);

    const facts = mp3Facts(bytes);
    assert.equal(facts.sampleRate, record.facts.sampleRate, `${voice.id}: rate matches the evidence`);
    assert.equal(facts.sampleRate, AUDITION_SAMPLE_RATE, `${voice.id}: the session's own rate`);
    assert.equal(facts.channels, record.facts.channels, `${voice.id}: channels match the evidence`);
    assert.equal(facts.channels, AUDITION_CHANNELS, `${voice.id}: mono`);
    assert.equal(facts.bitrateKbps, record.facts.bitrateKbps, `${voice.id}: bitrate matches the evidence`);
    assert.equal(facts.bitrateKbps, AUDITION_BITRATE_KBPS, `${voice.id}: the committed bitrate`);
    assert.ok(facts.constantBitrate, `${voice.id}: the preview is constant bitrate`);
  }
});

test("a wrong-Locale preview and a wrong-level preview fail by name", () => {
  const base = manifest();
  const patched: AuditionManifest = {
    ...base,
    clips: base.clips.map((record) => {
      if (record.voice === "estelle") {
        // The old hand-capture defect: a French voice greeting in English.
        return {
          ...record,
          locale: "en",
          line: VONI_GREETINGS.en,
          lineSha256: auditionLineSha256(VONI_GREETINGS.en),
        };
      }
      if (record.voice === "lola") {
        // The deleted client gain table, baked into the committed copy.
        return {
          ...record,
          level: {
            ...record.level,
            assetIntegratedLufs: record.level.assetIntegratedLufs + 6,
            secondEncodeLufs: record.level.secondEncodeLufs + 6,
          },
        };
      }
      return record;
    }),
  };

  const gate = previewGate({ manifest: patched, readAsset, measurement: PURE_MP3 });
  assert.deepEqual(
    gate.failures.map((failure) => failure.voiceId).sort(),
    ["estelle", "jorg", "lola"],
    `the two defective previews and the pending German clip fail: ${gate.failures
      .map((failure) => failure.problems.join(" | "))
      .join(" ;; ")}`,
  );

  const french = gate.failures.find((failure) => failure.voiceId === "estelle");
  assert.ok(french, "estelle is named as a failure");
  assert.ok(
    french.problems.some((problem) =>
      /voice "estelle" \(fr\): speaks English, not its own Locale fr/.test(problem),
    ),
    `the wrong Locale fails by name: ${french.problems.join(" | ")}`,
  );

  const spanish = gate.failures.find((failure) => failure.voiceId === "lola");
  assert.ok(spanish, "lola is named as a failure");
  assert.ok(
    spanish.problems.some((problem) =>
      /voice "lola" \(es\): level .* a gain is baked in/.test(problem),
    ),
    `the wrong level fails by name: ${spanish.problems.join(" | ")}`,
  );
});

test("a preview whose bytes measure to another level fails by name", () => {
  // A swapped file: the evidence record is honest, the committed bytes are not
  // the audio it measured. Only decoding can catch this, so this leg is driven
  // with a synthetic measurement rather than 16 real decodes.
  const gate = previewGate({
    manifest: manifest(),
    readAsset,
    measurement: {
      kind: "decoded",
      measure: (asset): MeasuredPreview => {
        const record = recordFor(asset.replace("public/voices/", "").replace(".mp3", ""));
        return {
          integratedLufs:
            record.level.assetIntegratedLufs + (asset.endsWith("/lola.mp3") ? 6 : 0),
          truePeakDbtp: record.level.assetTruePeakDbtp,
        };
      },
    },
  });

  assert.deepEqual(
    gate.failures.map((failure) => failure.voiceId).sort(),
    ["jorg", "lola"],
    "only the swapped preview (and the pending German clip) fails; an honest measurement is not flagged",
  );
  const spanish = gate.failures.find((failure) => failure.voiceId === "lola")!;
  assert.ok(
    spanish.problems.some((problem) =>
      /voice "lola" \(es\): the committed bytes decode to .* LUFS, .*the evidence records/.test(
        problem,
      ),
    ),
    `a swapped preview fails by name: ${spanish.problems.join(" | ")}`,
  );
});

/** The decoded leg: write the bytes, decode them, and measure what a listener gets. */
function decodedMeasurement(dir: string): PreviewMeasurement {
  return {
    kind: "decoded",
    measure: (asset, bytes): MeasuredPreview => {
      const file = join(dir, basename(asset));
      writeFileSync(file, bytes);
      const audio = decodePcm(decodeAuditionMp3(file), {
        sampleRate: AUDITION_SAMPLE_RATE,
        channels: AUDITION_CHANNELS,
      });
      const level = analyseLevel(audio);
      if (!level.measured) throw new Error(`${asset} has no measurable level (${level.absence})`);
      return { integratedLufs: level.integratedLufs, truePeakDbtp: level.truePeakDbtp };
    },
  };
}

test("every committed preview decodes to the level its evidence records", (t) => {
  if (!requireDecoder(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "preview-clips-"));
  try {
    const gate = previewGate({ manifest: manifest(), readAsset, measurement: decodedMeasurement(dir) });
    assert.deepEqual(
      gate.failures.map((failure) => failure.voiceId),
      ["jorg"],
      "only the pending managed German clip is unproven; every committed preview decodes as measured",
    );
    assert.ok(
      gate.checks
        .filter((check) => check.voiceId !== "jorg")
        .every((check) => check.measurement === "decoded"),
      "the decoded leg ran for every committed managed preview",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a preview swapped for another voice's audio fails by name", (t) => {
  if (!requireDecoder(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "preview-clips-"));
  // The real committed file of a different voice, served under anna's URL: the
  // evidence record is untouched and anna's format, bitrate and line still
  // match, so only measuring the bytes can catch the swap.
  const donor = "charles";
  const readSwapped = (asset: string): Uint8Array | null => {
    const voiceId = asset.replace("public/voices/", "").replace(".mp3", "");
    return readAsset(voiceId === "anna" ? `public/voices/${donor}.mp3` : asset);
  };
  try {
    const gate = previewGate({ manifest: manifest(), readAsset: readSwapped, measurement: decodedMeasurement(dir) });
    assert.deepEqual(
      gate.failures.map((failure) => failure.voiceId).sort(),
      ["anna", "jorg"],
      `only the swapped preview (and the pending German clip) fails: ${gate.failures
        .map((failure) => failure.problems.join(" | "))
        .join(" ;; ")}`,
    );
    const swapped = gate.failures.find((failure) => failure.voiceId === "anna")!;
    assert.ok(
      swapped.problems.some((problem) =>
        /voice "anna" \(en\): the committed bytes decode to .*the evidence records/.test(problem),
      ),
      `the swapped preview is named: ${swapped.problems.join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or pending preview fails by name, never silently passing", () => {
  const base = manifest();
  const patched: AuditionManifest = {
    ...base,
    clips: base.clips.filter((record) => record.voice !== "rafael"),
    pending: [
      {
        voice: "rafael",
        locale: "pt",
        reason: "ASSEMBLYAI_API_KEY is not set",
        command: "cd voni && npm run voice:clips -- --voice rafael",
      },
    ],
  };

  const gate = previewGate({ manifest: patched, readAsset, measurement: PURE_MP3 });
  assert.equal(gate.checks.length, VOICES.length, "the missing voice is still a check, not a silent omission");
  const portuguese = gate.failures.find((failure) => failure.voiceId === "rafael");
  assert.ok(portuguese, "rafael is named");
  assert.ok(
    portuguese.problems.some(
      (problem) =>
        /voice "rafael" \(pt\): no committed clip for rafael: pending/.test(problem) &&
        /voice:clips -- --voice rafael/.test(problem),
    ),
    `a pending preview is a named failure with the command that finishes it: ${portuguese.problems.join(" | ")}`,
  );
});

test("an evidence record for a voice the picker does not offer is named", () => {
  const base = manifest();
  const anna = recordFor("anna");
  const patched: AuditionManifest = {
    ...base,
    clips: [...base.clips, { ...anna, voice: "ghost" }],
  };

  const gate = previewGate({ manifest: patched, readAsset, measurement: PURE_MP3 });
  const ghost = gate.failures.find((failure) => failure.voiceId === "ghost");
  assert.ok(ghost, "a preview nobody can reach is named");
  assert.ok(
    ghost.problems.some((problem) =>
      /voice "ghost" \(en\): the evidence records a preview for a voice the picker does not offer/.test(
        problem,
      ),
    ),
    `the orphan record is named: ${ghost.problems.join(" | ")}`,
  );
});

/** The decode prerequisite policy: named skip locally, named failure in CI. */
function requireDecoder(t: TestContext): boolean {
  const decision = regenerationPrerequisite({
    name: "ffmpeg",
    present: hasFfmpeg(),
    ci: Boolean(process.env.CI),
    remedy: "install ffmpeg (the preview decoder)",
  });
  if (decision.action === "fail") assert.fail(decision.reason);
  if (decision.action === "skip") {
    t.skip(decision.reason);
    return false;
  }
  return true;
}
