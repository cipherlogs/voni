import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkeletonArtifact, DEFAULT_GATE_VOICE } from "./scoreboard";
import {
  ArtifactReadError,
  parseScoreboardArtifact,
  pipelineOfArtifact,
  readScoreboardArtifactFile,
} from "./artifact-reader";

/** Today's writer, so the reader is exercised against a real managed artifact. */
function managedArtifact() {
  return buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "  ✗ stop-over #1: cut too late\n",
    exitCode: 0,
    durationMs: 1000,
    runs: 1,
    dryRun: true,
    gaps: { "greeting-cut": [5000] },
    codeFingerprint: { head: "f7d1d4e2abcdef", dirty: true, dirtyHash: "0".repeat(64) },
    runId: "run-test",
  });
}

/** The artifact as the writer serializes it, read back through JSON. */
function serialized(artifact = managedArtifact(), extra: Record<string, unknown> = {}): unknown {
  return JSON.parse(JSON.stringify({ ...artifact, ...extra })) as unknown;
}

test("today's managed artifact parses unchanged and yields the same gate rows", () => {
  const written = managedArtifact();
  const parsed = parseScoreboardArtifact(serialized(written), "run-test.json");

  assert.deepEqual(parsed.gates, written.gates, "the shared gate validator returns the written rows");
  assert.deepEqual(parsed, serialized(written));
  assert.equal(parsed.pipeline, undefined, "the reader never invents a field on a legacy artifact");
  assert.equal(pipelineOfArtifact(parsed), "managed", "an absent discriminator means managed");
  assert.equal(pipelineOfArtifact(written), "managed");
});

test("the file reader parses an artifact off disk", () => {
  const path = join(mkdtempSync(join(tmpdir(), "artifact-reader-")), "scoreboard.json");
  writeFileSync(path, JSON.stringify(managedArtifact()), { mode: 0o600 });

  const parsed = readScoreboardArtifactFile(path);

  assert.equal(parsed.runId, "run-test");
  assert.deepEqual(parsed.gates, managedArtifact().gates);
});

test("a cascade artifact that claims a platform capture is refused by name", () => {
  const raw = serialized(managedArtifact(), {
    pipeline: "cascade",
    captures: {
      reference: { path: "artifacts/ref.wav", sha256: "a".repeat(64) },
      delivered: { path: "artifacts/delivered.wav", sha256: "b".repeat(64) },
      platform: { path: "artifacts/platform.wav", sha256: "c".repeat(64) },
    },
  });

  assert.throws(
    () => parseScoreboardArtifact(raw, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "captures.platform" &&
      /cascade/.test(error.message) &&
      /platform/.test(error.message),
  );
});

test("a cascade artifact that marks the platform leg N/A parses and names its pipeline", () => {
  const raw = serialized(managedArtifact(), {
    pipeline: "cascade",
    captures: {
      reference: { path: "artifacts/ref.wav", sha256: "a".repeat(64) },
      platform: null,
      delivered: { path: "artifacts/delivered.wav", sha256: "b".repeat(64) },
    },
  });

  const parsed = parseScoreboardArtifact(raw, "cascade.json");

  assert.equal(pipelineOfArtifact(parsed), "cascade");
  assert.equal(parsed.captures?.platform, null);
});

test("a managed artifact carrying a provider fallback event is refused by name", () => {
  const raw = serialized(managedArtifact(), {
    events: [{ type: "provider_fallback", leg: "llm", from: "meta", to: "gateway", phase: "connect" }],
  });

  assert.throws(
    () => parseScoreboardArtifact(raw, "managed.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "events" &&
      /provider_fallback/.test(error.message) &&
      /managed/.test(error.message),
  );
});

test("a cascade artifact may carry its own fallback event", () => {
  const raw = serialized(managedArtifact(), {
    pipeline: "cascade",
    captures: { reference: null, platform: null, delivered: null },
    events: [{ type: "provider_fallback", leg: "llm", from: "meta", to: "gateway", phase: "connect" }],
  });

  assert.equal(pipelineOfArtifact(parseScoreboardArtifact(raw, "cascade.json")), "cascade");
});

test("an unknown schema version is refused, never coerced or guessed", () => {
  const cases: { version: unknown; valueName: string }[] = [
    { version: 99, valueName: "99" },
    { version: 3, valueName: "3" },
    { version: "4", valueName: '"4"' },
    { version: null, valueName: "null" },
    { version: undefined, valueName: "missing" },
  ];
  for (const { version, valueName } of cases) {
    assert.throws(
      () => parseScoreboardArtifact(serialized(managedArtifact(), { schemaVersion: version }), "future.json"),
      (error: unknown) =>
        error instanceof ArtifactReadError &&
        error.field === "schemaVersion" &&
        error.message.includes(valueName) &&
        error.message.includes(String(4)),
      `schemaVersion ${valueName} must be refused by name, not coerced`,
    );
  }
});

test("an unknown pipeline value is refused by name", () => {
  const raw = serialized(managedArtifact(), { pipeline: "phone" });

  assert.throws(
    () => parseScoreboardArtifact(raw, "phone.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "pipeline" &&
      /"phone"/.test(error.message) &&
      /managed, cascade/.test(error.message),
  );
});

test("an unknown capture leg is refused by name", () => {
  const raw = serialized(managedArtifact(), {
    captures: { microphone: { path: "artifacts/mic.wav", sha256: "d".repeat(64) } },
  });

  assert.throws(
    () => parseScoreboardArtifact(raw, "unknown-leg.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "captures.microphone" &&
      /microphone/.test(error.message),
  );
});

test("a malformed artifact file is refused with its path", () => {
  const path = join(mkdtempSync(join(tmpdir(), "artifact-reader-")), "broken.json");
  writeFileSync(path, "{ not json", { mode: 0o600 });

  assert.throws(
    () => readScoreboardArtifactFile(path),
    (error: unknown) =>
      error instanceof ArtifactReadError && error.source === path && /is not JSON/.test(error.message),
  );
});
