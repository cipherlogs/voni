import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VOICES, getVoice } from "./voices";
import {
  MEASURED_VOICE_LEVELS,
  UNMEASURED_VOICE_LEVELS,
  UNMEASURED_VOICE_OUTPUT_VOLUME,
  voiceLevelMeasurement,
  voiceOutputVolume,
  voiceOutputVolumeForMeasurement,
  type VoiceLevelMeasurement,
} from "./voice-levels";

/**
 * Level contract (voice-parity ticket 37): a voice's level is `output.volume`
 * on its stored agent body, decided per voice from a measured reference file.
 * The measurement and the decision are committed together in
 * `evidence/voice-levels/levels.json`, so the number on the body can be
 * audited without re-running anything.
 */

const evidence = () =>
  JSON.parse(
    readFileSync(new URL("../../../evidence/voice-levels/levels.json", import.meta.url), "utf8"),
  ) as {
    latestMeasuredOn: string;
    reference: { voice: string; integratedLufs: number };
    voices: Array<{
      voice: string;
      locale: string;
      integratedLufs: number;
      truePeakDbtp: number;
      volume: number;
      measuredOn: string;
    }>;
    unmeasured: Array<{ voice: string; locale: string; volume: number }>;
  };

test("every catalog voice has a numeric output level for its stored body", () => {
  for (const voice of VOICES) {
    const volume = voiceOutputVolume(voice.id);
    assert.equal(typeof volume, "number", `${voice.id} carries a numeric output.volume`);
    assert.ok(Number.isInteger(volume), `${voice.id}: the platform's volume is an integer`);
    assert.ok(volume >= 0 && volume <= 100, `${voice.id}: ${volume} is inside the platform's 0-100 range`);
  }
  assert.equal(
    voiceOutputVolume("not-a-voice"),
    UNMEASURED_VOICE_OUTPUT_VOLUME,
    "an unknown voice never invents a level",
  );
});

test("a measured voice's level is the decision recorded against its measured reference", () => {
  const measured = evidence();
  assert.ok(measured.voices.length > 0, "at least one voice has a measured reference");
  for (const row of MEASURED_VOICE_LEVELS) {
    const voice = getVoice(row.voice);
    assert.ok(voice, `${row.voice} is a catalog voice`);
    assert.equal(row.locale, voice.languageCode, "a voice speaks exactly one Locale");
    assert.equal(row.measured, true, "a registry row in MEASURED_VOICE_LEVELS is measured");
    assert.ok(Number.isFinite(row.integratedLufs), "the reference's integrated loudness was measured");
    assert.ok(Number.isFinite(row.truePeakDbtp), "the reference's true peak was measured");
    assert.ok(
      row.truePeakDbtp !== null && row.truePeakDbtp < 0,
      "the reference does not clip",
    );
    assert.equal(
      row.volume,
      100,
      "the measured reference is the level target: volume 100 applies no processing",
    );
  }
});

test("the registry and the committed evidence are the same measurement", () => {
  const committed = evidence();
  assert.equal(committed.reference.voice, "anna", "the committed vendor floor is the reference");
  const shape = (row: {
    voice: string;
    locale: string;
    integratedLufs: number | null;
    truePeakDbtp: number | null;
    volume: number;
    measuredOn: string | null;
  }) => ({
    voice: row.voice,
    locale: row.locale,
    integratedLufs: row.integratedLufs,
    truePeakDbtp: row.truePeakDbtp,
    volume: row.volume,
    measuredOn: row.measuredOn,
  });
  assert.deepEqual(
    MEASURED_VOICE_LEVELS.map(shape).sort((a, b) => a.voice.localeCompare(b.voice)),
    committed.voices.map(shape).sort((a, b) => a.voice.localeCompare(b.voice)),
    "the numbers on the body are the numbers in the evidence file: no silent retune",
  );
  for (const row of committed.voices) {
    assert.ok(
      row.truePeakDbtp < 0,
      `${row.voice} does not clip at native level, so no level boost is possible or needed`,
    );
  }
  // Each voice is judged against its own reference, not against `anna`: the
  // measured spread is native variation (~6 dB), so a "within 0.20 LU of the
  // anna floor" claim would be false. The floor is one voice's baseline.
  const levels = committed.voices.map((row) => row.integratedLufs);
  assert.ok(
    Math.max(...levels) - Math.min(...levels) > 1.5,
    "the voices measure across a real spread, not inside one 0.20 LU tolerance",
  );
});

