import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CASCADE_PLATFORM_CAPTURE_ABSENCE,
  VENDOR_BILLED_COST_ABSENCE,
  VENDOR_OWNED_PROVIDER_ABSENCE,
  buildSkeletonArtifact,
  DEFAULT_GATE_VOICE,
} from "./scoreboard";
import {
  ARTIFACT_SECTIONS,
  ArtifactReadError,
  artifactCostTotal,
  artifactSectionGaps,
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

/** A capture leg's provenance: a gitignored file and its hash, never audio. */
function capture(name: string) {
  return { path: `artifacts/${name}.wav`, sha256: "a".repeat(64) };
}

/**
 * A cascade artifact carrying every section of the one shared shape (M12): the
 * manifest the reader judges, not a managed artifact with a field bolted on.
 */
function cascadeArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = managedArtifact();
  return {
    ...(serialized(base) as Record<string, unknown>),
    pipeline: "cascade",
    subject: {
      agent: { kind: "demo", voice: "anna", agentId: null },
      locale: "en",
      transport: "browser",
      source: "flag",
    },
    run: {
      runId: base.runId,
      variant: "cascade-anna-1",
      startedAt: "2026-10-29T10:00:00.000Z",
      finishedAt: "2026-10-29T10:00:03.000Z",
    },
    providers: {
      stt: "assemblyai-meta",
      llm: "meta-llama-3.3",
      tts: "meta-speech",
    },
    latency: {
      screenToFirstPartialMs: 180,
      speechCompleteToFirstTokenMs: 240,
      replyGapP50Ms: 900,
      commitToFirstPlayoutMs: { absent: "N/A — the cascade has no commit mark" },
    },
    cost: {
      currency: "USD",
      rateTableVersion: "rates-2026-10-29",
      legs: { stt: 0.0031, llm: 0.0024, tts: 0.0045 },
      total: 0.01,
    },
    captures: {
      reference: capture("reference"),
      platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
      delivered: capture("delivered"),
    },
    eligibility: { eligible: true },
    ...overrides,
  };
}

