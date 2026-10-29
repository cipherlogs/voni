/**
 * The comparison CLI runs on three saved files and prints one table. These
 * tests drive it as a user would: a missing or unreadable file must fail before
 * any table is printed, and three readable files must produce the table.
 *
 * After the table comes the first-divergence verdict, so these tests also pin
 * that the verdict never replaces the table and that `--line`/`--transcript`
 * can attribute a divergence to model text.
 *
 * Floor mode (`--floor`) is also driven through the CLI, because that is where
 * the committed floor is loaded: a subject that matches the floor clears it, a
 * subject that is worse fails and names the axis, and a missing required flag
 * is a usage error rather than a verdict. Floor mode composes with the table
 * and the verdict: when a platform capture is supplied, both print first and
 * the floor verdict still decides the exit code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    "onset (s)",
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

/** The committed floor, copied to a working directory as a subject capture. */
function floorCopy(dir: string, name: string): string {
  const source = new URL("../evidence/vendor-floor/anna-en.wav", import.meta.url);
  const path = join(dir, name);
  writeFileSync(path, readFileSync(source));
  return path;
}

/** The same PCM16 file at a different gain, so an axis can be made worse. */
function gainWav(bytes: Buffer, gain: number): Buffer {
  const out = Buffer.from(bytes);
  const dataStart = out.indexOf("data") + 8;
  for (let offset = dataStart; offset < out.length; offset += 2) {
    out.writeInt16LE(Math.round(out.readInt16LE(offset) * gain), offset);
  }
  return out;
}

test("--floor clears a subject that matches the committed vendor floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "compare-floor-"));
  const reference = floorCopy(dir, "reference.wav");
  const delivered = floorCopy(dir, "delivered.wav");
  const result = run(["--floor", "--reference", reference, "--delivered", delivered]);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Floor mode/);
  assert.match(result.stdout, /anna\/en at .*evidence\/vendor-floor\/anna-en\.wav/);
  assert.match(result.stdout, /PASSES against the vendor floor/);
  assert.doesNotMatch(result.stdout, /Voice-parity audio comparison/, "no table in floor mode");
});

test("--floor fails a subject that is worse than the floor and names the axis", () => {
  const dir = mkdtempSync(join(tmpdir(), "compare-floor-worse-"));
  const reference = floorCopy(dir, "reference.wav");
  const delivered = join(dir, "delivered-quiet.wav");
  writeFileSync(delivered, gainWav(readFileSync(reference), 0.5));
  const result = run(["--floor", "--reference", reference, "--delivered", delivered]);

  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /FAILS against the vendor floor/);
  assert.match(result.stdout, /worse on level/);
  assert.match(result.stdout, /anna-en\.wav/);
});

test("--floor without a reference is a usage error, not a verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "compare-floor-usage-"));
  const delivered = floorCopy(dir, "delivered.wav");
  const result = run(["--floor", "--delivered", delivered]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--reference is required/);
  assert.equal(result.stdout.trim(), "");
});

test("--floor with a platform file prints the table and then the verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "compare-floor-table-"));
  const reference = floorCopy(dir, "reference.wav");
  const platform = floorCopy(dir, "platform.wav");
  const delivered = floorCopy(dir, "delivered.wav");
  const result = run([
    "--floor",
    "--reference",
    reference,
    "--platform",
    platform,
    "--delivered",
    delivered,
  ]);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Voice-parity audio comparison/);
  assert.match(result.stdout, /Floor mode/);
  assert.ok(
    result.stdout.indexOf("Floor mode") > result.stdout.indexOf("Voice-parity audio comparison"),
    "the table prints before the floor verdict",
  );
  const verdictAt = result.stdout.indexOf("Verdict:");
  assert.ok(
    verdictAt > result.stdout.indexOf("Voice-parity audio comparison"),
    "the verdict prints after the table",
  );
  assert.ok(verdictAt < result.stdout.indexOf("Floor mode"), "the floor verdict still prints last");
});

test("the verdict prints after the table, naming the first divergence", () => {
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
  const tableAt = result.stdout.indexOf("breakup longest silence (s)");
  const verdictAt = result.stdout.indexOf("Verdict:");
  assert.ok(tableAt >= 0, "the table printed");
  assert.ok(verdictAt > tableAt, "the verdict prints after the table");
  assert.match(result.stdout, /Verdict: No divergence: /);
  assert.match(result.stdout, /comparisonOnsetToleranceS 0\.05 s/);
});

test("--line and --transcript attribute a divergence to model text", () => {
  const files = captureDir();
  const result = run([
    "--reference",
    files.reference,
    "--platform",
    files.platform,
    "--delivered",
    files.delivered,
    "--line",
    "Your appointment is at four o'clock.",
    "--transcript",
    "Your appointment is at nine o'clock.",
  ]);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(
    result.stdout,
    /Verdict: The first divergence is model text: the platform transcript says "Your appointment is at nine o'clock\."/,
  );
  assert.match(result.stdout, /comparisonModelTextWordChanges 0 count/);
});
