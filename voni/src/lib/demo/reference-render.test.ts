import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REFERENCE_BITS_PER_SAMPLE,
  REFERENCE_CHANNELS,
  REFERENCE_SAMPLE_RATE,
  referenceDurationMs,
  referencePath,
  referenceTextFromFile,
  renderReference,
  type ReferenceSynth,
} from "./reference-render";
import { VONI_GREETINGS } from "./voni-agent";

/** 100 ms of PCM16 mono at 24 kHz; the fake renderer never touches a socket. */
const PCM = Buffer.alloc(4800);
for (let i = 0; i < PCM.length / 2; i += 1) PCM.writeInt16LE(Math.round(8000 * Math.sin(i / 12)), i * 2);

function stub(pcm: Buffer = PCM): ReferenceSynth & { calls: { voiceId: string; text: string }[] } {
  const calls: { voiceId: string; text: string }[] = [];
  const synth = (async (request: { voiceId: string; text: string }) => {
    calls.push(request);
    return pcm;
  }) as ReferenceSynth & { calls: typeof calls };
  synth.calls = calls;
  return synth;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "reference-render-"));
}

test("the text-file seam returns the exact line and names its two failures", () => {
  const dir = tempDir();
  const line = "El pedido número 427 no llegó.";
  const file = join(dir, "line.txt");
  writeFileSync(file, `${line}\n`);

  assert.equal(referenceTextFromFile(file), line, "the editor's trailing newline is not part of the line");
  assert.throws(() => referenceTextFromFile(join(dir, "missing.txt")), /reference text file not found/);

  const empty = join(dir, "empty.txt");
  writeFileSync(empty, " \n\t\n");
  assert.throws(() => referenceTextFromFile(empty), /reference text file is empty/);
});

test("a text file renders that exact line instead of the voice's greeting", async () => {
  const dir = tempDir();
  const line = "El pedido número 427 no llegó.";
  const file = join(dir, "line.txt");
  writeFileSync(file, `${line}\n`);

  const synth = stub();
  const rendered = await renderReference({ voiceId: "lola", dir, textFile: file, synth });

  assert.equal(synth.calls.length, 1);
  assert.equal(synth.calls[0]?.text, line, "the file's text is the line, trailing newline removed");
  assert.equal(rendered.text, line);
  assert.equal(rendered.path, referencePath(dir, "lola", line));
  assert.notEqual(
    rendered.path,
    referencePath(dir, "lola", VONI_GREETINGS.es),
    "a mid-call sentence is its own reference, not the greeting's cache entry",
  );
  assert.equal(rendered.cached, false);
  assert.ok(existsSync(rendered.path));
});

test("a missing or empty text file fails by name, before synthesizing", async () => {
  const dir = tempDir();
  const synth = stub();

  await assert.rejects(
    () => renderReference({ voiceId: "lola", dir, textFile: join(dir, "missing.txt"), synth }),
    /reference text file not found/,
  );

  const empty = join(dir, "empty.txt");
  writeFileSync(empty, " \n\t\n");
  await assert.rejects(
    () => renderReference({ voiceId: "lola", dir, textFile: empty, synth }),
    /reference text file is empty/,
  );

  assert.equal(synth.calls.length, 0, "a bad line is rejected before it is spoken");
});

test("a line cannot come from both text and a text file", async () => {
  const dir = tempDir();
  const file = join(dir, "line.txt");
  writeFileSync(file, "Una frase.");
  const synth = stub();

  await assert.rejects(
    () => renderReference({ voiceId: "lola", dir, text: "Otra frase.", textFile: file, synth }),
    /text and textFile cannot both be set/,
  );
  assert.equal(synth.calls.length, 0);
});

test("a text-file line and the greeting are comparable captures of the same voice", async () => {
  const dir = tempDir();
  const greeting = await renderReference({ voiceId: "lola", dir, synth: stub() });

  const line = "El pedido número 427 no llegó.";
  const file = join(dir, "line.txt");
  writeFileSync(file, line);
  const midCall = await renderReference({ voiceId: "lola", dir, textFile: file, synth: stub() });

  assert.equal(midCall.voiceId, greeting.voiceId, "same voice on both captures");
  assert.notEqual(midCall.path, greeting.path, "the two lines never share a cache file");

  for (const [label, captured] of [
    ["greeting", greeting],
    ["text file", midCall],
  ] as const) {
    const wav = readFileSync(captured.path);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF", `${label}: WAV container`);
    assert.equal(wav.toString("ascii", 8, 12), "WAVE", `${label}: WAV container`);
    assert.equal(wav.readUInt16LE(20), 1, `${label}: integer PCM`);
    assert.equal(wav.readUInt16LE(22), REFERENCE_CHANNELS, `${label}: mono`);
    assert.equal(wav.readUInt32LE(24), REFERENCE_SAMPLE_RATE, `${label}: same sample rate`);
    assert.equal(wav.readUInt16LE(34), REFERENCE_BITS_PER_SAMPLE, `${label}: same bit depth`);
    assert.ok(referenceDurationMs(captured.path) > 0, `${label}: measurable duration`);
  }
  assert.equal(
    referenceDurationMs(midCall.path),
    referenceDurationMs(greeting.path),
    "the same audio yields the same measurement on either capture",
  );

  const repeated = await renderReference({ voiceId: "lola", dir, textFile: file, synth: stub() });
  assert.equal(repeated.cached, true);
  assert.equal(repeated.path, midCall.path, "the text-file line has its own stable cache entry");
});

