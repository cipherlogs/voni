/**
 * The vendor floor is the recording every subject must clear: the vendor's own
 * rendering of one line in one voice, captured outside any conversation and
 * committed with its provenance. These tests hold the two properties that make
 * it evidence rather than a convenience:
 *
 * - The committed floor is a real, untouched capture that the comparison can
 *   analyse, and it records voice, line, date and how it was produced.
 * - There is no empty floor. A missing capture, a tampered file, a sidecar
 *   that disagrees with its audio and a file the metric library cannot read are
 *   each refused by name, with the command that produces a real one.
 *
 * The negative cases build their own WAV and sidecar, so re-capturing the
 * committed floor cannot make them pass or fail for the wrong reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VONI_GREETINGS } from "../demo/voni-agent";
import { decodeAudioFile } from "./format-facts";
import {
  VENDOR_FLOOR_COMMAND,
  VENDOR_FLOOR_DIR,
  VENDOR_FLOOR_VOICE,
  VendorFloorError,
  loadVendorFloor,
  vendorFloorFileName,
  type VendorFloorProvenance,
} from "./vendor-floor";

const SAMPLE_RATE = 24_000;

/** A valid 16-bit PCM WAV, built independently of the decoder under test. */
function wavFrom(samples: number[], sampleRate = SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => {
    out.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  });
  return out;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function provenanceFor(bytes: Buffer, file: string): VendorFloorProvenance {
  return {
    schemaVersion: 1,
    voice: "anna",
    locale: "en",
    line: "One line, one voice.",
    capturedOn: "2026-10-29",
    producedBy: "POST https://tts.us.assemblyai.com/v1/speech, buffered WAV, no client in the path",
    method: "vendor-tts-http",
    vendor: { name: "assemblyai", voiceId: "aai-anna", model: "assemblyai-tts-1" },
    audio: {
      file,
      sha256: sha256(bytes),
      container: "wav",
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
    },
  };
}

/** A temporary evidence directory holding one floor, with optional overrides. */
function floorDir(
  options: { audio?: Buffer; provenance?: (provenance: VendorFloorProvenance) => unknown } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "vendor-floor-"));
  const file = vendorFloorFileName("anna", "en");
  const bytes = options.audio ?? wavFrom(new Array(2400).fill(0.1));
  const provenance = provenanceFor(bytes, file);
  writeFileSync(join(dir, file), bytes);
  writeFileSync(
    join(dir, file.replace(/\.wav$/, ".json")),
    JSON.stringify(options.provenance ? options.provenance(provenance) : provenance),
  );
  return dir;
}

function refusal(run: () => unknown): VendorFloorError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof VendorFloorError, `expected a VendorFloorError, got ${String(error)}`);
    return error as VendorFloorError;
  }
  assert.fail("expected the vendor floor to be refused by name");
}

test("a missing vendor floor is a named error, never an empty floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-floor-empty-"));
  const error = refusal(() => loadVendorFloor({ directory: dir }));

  assert.equal(error.code, "vendor-floor-missing");
  assert.match(error.message, /vendor floor missing/);
  assert.match(error.message, /anna-en\.wav/);
  assert.match(error.message, new RegExp(VENDOR_FLOOR_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a floor whose provenance sidecar is absent is refused, not assumed", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-floor-no-sidecar-"));
  const file = vendorFloorFileName("anna", "en");
  writeFileSync(join(dir, file), wavFrom(new Array(2400).fill(0.1)));

  const error = refusal(() => loadVendorFloor({ directory: dir }));
  assert.equal(error.code, "vendor-floor-missing");
  assert.match(error.message, /anna-en\.json/);
});

test("the committed floor decodes as the PCM16 WAV the comparison analyses", () => {
  const floor = loadVendorFloor();
  const direct = decodeAudioFile(floor.path);

  assert.equal(floor.audio.facts.container, "wav");
  assert.equal(floor.audio.facts.sampleRate, 24_000);
  assert.equal(floor.audio.facts.channels, 1);
  assert.equal(floor.audio.facts.bitsPerSample, 16);
  assert.ok(floor.audio.facts.durationSeconds > 1, "a greeting is longer than one second");
  assert.deepEqual(floor.audio.facts, direct.facts);
  assert.ok(floor.audio.samples.length > 0);
  assert.ok(
    floor.audio.samples.some((sample) => Math.abs(sample) > 1_000),
    "the committed floor is real audio, not silence",
  );
});

