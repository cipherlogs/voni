import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decodeRecordingArgs, decodeRecordingPcm } from "./recording-decode";

test("decode args restore the declared rate instead of trusting Opus's 48 kHz decode", () => {
  const args = decodeRecordingArgs("/tmp/call.ogg", 24_000);
  assert.deepEqual(args.slice(-7), [
    "-acodec",
    "pcm_s16le",
    "-ar",
    "24000",
    "-f",
    "s16le",
    "pipe:1",
  ]);
});

test("decode args refuse a missing rate rather than guessing one", () => {
  assert.throws(() => decodeRecordingArgs("/tmp/call.ogg", 0), /positive integer/);
  assert.throws(() => decodeRecordingArgs("/tmp/call.ogg", 24_000.5), /positive integer/);
});

test("a 1 s Opus recording decodes to 1 s at 24 kHz, not 2 s", (t) => {
  const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("ffmpeg is not on PATH: the decode leg is a named skip, not a pass");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "voni-decode-"));
  try {
    const ogg = join(dir, "one-second.ogg");
    const made = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:a", "libopus", ogg,
    ]);
    assert.equal(made.status, 0, "could not generate the fixture");
    const pcm = decodeRecordingPcm(ogg, 24_000);
    assert.ok(pcm, "decode failed");
    // One second of mono s16le at 24 kHz. The old bug produced twice this.
    assert.ok(
      Math.abs(pcm.byteLength - 48_000) < 2_400,
      `expected ~48000 bytes for 1 s at 24 kHz, got ${pcm.byteLength}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