test("the CLI rejects a missing text file by name without asking for a token", () => {
  const dir = tempDir();
  const script = new URL("../../../scripts/render-reference.mts", import.meta.url).pathname;
  const env = { ...process.env, ASSEMBLYAI_API_KEY: "" };

  const result = spawnSync(
    "node",
    ["--import", "tsx", script, "--voice", "lola", "--text-file", join(dir, "missing.txt"), "--out-dir", dir],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /reference text file not found/);
  assert.doesNotMatch(result.stderr, /ASSEMBLYAI_API_KEY/, "the bad line is rejected before a token is fetched");
});

test("the default run renders the selected voice's own greeting", async () => {
  const dir = tempDir();
  const synth = stub();
  const rendered = await renderReference({ voiceId: "lola", dir, synth });

  assert.equal(synth.calls.length, 1);
  assert.equal(synth.calls[0]?.voiceId, "lola");
  assert.equal(synth.calls[0]?.text, VONI_GREETINGS.es);
  assert.notEqual(VONI_GREETINGS.es, VONI_GREETINGS.en, "the Spanish voice must not default to English");
  assert.equal(rendered.text, VONI_GREETINGS.es);
  assert.equal(rendered.path, referencePath(dir, "lola", VONI_GREETINGS.es));
  assert.ok(existsSync(rendered.path), "the default run saves a file");
  assert.equal(rendered.cached, false);
});

test("a second run for the same voice and text reuses the cached file", async () => {
  const dir = tempDir();
  const first = await renderReference({ voiceId: "lola", dir, synth: stub() });
  const firstBytes = readFileSync(first.path);

  const secondSynth = stub(Buffer.alloc(PCM.byteLength, 0x7f));
  const second = await renderReference({ voiceId: "lola", dir, synth: secondSynth });

  assert.equal(secondSynth.calls.length, 0, "the cache hit never spends a synthesis");
  assert.equal(second.cached, true);
  assert.equal(second.path, first.path);
  assert.equal(Buffer.compare(readFileSync(second.path), firstBytes), 0, "the cached file is untouched");
});

test("a truncated cache file is re-rendered instead of reused", async () => {
  const dir = tempDir();
  const first = await renderReference({ voiceId: "anna", dir, text: "Interrupted write.", synth: stub() });
  writeFileSync(first.path, readFileSync(first.path).subarray(0, 100));

  const synth = stub();
  const second = await renderReference({ voiceId: "anna", dir, text: "Interrupted write.", synth });
  assert.equal(synth.calls.length, 1, "a broken cache is not a cache hit");
  assert.equal(second.cached, false);
});

test("changing the text produces a new file rather than a stale cache hit", async () => {
  const dir = tempDir();
  const firstPcm = Buffer.alloc(800);
  firstPcm.writeInt16LE(1000, 0);
  const secondPcm = Buffer.alloc(800);
  secondPcm.writeInt16LE(-2000, 0);

  const first = await renderReference({ voiceId: "lola", dir, text: "Primera frase.", synth: stub(firstPcm) });
  const synth = stub(secondPcm);
  const second = await renderReference({ voiceId: "lola", dir, text: "Segunda frase.", synth });

  assert.equal(synth.calls.length, 1, "the second line is rendered, not served from the first");
  assert.equal(synth.calls[0]?.text, "Segunda frase.");
  assert.notEqual(second.path, first.path);
  const data = readFileSync(second.path).subarray(44);
  assert.equal(Buffer.compare(data, secondPcm), 0, "the new file holds the new line's audio");
});

test("the rendered file is at the voice's native level, with no gain or limiter applied", async () => {
  const dir = tempDir();
  // A full-scale excursion either side of zero: any gain would clip it, any
  // limiter would pull the peaks in, any normalisation would rescale both.
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(32767, 0);
  pcm.writeInt16LE(-32768, 2);
  pcm.writeInt16LE(12345, 4);
  pcm.writeInt16LE(-2345, 6);

  const rendered = await renderReference({ voiceId: "anna", dir, text: "Native level.", synth: stub(pcm) });
  const wav = readFileSync(rendered.path);

  assert.equal(Buffer.compare(wav.subarray(44), pcm), 0, "the samples are written verbatim");
  const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, 4);
  assert.deepEqual([...samples], [32767, -32768, 12345, -2345]);
});

test("the output is a saved WAV the comparison can read", async () => {
  const dir = tempDir();
  const rendered = await renderReference({ voiceId: "anna", dir, text: "Readable file.", synth: stub() });
  const wav = readFileSync(rendered.path);

  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.byteLength - 8);
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt32LE(16), 16, "PCM fmt chunk");
  assert.equal(wav.readUInt16LE(20), 1, "integer PCM");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 24_000, "the greeting session's sample rate");
  assert.equal(wav.readUInt32LE(28), 48_000, "byte rate");
  assert.equal(wav.readUInt16LE(32), 2, "block align");
  assert.equal(wav.readUInt16LE(34), 16, "16-bit");
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), PCM.byteLength);
  assert.equal(wav.byteLength, 44 + PCM.byteLength);
  assert.equal(referenceDurationMs(rendered.path), 100);
});

test("an unknown voice or an empty line fails by name, before synthesizing", async () => {
  const dir = tempDir();
  const synth = stub();
  await assert.rejects(
    () => renderReference({ voiceId: "morgan-freeman", dir, synth }),
    /unknown voice "morgan-freeman"/,
  );
  await assert.rejects(
    () => renderReference({ voiceId: "anna", dir, text: "   ", synth }),
    /needs a line to render/,
  );
  assert.equal(synth.calls.length, 0);
});
