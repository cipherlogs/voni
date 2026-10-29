/**
 * Ticket 126: a capture is evidence by reference, never by value.
 *
 * The artifact carries a path and a sha256 for every leg; the WAV itself is a
 * gitignored working file. These tests pin the three consequences:
 *
 * - recording a capture reads the bytes only to hash them, and the record
 *   carries no audio;
 * - a missing, empty or unreadable capture is refused by name, so a claim
 *   cannot rest on a file that is not there;
 * - a recorded hash that no longer matches its file is dirty evidence, named
 *   rather than trusted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaptureEvidenceError,
  captureEvidence,
  verifyCaptureRecord,
} from "./capture-evidence";

/** A WAV whose bytes are irrelevant to the code under test; only the hash is. */
function wavBytes(marker = 1): Buffer {
  const samples = 64;
  const output = Buffer.alloc(44 + samples * 2);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + samples * 2, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(24_000, 24);
  output.writeUInt32LE(48_000, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    output.writeInt16LE((index + marker) * 3, 44 + index * 2);
  }
  return output;
}

function captureDir(): string {
  return mkdtempSync(join(tmpdir(), "capture-evidence-"));
}

test("a capture is recorded as its path and sha256, never its bytes", () => {
  const bytes = wavBytes();
  const path = join(captureDir(), "delivered-anna-en.wav");
  writeFileSync(path, bytes);

  const record = captureEvidence(path);

  assert.deepEqual(record, {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.deepEqual(Object.keys(record).sort(), ["path", "sha256"]);
  assert.equal(
    JSON.stringify(record).includes(bytes.toString("base64").slice(0, 12)),
    false,
    "the record never embeds the audio",
  );
});

test("a missing or empty capture is refused by name, never recorded", () => {
  const dir = captureDir();
  assert.throws(
    () => captureEvidence(join(dir, "absent.wav")),
    (error: unknown) =>
      error instanceof CaptureEvidenceError &&
      error.code === "capture-missing" &&
      /absent\.wav/.test(error.message),
  );

  const empty = join(dir, "empty.wav");
  writeFileSync(empty, Buffer.alloc(0));
  assert.throws(
    () => captureEvidence(empty),
    (error: unknown) =>
      error instanceof CaptureEvidenceError &&
      error.code === "capture-empty" &&
      /empty\.wav/.test(error.message),
  );
});

test("a recorded hash that no longer matches its file is dirty evidence", () => {
  const path = join(captureDir(), "delivered-anna-en.wav");
  writeFileSync(path, wavBytes(1));
  const record = captureEvidence(path);

  assert.equal(verifyCaptureRecord(record).status, "verified");

  writeFileSync(path, wavBytes(2));
  const dirty = verifyCaptureRecord(record);
  assert.equal(dirty.status, "dirty");
  assert.match(dirty.reason ?? "", /sha256/);
  assert.match(dirty.reason ?? "", new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a capture that is gone is unresolved, never verified against nothing", () => {
  const path = join(captureDir(), "delivered-anna-en.wav");
  writeFileSync(path, wavBytes());
  const record = captureEvidence(path);

  const missing = verifyCaptureRecord({ ...record, path: join(captureDir(), "gone.wav") });
  assert.equal(missing.status, "missing");
  assert.match(missing.reason ?? "", /gone\.wav/);
});

test("a record carrying audio bytes is refused by name", () => {
  const smuggled = {
    path: "artifacts/delivered.wav",
    sha256: "a".repeat(64),
    data: "UklGRiQAAABXQVZF",
  };

  const verdict = verifyCaptureRecord(smuggled);
  assert.equal(verdict.status, "malformed");
  assert.match(verdict.reason ?? "", /data/);
  assert.match(verdict.reason ?? "", /audio bytes/);
});
