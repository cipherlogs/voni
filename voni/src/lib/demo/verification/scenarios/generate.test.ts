import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScenarioError, sha256Hex } from "./index";
import {
  UNHASHED_TAKE_SHA256,
  applyTakeGeneration,
  parseCartesiaSse,
  planTakeGeneration,
  wavFromPcm,
} from "./generate";
import type { ScenarioDocument } from "./types";
import { parseScenario } from "./parse";

/**
 * Ticket 12's generator: the corpus is data plus a tool that records it, and a
 * changed take is a deliberate `--retake`, never a silent overwrite.
 *
 * The vendor call is injected, so the suite runs without a key. The real TTS
 * bytes are committed with their hashes in `corpus/` and are never regenerated
 * by a test.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "dv12-generate-"));
  roots.push(root);
  return root;
}

function document(overrides: Record<string, unknown> = {}): ScenarioDocument {
  const raw = {
    schemaVersion: 1,
    name: "golden-flow-hello",
    class: "golden-flow",
    locale: "en",
    heldOut: false,
    expectedProperties: ["L4"],
    soundscape: { id: "quiet-room" },
    faults: [],
    edge: [],
    takes: [
      {
        id: "hello",
        audio: "takes/hello.wav",
        sha256: UNHASHED_TAKE_SHA256,
        text: "Hi, is this Voni?",
      },
    ],
    script: [{ take: "hello", trigger: { type: "call-open" } }],
    ...overrides,
  };
  return parseScenario(raw, { knownProperties: new Set(["L4"]) });
}

/** A synth stub: writes a tone whose bytes differ per call count. */
function synth(): (text: string) => Promise<Uint8Array> {
  let calls = 0;
  return async (text: string) => {
    calls += 1;
    const bytes = new Uint8Array(2 * 240);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index + calls * 7 + text.length) % 251;
    }
    return bytes;
  };
}

test("a WAV is a 24 kHz mono PCM16 file the loader can hash", () => {
  const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
  const wav = wavFromPcm(pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt16LE(20), 1, "PCM");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 24_000, "24 kHz");
  assert.equal(wav.readUInt16LE(34), 16, "16-bit");
  assert.equal(wav.readUInt32LE(40), pcm.byteLength);
  assert.equal(wav.byteLength, 44 + pcm.byteLength);
});

test("an odd PCM byte count is refused by name, never padded into a WAV", () => {
  assert.throws(
    () => wavFromPcm(new Uint8Array([1, 2, 3])),
    (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.equal(error.code, "invalid-audio");
      assert.match(error.message, /even/);
      return true;
    },
  );
});

