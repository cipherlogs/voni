/**
 * The browser invocation: the one JSON the Playwright spec reads.
 *
 * The caller takes and the scenario's ambience bed travel in the same record,
 * so the harness cannot mix a bed it was never given. This is a Node test; it
 * never opens Chromium or a vendor.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCorpus } from "@/lib/demo/verification/scenarios";

import { buildBrowserInvocation } from "./call";
import { pcm16ToBase64 } from "./synthetic-mic";
import { removeTree, writeCorpus } from "./fixtures";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dv-soundscape-call-"));
}

test("the invocation carries the scenario's ambience bed at its declared level", async () => {
  const root = tempRoot();
  try {
    const corpusDir = join(root, "corpus");
    writeCorpus(corpusDir, [
      { name: "soundscape-television", soundscape: { id: "television", levelDb: -18 } },
    ]);
    const corpus = await loadCorpus({
      dir: corpusDir,
      knownProperties: new Set(["G1", "E1"]),
    });
    const scenario = corpus.scenarios.find((entry) => entry.name === "soundscape-television");
    assert.ok(scenario !== undefined);

    const runDir = join(root, "run");
    const pcm = Uint8Array.from([1, 0, 2, 0, 3, 0]);
    const { invocation } = await buildBrowserInvocation({
      call: {
        scenario,
        target: {
          appUrl: "http://127.0.0.1:3100",
          pipelineUrl: "https://localhost:8766",
          local: true,
        },
        capturesDir: join(root, "captures"),
        eventsDir: join(root, "events"),
        runDir,
        elapsedBudgetS: null,
        env: {},
        soundscapePcm: pcm,
        soundscapeLevelDb: -18,
      },
      runDir,
    });

    assert.deepEqual(invocation.soundscape, {
      id: "television",
      levelDb: -18,
      sampleRate: 24_000,
      pcmBase64: pcm16ToBase64(pcm),
    });
  } finally {
    removeTree(root);
  }
});

test("a quiet-room invocation carries no bed", async () => {
  const root = tempRoot();
  try {
    const corpusDir = join(root, "corpus");
    writeCorpus(corpusDir, [{ name: "golden-flow-smoke" }]);
    const corpus = await loadCorpus({
      dir: corpusDir,
      knownProperties: new Set(["G1", "E1"]),
    });
    const scenario = corpus.scenarios.find((entry) => entry.name === "golden-flow-smoke");
    assert.ok(scenario !== undefined);

    const runDir = join(root, "run");
    const { invocation } = await buildBrowserInvocation({
      call: {
        scenario,
        target: {
          appUrl: "http://127.0.0.1:3100",
          pipelineUrl: "https://localhost:8766",
          local: true,
        },
        capturesDir: join(root, "captures"),
        eventsDir: join(root, "events"),
        runDir,
        elapsedBudgetS: null,
        env: {},
        soundscapePcm: null,
      },
      runDir,
    });

    assert.equal(invocation.soundscape, null);
  } finally {
    removeTree(root);
  }
});
