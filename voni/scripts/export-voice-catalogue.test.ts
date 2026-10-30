import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { VOICES } from "../src/lib/agents/voices";

const SCRIPT = new URL("./export-voice-catalogue.mts", import.meta.url).pathname;
const ROOT = new URL("../", import.meta.url).pathname;

function exportCatalogue(): {
  schemaVersion: number;
  source: string;
  voices: Array<{ id: string; language: string; languageCode: string }>;
} {
  const result = spawnSync("node", ["--import", "tsx", SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as ReturnType<typeof exportCatalogue>;
}

test("the catalogue export is the app's own VOICES, not a second table", () => {
  const document = exportCatalogue();

  assert.equal(document.schemaVersion, 1);
  assert.equal(document.source, "src/lib/agents/voices.ts");
  assert.deepEqual(
    document.voices.map((voice) => voice.id),
    VOICES.map((voice) => voice.id),
  );
  assert.deepEqual(
    document.voices.filter((voice) => voice.languageCode === "de").map((voice) => voice.id),
    VOICES.filter((voice) => voice.languageCode === "de").map((voice) => voice.id),
  );
  assert.ok(
    document.voices.some((voice) => voice.id === "juergen" && voice.languageCode === "de"),
    "the unbound German row is present in the export the probe reads",
  );
});