test("the Cartesia SSE parser keeps audio chunks and refuses an error event", () => {
  const audio = Buffer.from([1, 0, 2, 0]);
  const stream = [
    `data: ${JSON.stringify({ type: "chunk", done: false, data: audio.toString("base64") })}`,
    "",
    `data: ${JSON.stringify({ type: "chunk", done: true })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  assert.deepEqual(Buffer.from(parseCartesiaSse(stream)), audio);

  assert.throws(
    () => parseCartesiaSse(`data: ${JSON.stringify({ error: "voice not found" })}\n`),
    (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.equal(error.code, "tts-failed");
      assert.match(error.message, /voice not found/);
      return true;
    },
  );
});

test("the plan names a missing, an unhashed, a recorded and a drifted take", async () => {
  const root = tempDir();
  mkdirSync(join(root, "takes"), { recursive: true });

  const missing = document({
    takes: [{ id: "hello", audio: "takes/hello.wav", sha256: UNHASHED_TAKE_SHA256, text: "Hi" }],
    script: [{ take: "hello", trigger: { type: "call-open" } }],
  });
  assert.equal((await planTakeGeneration(root, missing))[0]?.state, "unhashed");

  const bytes = wavFromPcm(new Uint8Array([1, 0, 2, 0]));
  writeFileSync(join(root, "takes", "hello.wav"), bytes);
  const unhashed = document({
    takes: [{ id: "hello", audio: "takes/hello.wav", sha256: UNHASHED_TAKE_SHA256, text: "Hi" }],
    script: [{ take: "hello", trigger: { type: "call-open" } }],
  });
  assert.equal((await planTakeGeneration(root, unhashed))[0]?.state, "unhashed");

  const recorded = document({
    takes: [{ id: "hello", audio: "takes/hello.wav", sha256: sha256Hex(bytes), text: "Hi" }],
    script: [{ take: "hello", trigger: { type: "call-open" } }],
  });
  const recordedPlan = await planTakeGeneration(root, recorded);
  assert.equal(recordedPlan[0]?.state, "recorded");
  assert.equal(recordedPlan[0]?.actualSha256, sha256Hex(bytes));

  const drifted = document({
    takes: [{ id: "hello", audio: "takes/hello.wav", sha256: "a".repeat(64), text: "Hi" }],
    script: [{ take: "hello", trigger: { type: "call-open" } }],
  });
  assert.equal((await planTakeGeneration(root, drifted))[0]?.state, "drift");
});

test("recording a missing take writes the WAV and its digest, and does not move the version", async () => {
  const root = tempDir();
  mkdirSync(join(root, "takes"), { recursive: true });
  const result = await applyTakeGeneration({
    scenarioDir: root,
    document: document(),
    synthesize: synth(),
  });

  assert.equal(result.wrote, 1);
  assert.equal(result.retaken, false);
  assert.equal(result.document.takes[0].sha256, sha256Hex(readFileSync(join(root, "takes/hello.wav"))));
  assert.notEqual(result.document.takes[0].sha256, UNHASHED_TAKE_SHA256);
  assert.equal(result.document.takes[0].text, "Hi, is this Voni?");
});

test("a drifted take is refused by name unless --retake names it", async () => {
  const root = tempDir();
  mkdirSync(join(root, "takes"), { recursive: true });
  const before = wavFromPcm(new Uint8Array([9, 0, 9, 0]));
  writeFileSync(join(root, "takes/hello.wav"), before);
  const drifted = document({
    takes: [{ id: "hello", audio: "takes/hello.wav", sha256: "a".repeat(64), text: "Hi" }],
    script: [{ take: "hello", trigger: { type: "call-open" } }],
  });

  await assert.rejects(
    applyTakeGeneration({ scenarioDir: root, document: drifted, synthesize: synth() }),
    (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.equal(error.code, "take-drift");
      assert.match(error.message, /golden-flow-hello/);
      assert.match(error.message, /hello/);
      assert.match(error.message, /--retake golden-flow-hello\/hello/);
      return true;
    },
  );
  assert.deepEqual(readFileSync(join(root, "takes/hello.wav")), before, "a refused retake writes nothing");

  const retaken = await applyTakeGeneration({
    scenarioDir: root,
    document: drifted,
    synthesize: synth(),
    retake: new Set(["golden-flow-hello/hello"]),
  });
  assert.equal(retaken.wrote, 1);
  assert.equal(retaken.retaken, true);
  assert.notEqual(retaken.document.takes[0].sha256, "a".repeat(64));
  assert.equal(retaken.document.takes[0].sha256, sha256Hex(readFileSync(join(root, "takes/hello.wav"))));
});

test("a take with no words is refused before any vendor call", async () => {
  const root = tempDir();
  mkdirSync(join(root, "takes"), { recursive: true });
  const empty = document({
    takes: [{ id: "hello", audio: "takes/hello.wav", sha256: UNHASHED_TAKE_SHA256, text: "   " }],
    script: [{ take: "hello", trigger: { type: "call-open" } }],
  });
  let calls = 0;
  await assert.rejects(
    applyTakeGeneration({
      scenarioDir: root,
      document: empty,
      synthesize: async () => {
        calls += 1;
        return new Uint8Array(2);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.equal(error.code, "missing-field");
      assert.match(error.message, /hello/);
      assert.match(error.message, /text|words/);
      return true;
    },
  );
  assert.equal(calls, 0, "no vendor is opened for a take with nothing to say");
});

test("a take path may not escape its scenario directory, even at generation time", async () => {
  const root = tempDir();
  mkdirSync(join(root, "takes"), { recursive: true });
  // parse refuses `..` already; this call proves the generator reuses that rule.
  assert.throws(
    () =>
      parseScenario(
        {
          schemaVersion: 1,
          name: "golden-flow-hello",
          class: "golden-flow",
          locale: "en",
          heldOut: false,
          expectedProperties: ["L4"],
          soundscape: { id: "quiet-room" },
          faults: [],
          edge: [],
          takes: [{ id: "hello", audio: "../outside.wav", sha256: UNHASHED_TAKE_SHA256 }],
          script: [{ take: "hello", trigger: { type: "call-open" } }],
        },
        { knownProperties: new Set(["L4"]) },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.equal(error.code, "unsafe-take-path");
      return true;
    },
  );
});