/** A managed artifact declaring its pipeline: the same shape, three capture legs. */
function managedFullArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = managedArtifact();
  return {
    ...(serialized(base) as Record<string, unknown>),
    pipeline: "managed",
    subject: {
      agent: { kind: "demo", voice: "anna", agentId: null },
      locale: "en",
      transport: "browser",
      source: "default",
    },
    run: {
      runId: base.runId,
      variant: "managed-anna-1",
      startedAt: "2026-10-29T10:00:00.000Z",
      finishedAt: "2026-10-29T10:00:03.000Z",
    },
    providers: {
      stt: { absent: VENDOR_OWNED_PROVIDER_ABSENCE },
      llm: { absent: VENDOR_OWNED_PROVIDER_ABSENCE },
      tts: { absent: VENDOR_OWNED_PROVIDER_ABSENCE },
    },
    latency: {
      screenToFirstPartialMs: { absent: "N/A — no partials" },
      speechCompleteToFirstTokenMs: { absent: "N/A — no token stream" },
      replyGapP50Ms: 900,
      commitToFirstPlayoutMs: { absent: "N/A — the managed path has no commit mark" },
    },
    cost: { absent: VENDOR_BILLED_COST_ABSENCE },
    captures: {
      reference: capture("reference"),
      platform: capture("platform"),
      delivered: capture("delivered"),
    },
    eligibility: { eligible: true },
    ...overrides,
  };
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
  const raw = cascadeArtifact({
    captures: {
      reference: capture("reference"),
      delivered: capture("delivered"),
      platform: capture("platform"),
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

test("a cascade artifact names the platform leg absent with a reason", () => {
  const raw = cascadeArtifact();

  const parsed = parseScoreboardArtifact(raw, "cascade.json");

  assert.equal(pipelineOfArtifact(parsed), "cascade");
  assert.deepEqual(parsed.captures?.platform, { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE });
  assert.match(CASCADE_PLATFORM_CAPTURE_ABSENCE, /N\/A/);
  assert.match(CASCADE_PLATFORM_CAPTURE_ABSENCE, /no platform capture on the cascade/);
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
  const raw = cascadeArtifact({
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

// ── One shared artifact shape (ticket 112, M12) ─────────────────────────────

test("a cascade artifact carries every section of the one shared shape", () => {
  const raw = cascadeArtifact();

  const parsed = parseScoreboardArtifact(raw, "cascade-anna.json");

  assert.equal(pipelineOfArtifact(parsed), "cascade");
  assert.deepEqual(artifactSectionGaps(parsed), [], "no section of the shared shape is missing");
  assert.deepEqual(
    ARTIFACT_SECTIONS,
    ["subject", "run", "pipeline", "providers", "gates", "latency", "cost", "captures", "eligibility", "beats"],
    "the spec names the ten sections; the reader checks exactly those",
  );
  assert.deepEqual(parsed.subject, (raw as Record<string, unknown>).subject);
  assert.deepEqual(parsed.run, (raw as Record<string, unknown>).run);
  assert.deepEqual(parsed.providers, (raw as Record<string, unknown>).providers);
  assert.deepEqual(parsed.latency, (raw as Record<string, unknown>).latency);
  assert.deepEqual(parsed.cost, (raw as Record<string, unknown>).cost);
  assert.deepEqual(parsed.eligibility, { eligible: true });
  assert.deepEqual(parsed.beats, (raw as Record<string, unknown>).beats, "beats are the artifact's own");
});

test("a managed artifact that declares its pipeline carries the same shape", () => {
  const parsed = parseScoreboardArtifact(managedFullArtifact(), "managed-anna.json");

  assert.equal(pipelineOfArtifact(parsed), "managed");
  assert.deepEqual(artifactSectionGaps(parsed), []);
  assert.deepEqual(parsed.providers?.stt, { absent: VENDOR_OWNED_PROVIDER_ABSENCE });
  assert.equal(
    (parsed.cost as { absent: string }).absent,
    VENDOR_BILLED_COST_ABSENCE,
    "managed cost is N/A — vendor-billed, never a fabricated zero",
  );
});

test("a cascade artifact missing a shared section is refused by name", () => {
  const raw = cascadeArtifact();
  delete raw.cost;

  assert.throws(
    () => parseScoreboardArtifact(raw, "incomplete.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "cost" &&
      /cost/.test(error.message) &&
      /shared shape/.test(error.message),
    "the refusal names the missing section, not just 'invalid artifact'",
  );
});

test("every missing section is named, not only the first", () => {
  const raw = cascadeArtifact();
  delete raw.subject;
  delete raw.eligibility;

  assert.throws(
    () => parseScoreboardArtifact(raw, "incomplete.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "subject" &&
      /subject/.test(error.message) &&
      /eligibility/.test(error.message),
  );
});

test("a cascade artifact carries reference and delivered, and no unnamed N/A", () => {
  const missingDelivered = cascadeArtifact({
    captures: {
      reference: capture("reference"),
      platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(missingDelivered, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "captures.delivered" &&
      /delivered/.test(error.message),
    "a cascade run that recorded no delivered capture is refused by name",
  );

  const unnamedPlatform = cascadeArtifact({
    captures: {
      reference: capture("reference"),
      platform: null,
      delivered: capture("delivered"),
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(unnamedPlatform, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "captures.platform" &&
      /named reason/.test(error.message),
    "an unexplained null is not the named N/A the spec asks for",
  );

  const emptyReason = cascadeArtifact({
    captures: {
      reference: capture("reference"),
      platform: { absent: "  " },
      delivered: capture("delivered"),
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(emptyReason, "cascade.json"),
    (error: unknown) => error instanceof ArtifactReadError && error.field === "captures.platform",
    "an absent leg with an empty reason is not a named reason",
  );
});

test("a managed artifact carries all three capture legs", () => {
  const absentPlatform = managedFullArtifact({
    captures: {
      reference: capture("reference"),
      platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
      delivered: capture("delivered"),
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(absentPlatform, "managed.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "captures.platform" &&
      /managed/.test(error.message),
    "the managed path has a platform recording; it cannot claim the cascade's N/A",
  );

  const missingPlatform = managedFullArtifact({
    captures: { reference: capture("reference"), delivered: capture("delivered") },
  });
  assert.throws(
    () => parseScoreboardArtifact(missingPlatform, "managed.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError && error.field === "captures.platform",
  );
});

test("an unmeasured cost leg makes the total unmeasured, never a partial sum", () => {
  assert.equal(
    artifactCostTotal({ stt: 0.0031, llm: "unmeasured", tts: 0.0045 }),
    "unmeasured",
    "one unmeasured unit makes the total unmeasured",
  );
  assert.ok(
    Math.abs((artifactCostTotal({ stt: 0.0031, llm: 0.0024, tts: 0.0045 }) as number) - 0.01) < 1e-9,
    "a fully measured cost sums its legs",
  );

  const partialSum = cascadeArtifact({
    cost: {
      currency: "USD",
      rateTableVersion: "rates-2026-10-29",
      legs: { stt: 0.0031, llm: "unmeasured", tts: 0.0045 },
      total: 0.0076,
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(partialSum, "partial.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "cost.total" &&
      /unmeasured/.test(error.message) &&
      /llm/.test(error.message),
    "a partial sum presented as complete is refused, naming the unmeasured leg",
  );

  const unmeasuredTotal = cascadeArtifact({
    cost: {
      currency: "USD",
      rateTableVersion: "rates-2026-10-29",
      legs: { stt: 0.0031, llm: "unmeasured", tts: 0.0045 },
      total: "unmeasured",
    },
  });
  assert.equal(
    (parseScoreboardArtifact(unmeasuredTotal, "unmeasured.json").cost as { total: string }).total,
    "unmeasured",
  );
});

test("a cost that is missing a leg, its rate table or a sane amount is refused by name", () => {
  const missingLeg = cascadeArtifact({
    cost: {
      currency: "USD",
      rateTableVersion: "rates-2026-10-29",
      legs: { stt: 0.0031, llm: 0.0024 },
      total: 0.0055,
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(missingLeg, "cost.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError && error.field === "cost.legs" && /tts/.test(error.message),
    "an absent leg is not zero: it must be recorded as unmeasured",
  );

  const noRateTable = cascadeArtifact({
    cost: { currency: "USD", legs: { stt: 0, llm: 0, tts: 0 }, total: 0 },
  });
  assert.throws(
    () => parseScoreboardArtifact(noRateTable, "cost.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError && error.field === "cost.rateTableVersion",
    "every cost cites the rate-table version it was priced with",
  );

  const negative = cascadeArtifact({
    cost: {
      currency: "USD",
      rateTableVersion: "rates-2026-10-29",
      legs: { stt: -0.01, llm: 0, tts: 0 },
      total: -0.01,
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(negative, "cost.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError && error.field === "cost.legs.stt" && /non-negative/.test(error.message),
  );
});

test("a provider table names each leg it used, and refuses an unknown one", () => {
  const unknownLeg = cascadeArtifact({
    providers: { stt: "assemblyai-meta", asr: "whisper", tts: "meta-speech" },
  });
  assert.throws(
    () => parseScoreboardArtifact(unknownLeg, "providers.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "providers.asr" &&
      /asr/.test(error.message),
  );

  const emptyName = cascadeArtifact({ providers: { stt: "  ", llm: "meta", tts: "meta" } });
  assert.throws(
    () => parseScoreboardArtifact(emptyName, "providers.json"),
    (error: unknown) => error instanceof ArtifactReadError && error.field === "providers.stt",
  );

  const namedAbsence = cascadeArtifact({
    providers: {
      stt: { absent: VENDOR_OWNED_PROVIDER_ABSENCE },
      llm: { absent: VENDOR_OWNED_PROVIDER_ABSENCE },
      tts: { absent: VENDOR_OWNED_PROVIDER_ABSENCE },
    },
  });
  assert.deepEqual(parseScoreboardArtifact(namedAbsence, "providers.json").providers?.llm, {
    absent: VENDOR_OWNED_PROVIDER_ABSENCE,
  });
});

test("a latency row is a number or a named N/A, and N/A is never zero", () => {
  const unknownGap = cascadeArtifact({
    latency: { screenLatencyMs: 180 },
  });
  assert.throws(
    () => parseScoreboardArtifact(unknownGap, "latency.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.screenLatencyMs" &&
      /screenLatencyMs/.test(error.message),
  );

  const negativeGap = cascadeArtifact({ latency: { replyGapP50Ms: -1 } });
  assert.throws(
    () => parseScoreboardArtifact(negativeGap, "latency.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError && error.field === "latency.replyGapP50Ms",
  );
});

test("the cascade has no commit mark and managed has no partials: N/A is named", () => {
  const cascadeCommit = cascadeArtifact({ latency: { commitToFirstPlayoutMs: 900 } });
  assert.throws(
    () => parseScoreboardArtifact(cascadeCommit, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.commitToFirstPlayoutMs" &&
      /cascade/.test(error.message) &&
      /N\/A/.test(error.message),
    "a copied reply gap is not a commit-to-playout mark",
  );

  const managedPartials = managedFullArtifact({ latency: { screenToFirstPartialMs: 180 } });
  assert.throws(
    () => parseScoreboardArtifact(managedPartials, "managed.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.screenToFirstPartialMs" &&
      /managed/.test(error.message) &&
      /N\/A/.test(error.message),
    "managed records N/A — no partials, never a zero or a win",
  );
});

test("an ineligible run names every reason, and an eligible one carries none", () => {
  const silent = cascadeArtifact({ eligibility: { eligible: false } });
  assert.throws(
    () => parseScoreboardArtifact(silent, "eligibility.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "eligibility.reasons" &&
      /reason/.test(error.message),
    "an ineligible run is BLOCKED with a named reason, never a silent false",
  );

  const refused = cascadeArtifact({
    eligibility: { eligible: false, reasons: ["provider fallback on llm at connect"] },
  });
  assert.deepEqual(parseScoreboardArtifact(refused, "eligibility.json").eligibility, {
    eligible: false,
    reasons: ["provider fallback on llm at connect"],
  });

  const contradictory = cascadeArtifact({
    eligibility: { eligible: true, reasons: ["nothing"] },
  });
  assert.throws(
    () => parseScoreboardArtifact(contradictory, "eligibility.json"),
    (error: unknown) => error instanceof ArtifactReadError && error.field === "eligibility.reasons",
  );
});

test("the run block identifies the same run the artifact does", () => {
  const mismatch = cascadeArtifact({
    run: {
      runId: "run-other",
      variant: "cascade-anna-1",
      startedAt: "2026-10-29T10:00:00.000Z",
      finishedAt: "2026-10-29T10:00:03.000Z",
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(mismatch, "run.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "run.runId" &&
      /run-other/.test(error.message) &&
      /run-test/.test(error.message),
    "an artifact and its run block cannot name different runs",
  );

  const noVariant = cascadeArtifact({
    run: {
      runId: "run-test",
      startedAt: "2026-10-29T10:00:00.000Z",
      finishedAt: "2026-10-29T10:00:03.000Z",
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(noVariant, "run.json"),
    (error: unknown) => error instanceof ArtifactReadError && error.field === "run.variant",
  );

  const badClock = cascadeArtifact({
    run: {
      runId: "run-test",
      variant: "cascade-anna-1",
      startedAt: "not-a-date",
      finishedAt: "2026-10-29T10:00:03.000Z",
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(badClock, "run.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "run.startedAt" &&
      /not-a-date/.test(error.message),
  );
});

test("a gap the engine cannot produce is recorded, never silently absent", () => {
  const silentCommit = cascadeArtifact({
    latency: { screenToFirstPartialMs: 180, replyGapP50Ms: 900 },
  });
  assert.throws(
    () => parseScoreboardArtifact(silentCommit, "silent.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.commitToFirstPlayoutMs" &&
      /silently absent/.test(error.message),
  );

  const silentPartials = managedFullArtifact({
    latency: { replyGapP50Ms: 900, commitToFirstPlayoutMs: { absent: "N/A — the managed path has no commit mark" } },
  });
  assert.throws(
    () => parseScoreboardArtifact(silentPartials, "silent.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.screenToFirstPartialMs" &&
      /silently absent/.test(error.message),
  );
});

test("a provider table names all three legs", () => {
  const missingTts = cascadeArtifact({
    providers: { stt: "assemblyai-meta", llm: "meta-llama-3.3" },
  });
  assert.throws(
    () => parseScoreboardArtifact(missingTts, "providers.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "providers.tts" &&
      /missing/.test(error.message),
  );
});