test("the committed floor records its voice, line, date and how it was produced", () => {
  const { provenance } = loadVendorFloor();

  assert.equal(provenance.voice, VENDOR_FLOOR_VOICE);
  assert.equal(provenance.locale, "en");
  assert.equal(provenance.line, VONI_GREETINGS.en);
  assert.match(provenance.capturedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(provenance.capturedOn)));
  assert.match(provenance.producedBy, /\/v1\/speech/);
  assert.equal(provenance.method, "vendor-tts-http");
  assert.equal(provenance.vendor.name, "assemblyai");
  assert.equal(provenance.vendor.voiceId, "aai-anna");
  assert.ok(provenance.vendor.model.length > 0);
  assert.equal(provenance.audio.file, vendorFloorFileName());
  assert.equal(provenance.audio.sha256, sha256(readFileSync(join(VENDOR_FLOOR_DIR, provenance.audio.file))));
});

test("audio that no longer matches its sidecar is refused by name", () => {
  const dir = floorDir();
  const file = vendorFloorFileName("anna", "en");
  const bytes = readFileSync(join(dir, file));
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(join(dir, file), bytes);

  const error = refusal(() => loadVendorFloor({ directory: dir }));
  assert.equal(error.code, "vendor-floor-audio-mismatch");
  assert.match(error.message, /sha256/);
});

test("a sidecar that omits the line it spoke is refused by name", () => {
  const dir = floorDir({
    provenance: (provenance) => {
      const withoutLine: Record<string, unknown> = { ...provenance };
      delete withoutLine.line;
      return withoutLine;
    },
  });

  const error = refusal(() => loadVendorFloor({ directory: dir }));
  assert.equal(error.code, "vendor-floor-sidecar-invalid");
  assert.match(error.message, /"line"/);
});

test("a sidecar whose date is not a real day is refused by name", () => {
  const dir = floorDir({
    provenance: (provenance) => ({ ...provenance, capturedOn: "2026-10-32" }),
  });

  const error = refusal(() => loadVendorFloor({ directory: dir }));
  assert.equal(error.code, "vendor-floor-sidecar-invalid");
  assert.match(error.message, /capturedOn/);
});

test("a sidecar describing a different format than its audio is refused, not measured", () => {
  const dir = floorDir({
    provenance: (provenance) => ({ ...provenance, audio: { ...provenance.audio, sampleRate: 44_100 } }),
  });

  const error = refusal(() => loadVendorFloor({ directory: dir }));
  assert.equal(error.code, "vendor-floor-audio-mismatch");
  assert.match(error.message, /44100/);
});

test("a file the metric library cannot decode is refused by name", () => {
  const notAudio = Buffer.from("this is not a WAV file\n");
  const dir = floorDir({ audio: notAudio });

  const error = refusal(() => loadVendorFloor({ directory: dir }));
  assert.equal(error.code, "vendor-floor-unreadable");
  assert.match(error.message, /RIFF/);
});

test("an owner-supplied recording keeps its own provenance and still loads", () => {
  const dir = floorDir({
    provenance: (provenance) => ({
      ...provenance,
      producedBy: "dashboard text-to-speech playground, Chrome tab capture, 2026-10-29",
      method: "playground-recording",
    }),
  });

  const floor = loadVendorFloor({ directory: dir });
  assert.equal(floor.provenance.method, "playground-recording");
  assert.match(floor.provenance.producedBy, /playground/);
});

test("a copied committed floor loads from a directory of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-floor-copy-"));
  const file = vendorFloorFileName();
  copyFileSync(join(VENDOR_FLOOR_DIR, file), join(dir, file));
  copyFileSync(
    join(VENDOR_FLOOR_DIR, file.replace(/\.wav$/, ".json")),
    join(dir, file.replace(/\.wav$/, ".json")),
  );

  const floor = loadVendorFloor({ directory: dir });
  assert.equal(floor.provenance.voice, VENDOR_FLOOR_VOICE);
  assert.equal(floor.provenance.line, VONI_GREETINGS.en);
});
