/**
 * The comparison CLI runs on three saved files and prints one table. These
 * tests drive it as a user would: a missing or unreadable file must fail before
 * any table is printed, and three readable files must produce the table.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("./compare-audio.mts", import.meta.url).pathname;
const VONI = new URL("../", import.meta.url).pathname;
const SAMPLE_RATE = 24_000;

function run(args: string[]) {
  return spawnSync("node", ["--import", "tsx", SCRIPT, ...args], {
    cwd: VONI,
    encoding: "utf8",
  });
}

/** A standard 16-bit PCM WAV; the comparison never invents its own input. */
function wavFile(samples: number[], sampleRate = SAMPLE_RATE): Buffer {
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
  samples.forEach((value, index) => {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32_767), 44 + index * 2);
  });
  return out;
}

function tone(seconds: number): number[] {
  const count = Math.round(seconds * SAMPLE_RATE);
  return Array.from(
    { length: count },
    (_unused, index) => 0.4 * Math.sin((2 * Math.PI * 500 * index) / SAMPLE_RATE),
  );
}

function captureDir(): { dir: string; reference: string; platform: string; delivered: string } {
  const dir = mkdtempSync(join(tmpdir(), "compare-audio-"));
  const reference = join(dir, "reference.wav");
  const platform = join(dir, "platform.wav");
  const delivered = join(dir, "delivered.wav");
  const toneFile = wavFile(tone(1));
  writeFileSync(reference, toneFile);
  writeFileSync(platform, toneFile);
  writeFileSync(delivered, toneFile);
  return { dir, reference, platform, delivered };
}

test("a missing capture fails before a table is printed", () => {
  const files = captureDir();
  const result = run([
    "--reference",
    files.reference,
    "--platform",
    files.platform,
    "--delivered",
    join(files.dir, "absent.wav"),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /delivered capture unreadable/);
  assert.match(result.stderr, /absent\.wav/);
  assert.equal(result.stdout.trim(), "", "a refused comparison prints no table");
});

test("an unreadable capture is named by path, not decoded into silence", () => {
  const files = captureDir();
  writeFileSync(files.platform, "not a wave file");
  const result = run([
    "--reference",
    files.reference,
    "--platform",
    files.platform,
    "--delivered",
    files.delivered,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /platform capture unreadable/);
  assert.match(result.stderr, /platform\.wav/);
  assert.match(result.stderr, /RIFF\/WAVE/);
  assert.equal(result.stdout.trim(), "", "a refused comparison prints no table");
});

test("a missing flag is a usage error, not a partial table", () => {
  const files = captureDir();
  const result = run(["--reference", files.reference, "--platform", files.platform]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--delivered is required/);
  assert.equal(result.stdout.trim(), "");
});

test("three saved files print one table with every metric and no live call", () => {
  const files = captureDir();
  const result = run([
    "--reference",
    files.reference,
    "--platform",
    files.platform,
    "--delivered",
    files.delivered,
  ]);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Voice-parity audio comparison/);
  for (const metric of [
    "sample rate (Hz)",
    "byte rate (B/s)",
    "integrated (LUFS)",
    "RMS (dBFS)",
    "true peak (dBTP)",
    "distortion vs reference (dB)",
    "crest factor (peak/RMS)",
    "500 Hz band (dBFS)",
    "band spread (dB)",
    "band delta 500→4000 Hz (dB)",
    "modulation rate (Hz)",
    "modulation depth (%)",
    "breakup count",
    "breakup total silence (s)",
    "breakup longest silence (s)",
  ]) {
    assert.match(result.stdout, new RegExp(metric.replace(/[()]/g, "\\$&")), `table has ${metric}`);
  }
  assert.ok(result.stdout.includes(files.reference));
  assert.ok(result.stdout.includes(files.platform));
  assert.ok(result.stdout.includes(files.delivered));
  assert.doesNotMatch(result.stderr, /ASSEMBLYAI|fetch|session/i, "no call is placed");
});
