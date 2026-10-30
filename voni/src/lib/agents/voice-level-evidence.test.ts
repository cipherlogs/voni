import test from "node:test";
import assert from "node:assert/strict";
import { VOICES } from "./voices";
import {
  mergeOneVoice,
  type VoiceLevelEvidenceDocument,
  type VoiceLevelEvidenceRow,
} from "./voice-level-evidence";

/**
 * A `npm run voice:levels -- --voice <id>` run re-measures one voice. It is an
 * amendment to the committed record, not a fresh evidence set: every other
 * voice's row and measured date must survive untouched, or a one-voice run
 * would silently re-date fifteen measurements it never made.
 */

const catalogue = VOICES.map((voice) => voice.id);

function row(voice: string, measuredOn: string, integratedLufs: number): VoiceLevelEvidenceRow {
  return {
    voice,
    locale: voice === "jorg" ? "de" : "en",
    measuredOn,
    integratedLufs,
    truePeakDbtp: -3,
    volume: 100,
  };
}

function documentOf(
  voices: VoiceLevelEvidenceRow[],
  unmeasured: VoiceLevelEvidenceRow[] = [],
): VoiceLevelEvidenceDocument {
  return {
    schemaVersion: 1,
    latestMeasuredOn:
      [...voices, ...unmeasured]
        .map((entry) => entry.measuredOn)
        .filter((date): date is string => typeof date === "string")
        .sort()
        .at(-1) ?? "2026-10-29",
    method: "POST /v1/speech",
    measuredWith: "level-facts",
    reference: { voice: "anna" },
    decision: "volume 100",
    voices,
    unmeasured,
  };
}

test("a one-voice run replaces only the named row and keeps every other date", () => {
  const alba = row("alba", "2026-10-29", -21.78);
  const anna = row("anna", "2026-10-29", -20.11);
  const jorg = row("jorg", "2026-10-30", -24.93);
  const previous = documentOf([alba, anna, jorg]);

  const remeasured = row("jorg", "2026-10-31", -24.5);
  const run = documentOf([remeasured]);

  const merged = mergeOneVoice(previous, "jorg", run, catalogue);

  assert.deepEqual(
    merged.voices.filter((entry) => entry.voice !== "jorg"),
    [alba, anna],
    "the untouched rows are carried over unchanged, not re-dated",
  );
  assert.deepEqual(
    merged.voices.find((entry) => entry.voice === "jorg"),
    remeasured,
    "only the named voice takes the new measurement",
  );
  assert.equal(merged.latestMeasuredOn, "2026-10-31", "the record's latest date follows the new row");
  assert.equal(
    merged.voices.find((entry) => entry.voice === "alba")?.measuredOn,
    "2026-10-29",
    "a voice measured in an earlier run keeps its own date",
  );
  assert.equal(previous.voices.find((entry) => entry.voice === "jorg")?.measuredOn, "2026-10-30");
});

test("a one-voice run keeps catalogue order and prunes only retired ids", () => {
  const previous = documentOf([
    row("anna", "2026-10-29", -20.11),
    row("retired-voice", "2026-10-29", -20),
    row("jorg", "2026-10-30", -24.93),
  ]);

  const merged = mergeOneVoice(
    previous,
    "jorg",
    documentOf([row("jorg", "2026-10-31", -24.5)]),
    catalogue,
  );

  assert.deepEqual(
    merged.voices.map((entry) => entry.voice),
    ["anna", "jorg"],
    "the catalogue order is preserved and the retired voice is not carried forward",
  );
});

test("a one-voice run leaves an unmeasured row for another voice alone", () => {
  const gap = {
    voice: "not-served",
    locale: "de",
    measuredOn: null,
    volume: 100,
    reason: "vendor /v1/speech refused the voice",
  } satisfies VoiceLevelEvidenceRow;
  const previous = documentOf([row("anna", "2026-10-29", -20.11)], [gap]);

  const merged = mergeOneVoice(
    previous,
    "anna",
    documentOf([row("anna", "2026-10-31", -20.05)]),
    [...catalogue, "not-served"],
  );

  assert.deepEqual(
    merged.unmeasured,
    [gap],
    "another voice's named gap is not removed by a one-voice run",
  );
  assert.equal(merged.latestMeasuredOn, "2026-10-31");
});
