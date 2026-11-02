/**
 * The committed soundscape beds: one hashed WAV and one sidecar per id.
 *
 * A bed is evidence, not a default. The loader accepts the committed pair and
 * refuses a missing file, a changed hash, a misdescribed format and a drifted
 * duration by name, always naming the path and the command that produces a
 * real bed. It never returns an empty map and never resamples at load time.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SOUNDSCAPE_COMMANDS,
  SOUNDSCAPE_DIR,
  SOUNDSCAPE_SAMPLE_RATE,
  SoundscapeError,
  loadSoundscape,
  loadSoundscapes,
} from "./soundscapes";

const TELEVISION_SHA256 =
  "36ddea2738b19f4a0e2561bf8c3df8e901b10cbe53aef232d242a091f6047657";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dv-soundscapes-"));
}

type Sidecar = Record<string, unknown>;

function committedSidecar(): Sidecar {
  return JSON.parse(
    readFileSync(join(SOUNDSCAPE_DIR, "television.json"), "utf8"),
  ) as Sidecar;
}

/** A temp copy of the committed pair, so a test can drift exactly one field. */
function copyPair(root: string): { wav: string; sidecar: string } {
  const wav = join(root, "television.wav");
  const sidecar = join(root, "television.json");
  copyFileSync(join(SOUNDSCAPE_DIR, "television.wav"), wav);
  writeFileSync(sidecar, `${JSON.stringify(committedSidecar(), null, 2)}\n`);
  return { wav, sidecar };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("the committed pair loads as 30 s of 24 kHz mono PCM16 under its id", () => {
  const beds = loadSoundscapes();
  assert.deepEqual(Object.keys(beds), ["television"]);
  const pcm = beds.television;
  assert.ok(pcm !== undefined);
  assert.equal(pcm.byteLength, 30 * 24_000 * 2);
  assert.equal(pcm.byteLength % 2, 0, "PCM16 is whole samples");

  const bed = loadSoundscape("television");
  assert.equal(bed.path, join(SOUNDSCAPE_DIR, "television.wav"));
  assert.equal(bed.provenance.id, "television");
  assert.equal(bed.provenance.sha256, TELEVISION_SHA256);
  assert.equal(bed.provenance.sampleRate, SOUNDSCAPE_SAMPLE_RATE);
  assert.equal(bed.provenance.channels, 1);
  assert.equal(bed.provenance.bitsPerSample, 16);
  assert.equal(bed.provenance.durationMs, 30_000);
  assert.ok(bed.provenance.rights.length > 0);
  assert.ok(bed.provenance.notUsedFor.length > 0);
});

test("a changed sha256 is refused by name with the path and the producing command", () => {
  const root = tempRoot();
  try {
    copyPair(root);
    const sidecar = committedSidecar();
    sidecar.sha256 = "0".repeat(64);
    writeFileSync(join(root, "television.json"), JSON.stringify(sidecar));

    assert.throws(
      () => loadSoundscape("television", { directory: root }),
      (error: unknown) => {
        assert.ok(error instanceof SoundscapeError);
        assert.equal(error.code, "soundscape-audio-mismatch");
        assert.match(error.message, /television\.wav/);
        assert.match(error.message, /yt-dlp/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing WAV is refused by name, never an empty soundscape map", () => {
  const root = tempRoot();
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "television.json"), JSON.stringify(committedSidecar()));

    assert.throws(
      () => loadSoundscapes({ directory: root }),
      (error: unknown) => {
        assert.ok(error instanceof SoundscapeError);
        assert.equal(error.code, "soundscape-missing");
        assert.match(error.message, /television\.wav/);
        assert.match(error.message, /yt-dlp/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sidecar that misdescribes the format is refused, not resampled", () => {
  const root = tempRoot();
  try {
    copyPair(root);
    const sidecar = committedSidecar();
    sidecar.sampleRate = 48_000;
    writeFileSync(join(root, "television.json"), JSON.stringify(sidecar));

    assert.throws(
      () => loadSoundscape("television", { directory: root }),
      (error: unknown) => {
        assert.ok(error instanceof SoundscapeError);
        assert.equal(error.code, "soundscape-sidecar-invalid");
        assert.match(error.message, /24000/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a WAV whose real format drifted is refused by name", () => {
  const root = tempRoot();
  try {
    const { wav, sidecar } = copyPair(root);
    const bytes = readFileSync(wav);
    bytes.writeUInt32LE(48_000, 24);
    bytes.writeUInt32LE(48_000 * 2, 28);
    writeFileSync(wav, bytes);
    const record = committedSidecar();
    record.sha256 = sha256(bytes);
    writeFileSync(sidecar, JSON.stringify(record));

    assert.throws(
      () => loadSoundscape("television", { directory: root }),
      (error: unknown) => {
        assert.ok(error instanceof SoundscapeError);
        assert.equal(error.code, "soundscape-audio-mismatch");
        assert.match(error.message, /48000 Hz/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sidecar duration that disagrees with the audio is refused by name", () => {
  const root = tempRoot();
  try {
    const { sidecar } = copyPair(root);
    const record = committedSidecar();
    record.durationMs = 29_000;
    writeFileSync(sidecar, JSON.stringify(record));

    assert.throws(
      () => loadSoundscape("television", { directory: root }),
      (error: unknown) => {
        assert.ok(error instanceof SoundscapeError);
        assert.equal(error.code, "soundscape-audio-mismatch");
        assert.match(error.message, /30000 ms/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed sidecar is refused by name with the producing command", () => {
  const root = tempRoot();
  try {
    copyPair(root);
    writeFileSync(join(root, "television.json"), "{not json");

    assert.throws(
      () => loadSoundscape("television", { directory: root }),
      (error: unknown) => {
        assert.ok(error instanceof SoundscapeError);
        assert.equal(error.code, "soundscape-sidecar-invalid");
        assert.match(error.message, /television\.json/);
        assert.match(error.message, /yt-dlp/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every registered bed names the command that produces it", () => {
  assert.equal(typeof SOUNDSCAPE_COMMANDS.television, "string");
  assert.match(SOUNDSCAPE_COMMANDS.television, /television\.wav/);
});