test("each voice's measured date is its own, not the record's latest run", () => {
  const committed = evidence();
  assert.equal(
    committed.latestMeasuredOn,
    "2026-10-30",
    "the record names the latest measurement, and German's jorg is it",
  );
  const dates = committed.voices.map((row) => row.measuredOn);
  assert.ok(dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)), "every row dates its own take");
  assert.equal(
    committed.latestMeasuredOn,
    [...dates].sort().at(-1),
    "the record's latest date is one of the rows, not a document-wide claim",
  );
  assert.deepEqual(
    committed.voices.filter((row) => row.measuredOn === committed.latestMeasuredOn).map((row) => row.voice),
    ["jorg"],
    "only the voice actually measured on 2026-10-30 carries that date",
  );
  for (const row of committed.voices) {
    const registered = voiceLevelMeasurement(row.voice);
    assert.ok(registered, `${row.voice} has a registry row`);
    assert.equal(
      registered.measuredOn,
      row.measuredOn,
      `${row.voice}: the registry and the evidence agree on the measured date`,
    );
    if (row.voice !== "jorg") {
      assert.equal(row.measuredOn, "2026-10-29", `${row.voice} keeps its original measured date`);
    }
  }
});

test("an unmeasured voice would be a visible registry row, never a silent 100", () => {
  const committed = evidence();
  const measuredIds = new Set(committed.voices.map((row) => row.voice));
  for (const row of committed.unmeasured) {
    assert.equal(measuredIds.has(row.voice), false, `${row.voice} is not also reported as measured`);
    const registered = voiceLevelMeasurement(row.voice);
    assert.ok(registered, `${row.voice} has a named registry row, not an absent one`);
    assert.equal(registered.measured, false, `${row.voice} is visibly unmeasured`);
    assert.equal(registered.integratedLufs, null);
    assert.equal(registered.truePeakDbtp, null);
    assert.equal(
      voiceOutputVolume(row.voice),
      row.volume,
      `${row.voice} carries the evidence's named default`,
    );
  }
  assert.equal(
    UNMEASURED_VOICE_LEVELS.length,
    committed.unmeasured.length,
    "the registry's named gaps are the evidence's named gaps",
  );
  assert.deepEqual(
    UNMEASURED_VOICE_LEVELS,
    [],
    "every offered voice, German's jorg included, has a measured reference",
  );
  assert.equal(
    UNMEASURED_VOICE_OUTPUT_VOLUME,
    100,
    "the named default is the native reference, not a guess at a quieter level",
  );
  const jorg = voiceLevelMeasurement("jorg");
  assert.ok(jorg, "the chosen German voice has a registry row");
  assert.equal(jorg.measured, true);
  assert.equal(jorg.locale, "de");
  assert.equal(
    voiceLevelMeasurement("juergen"),
    null,
    "the retired German id has no level row; its unbound row lives in the binding table",
  );
  assert.equal(voiceLevelMeasurement("not-a-voice"), null, "an unknown voice has no row");
});

test("an unmeasured row takes the named default, never an invented level", () => {
  // Synthetic, not a catalog voice: the registry has no unmeasured row today,
  // so the branch is proven with a row the test owns rather than a fake voice.
  const gap: VoiceLevelMeasurement = {
    voice: "synthetic-unmeasured",
    locale: "en",
    measuredOn: null,
    integratedLufs: null,
    truePeakDbtp: null,
    volume: 40,
    measured: false,
    unmeasuredReason: "synthetic row: the vendor served no reference",
  };
  assert.equal(
    voiceOutputVolumeForMeasurement(gap),
    UNMEASURED_VOICE_OUTPUT_VOLUME,
    "an unmeasured row's number is not trusted: the named native default is the level",
  );
  assert.equal(
    voiceOutputVolumeForMeasurement({ ...gap, volume: UNMEASURED_VOICE_OUTPUT_VOLUME }),
    UNMEASURED_VOICE_OUTPUT_VOLUME,
    "the unmeasured row carries the visible default, not a measurement",
  );
  assert.equal(
    voiceOutputVolumeForMeasurement(null),
    UNMEASURED_VOICE_OUTPUT_VOLUME,
    "an absent row keeps the same named default",
  );
  assert.equal(
    voiceOutputVolumeForMeasurement({ ...gap, measured: true, volume: 82 }),
    82,
    "a measured row's own decision is honored, so the branch is a real distinction",
  );
  assert.equal(gap.measured, false, "the synthetic row is never added to the registry");
  assert.equal(voiceLevelMeasurement(gap.voice), null);
});

test("the level is no longer a second registry constant beside the body", () => {
  const source = readFileSync(new URL("./voices.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /export const VOICE_OUTPUT_VOLUME/,
    "the level lives on the stored body, not as a second source of truth",
  );
});
