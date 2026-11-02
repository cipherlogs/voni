/**
 * The harness owns the microphone at `getUserMedia`, before app code runs.
 *
 * These tests pin the two things a reviewer cannot see in a screenshot: the
 * init script is the mic seam (not a test flag inside the call path), and the
 * Playwright spec installs it before the page's first navigation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pcm16ToBase64, syntheticMicSource } from "./synthetic-mic";
import { readTakePcm } from "./call";
import { removeTree, wavBytes } from "./fixtures";

const VONI_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("the init script replaces getUserMedia and never names an app flag", () => {
  const source = syntheticMicSource([
    { id: "opening", pcmBase64: "AAAA", sampleRate: 24_000 },
  ]);
  assert.match(source, /getUserMedia/);
  assert.match(source, /createMediaStreamDestination/);
  assert.match(source, /installedBeforeAppCode:true/);
  assert.match(source, /__voniSyntheticMic/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_VONI_E2E_CAPTURE/);
  assert.doesNotMatch(source, /cascade-session/);
  assert.doesNotMatch(source, /\/api\//);
});

test("the Playwright spec installs the mic before the first navigation", () => {
  const spec = readFileSync(join(VONI_ROOT, "tests/e2e/browser-adapter.spec.ts"), "utf8");
  const install = spec.indexOf("installSyntheticMic(");
  const goto = spec.indexOf("page.goto(");
  assert.ok(install >= 0, "the spec installs the synthetic mic");
  assert.ok(goto >= 0, "the spec opens the landing page");
  assert.ok(
    install < goto,
    "the init script must be installed before any page script runs; otherwise app code owns a real device",
  );
  assert.doesNotMatch(spec, /routeWebSocket|page\.route\(/, "a mocked socket or route makes this a diagnosis");
});

test("the production call path has no synthetic-mic test branch", () => {
  for (const relative of [
    "src/components/voice-call.tsx",
    "src/lib/voice/cascade-session.ts",
    "src/lib/voice/mic-capture.ts",
  ]) {
    const source = readFileSync(join(VONI_ROOT, relative), "utf8");
    assert.doesNotMatch(
      source,
      /__voniSyntheticMic|syntheticMicrophone|synthetic-mic/,
      `${relative} must not know the harness exists`,
    );
  }
});

test("a caller take round-trips through PCM16 base64", () => {
  const bytes = wavBytes(50);
  const pcm = bytes.subarray(44);
  const encoded = pcm16ToBase64(pcm);
  assert.equal(Buffer.from(encoded, "base64").toString("hex"), Buffer.from(pcm).toString("hex"));
});

test("an ambient bed is looped under the caller, never treated as a take", () => {
  const source = syntheticMicSource(
    [{ id: "opening", pcmBase64: "AAAA", sampleRate: 24_000 }],
    {
      soundscape: {
        pcmBase64: "AgABAA==",
        sampleRate: 24_000,
        levelDb: -18,
      },
    },
  );
  assert.match(source, /"soundscape":\{"pcmBase64":"AgABAA=="/);
  assert.match(source, /source\.loop\s*=\s*true/);
  assert.match(source, /Math\.pow\(10/);
  assert.equal(source.match(/source\.start\(\)/g)?.length, 1, "the bed starts once and loops");
});

test("the take reader refuses a non-mono WAV", () => {
  const root = mkdtempSync(join(tmpdir(), "dv17-mic-"));
  try {
    const file = join(root, "stereo.wav");
    const bytes = wavBytes(50);
    const copy = Buffer.from(bytes);
    copy.writeUInt16LE(2, 22);
    writeFileSync(file, copy);
    assert.throws(() => readTakePcm(file), /mono 16-bit PCM/);
  } finally {
    removeTree(root);
  }
});
