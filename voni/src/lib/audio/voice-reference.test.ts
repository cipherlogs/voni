import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VOICE_REFERENCE_DIR,
  VOICE_REFERENCE_LOCALE,
  VOICE_REFERENCE_VOICE,
  VoiceReferenceError,
  loadVoiceReference,
  parseVoiceReferenceSidecar,
} from "./voice-reference";

/** The committed pair, and a copied pair whose sidecar each test can break. */
function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dv21-reference-"));
  copyFileSync(
    join(VOICE_REFERENCE_DIR, `${VOICE_REFERENCE_VOICE}-${VOICE_REFERENCE_LOCALE}.wav`),
    join(dir, `${VOICE_REFERENCE_VOICE}-${VOICE_REFERENCE_LOCALE}.wav`),
  );
  copyFileSync(
    join(VOICE_REFERENCE_DIR, `${VOICE_REFERENCE_VOICE}-${VOICE_REFERENCE_LOCALE}.json`),
    join(dir, `${VOICE_REFERENCE_VOICE}-${VOICE_REFERENCE_LOCALE}.json`),
  );
  return dir;
}

function sidecar(dir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dir, `${VOICE_REFERENCE_VOICE}-${VOICE_REFERENCE_LOCALE}.json`), "utf8"),
  ) as Record<string, unknown>;
}

test("the committed audrey reference loads with its provenance and PCM facts", () => {
  const reference = loadVoiceReference();

  assert.equal(reference.provenance.voice, "audrey");
  assert.equal(reference.provenance.locale, "en");
  assert.match(reference.provenance.line, /^Hi, I'm Voni!/);
  assert.equal(reference.audio.facts.sampleRate, 24_000);
  assert.equal(reference.audio.facts.channels, 1);
  assert.equal(reference.audio.facts.bitsPerSample, 16);
  assert.ok(reference.audio.facts.durationSeconds > 6);
  assert.equal(reference.provenance.audio.sha256.length, 64);
});

test("a missing reference pair is a named refusal, never another voice", () => {
  const dir = mkdtempSync(join(tmpdir(), "dv21-reference-empty-"));
  assert.throws(
    () => loadVoiceReference("audrey", "en", dir),
    (error: unknown) =>
      error instanceof VoiceReferenceError &&
      error.code === "reference-missing" &&
      /A5 fails closed/.test(error.message),
  );
});

test("a hash that no longer matches the WAV is refused", () => {
  const dir = fixtureDir();
  const record = sidecar(dir);
  (record.audio as Record<string, unknown>).sha256 = "0".repeat(64);
  writeFileSync(join(dir, "audrey-en.json"), JSON.stringify(record));

  assert.throws(
    () => loadVoiceReference("audrey", "en", dir),
    (error: unknown) =>
      error instanceof VoiceReferenceError && error.code === "reference-audio-mismatch",
  );
});

test("a sidecar that misdescribes the WAV is refused", () => {
  const dir = fixtureDir();
  const record = sidecar(dir);
  (record.format as Record<string, unknown>).sampleRate = 48_000;
  writeFileSync(join(dir, "audrey-en.json"), JSON.stringify(record));

  assert.throws(
    () => loadVoiceReference("audrey", "en", dir),
    (error: unknown) =>
      error instanceof VoiceReferenceError && error.code === "reference-audio-mismatch",
  );
});

test("a sidecar from another render method is refused by name", () => {
  const record = sidecar(VOICE_REFERENCE_DIR);
  assert.throws(
    () => parseVoiceReferenceSidecar({ ...record, method: "silent-greeting-session" }, "fixture"),
    (error: unknown) =>
      error instanceof VoiceReferenceError &&
      error.code === "reference-sidecar-invalid" &&
      /"method"/.test(error.message),
  );
});

test("a sidecar that names another voice is refused by name", () => {
  assert.throws(
    () =>
      parseVoiceReferenceSidecar(
        {
          ...sidecar(VOICE_REFERENCE_DIR),
          voice: "",
        },
        "fixture",
      ),
    (error: unknown) =>
      error instanceof VoiceReferenceError &&
      error.code === "reference-sidecar-invalid" &&
      /"voice"/.test(error.message),
  );
});
