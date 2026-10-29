import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CASCADE_NO_COMMIT_MARK_ABSENCE,
  CASCADE_PLATFORM_CAPTURE_ABSENCE,
  MANAGED_NO_COMMIT_MARK_ABSENCE,
  MANAGED_NO_PARTIALS_ABSENCE,
  MANAGED_NO_TOKEN_STREAM_ABSENCE,
  ONE_CALL_NO_P95_ABSENCE,
  VENDOR_BILLED_COST_ABSENCE,
  VENDOR_OWNED_PROVIDER_ABSENCE,
  buildArtifactShape,
  buildSkeletonArtifact,
  DEFAULT_GATE_VOICE,
  writeScoreboardArtifactFile,
  type ArtifactLatency,
  type ArtifactPipeline,
} from "./scoreboard";
import {
  ARTIFACT_SECTIONS,
  CASCADE_GAP_ROWS,
  ArtifactReadError,
  artifactCostTotal,
  artifactSectionGaps,
  cascadeLatencyFromMarks,
  parseScoreboardArtifact,
  pipelineOfArtifact,
  readScoreboardArtifactFile,
} from "./artifact-reader";
import { buildInspectReport } from "./scoreboard-report";

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
      commitToFirstPlayoutMs: { absent: MANAGED_NO_COMMIT_MARK_ABSENCE },
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
  // The event is the cascade's own fact; the artifact's eligibility flag must
  // agree with it (ticket 143 refuses a fallback event beside eligible: true).
  const raw = cascadeArtifact({
    events: [{ type: "provider_fallback", leg: "llm", from: "meta", to: "gateway", phase: "connect" }],
    eligibility: {
      eligible: false,
      reasons: ["provider fallback (leg llm, at connect); a fallback-contaminated run is not a clean run"],
    },
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
    latency: { replyGapP50Ms: 900, commitToFirstPlayoutMs: { absent: MANAGED_NO_COMMIT_MARK_ABSENCE } },
  });
  assert.throws(
    () => parseScoreboardArtifact(silentPartials, "silent.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.screenToFirstPartialMs" &&
      /silently absent/.test(error.message),
  );
});

test("a managed artifact names both cascade-only rows N/A and never as a number, zero included", () => {
  // A zero is the most tempting win: it is not a measurement of a gap the
  // managed path cannot produce, so it is refused exactly like any other value.
  for (const row of ["screenToFirstPartialMs", "speechCompleteToFirstTokenMs"] as const) {
    const zero = managedFullArtifact({
      latency: {
        ...ENGINE_LATENCY.managed,
        [row]: 0,
      },
    });
    assert.throws(
      () => parseScoreboardArtifact(zero, "managed.json"),
      (error: unknown) =>
        error instanceof ArtifactReadError &&
        error.field === `latency.${row}` &&
        /0/.test(error.message) &&
        /N\/A/.test(error.message),
      `${row} on managed is N/A, never 0ms: a zero would read as a win`,
    );
  }
});

test("a managed artifact records the commit row too, never by omission", () => {
  const raw = managedFullArtifact({
    latency: {
      screenToFirstPartialMs: { absent: MANAGED_NO_PARTIALS_ABSENCE },
      speechCompleteToFirstTokenMs: { absent: MANAGED_NO_TOKEN_STREAM_ABSENCE },
      replyGapP50Ms: 900,
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(raw, "managed.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.commitToFirstPlayoutMs" &&
      /silently absent/.test(error.message) &&
      /N\/A/.test(error.message),
    "every row the engine cannot measure is present as a named N/A",
  );
});

test("an N/A borrowing the other engine's reason is a fake value, refused by name", () => {
  const managed = managedFullArtifact({
    latency: {
      ...ENGINE_LATENCY.managed,
      commitToFirstPlayoutMs: { absent: CASCADE_NO_COMMIT_MARK_ABSENCE },
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(managed, "managed.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.commitToFirstPlayoutMs" &&
      /cascade/.test(error.message) &&
      /N\/A/.test(error.message),
    "the managed commit row carries the managed reason, not the cascade's",
  );

  const cascade = cascadeArtifact({
    latency: { ...ENGINE_LATENCY.cascade, commitToFirstPlayoutMs: { absent: MANAGED_NO_COMMIT_MARK_ABSENCE } },
  });
  assert.throws(
    () => parseScoreboardArtifact(cascade, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.commitToFirstPlayoutMs" &&
      /managed/.test(error.message),
    "the cascade commit row carries the cascade reason, not the managed one",
  );

  const cascadePartials = cascadeArtifact({
    latency: { ...ENGINE_LATENCY.cascade, screenToFirstPartialMs: { absent: MANAGED_NO_PARTIALS_ABSENCE } },
  });
  assert.throws(
    () => parseScoreboardArtifact(cascadePartials, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.screenToFirstPartialMs" &&
      /no partials/.test(error.message),
    "the cascade has partials; claiming none is a fake N/A",
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

// ── One runner, one reader (ticket 113, M12/M13) ────────────────────────────

/** The measured rows each engine's writer derives; the structural N/As are added by the writer. */
const ENGINE_LATENCY: Record<ArtifactPipeline, ArtifactLatency> = {
  managed: {
    screenToFirstPartialMs: { absent: MANAGED_NO_PARTIALS_ABSENCE },
    speechCompleteToFirstTokenMs: { absent: MANAGED_NO_TOKEN_STREAM_ABSENCE },
    replyGapP50Ms: 900,
    replyGapP95Ms: 900,
  },
  cascade: {
    screenToFirstPartialMs: 180,
    speechCompleteToFirstTokenMs: 240,
    replyGapP50Ms: 510,
  },
};

/** Build one engine's artifact through the one artifact builder, not a fixture. */
function engineArtifact(pipeline: ArtifactPipeline, runId: string): unknown {
  return buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "",
    exitCode: 0,
    durationMs: 0,
    runs: 1,
    dryRun: true,
    runId,
    engine: {
      pipeline,
      run: {
        runId,
        variant: pipeline,
        startedAt: "2026-10-29T10:00:00.000Z",
        finishedAt: "2026-10-29T10:00:03.000Z",
      },
      captures:
        pipeline === "cascade"
          ? {
              reference: capture("reference"),
              platform: { absent: CASCADE_PLATFORM_CAPTURE_ABSENCE },
              delivered: capture("delivered"),
            }
          : {
              reference: capture("reference"),
              platform: capture("platform"),
              delivered: capture("delivered"),
            },
      eligibility: { eligible: true },
      latency: ENGINE_LATENCY[pipeline],
      providers:
        pipeline === "cascade"
          ? { stt: "assemblyai-meta", llm: "meta-llama-3.3", tts: "meta-speech" }
          : undefined,
      cost:
        pipeline === "cascade"
          ? {
              currency: "USD",
              rateTableVersion: "rates-2026-10-29",
              legs: { stt: 0.0031, llm: 0.0024, tts: 0.0045 },
              total: 0.01,
            }
          : undefined,
    },
  });
}

test("one writer and one reader: a managed and a cascade artifact round-trip through the same entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-reader-"));
  const read: Partial<Record<ArtifactPipeline, ReturnType<typeof buildInspectReport>>> = {};

  for (const pipeline of ["managed", "cascade"] as const) {
    const runId = `run-${pipeline}-1`;
    const path = join(dir, `${pipeline}.json`);
    // The one writer the runner calls, and the one reader the CLI calls.
    writeScoreboardArtifactFile(path, engineArtifact(pipeline, runId) as never);
    const artifact = readScoreboardArtifactFile(path);

    assert.equal(pipelineOfArtifact(artifact), pipeline);
    assert.equal(artifact.runId, runId);
    assert.deepEqual(artifactSectionGaps(artifact), [], `${pipeline} carries every section of the one shape`);
    assert.deepEqual(artifact.latency, {
      ...ENGINE_LATENCY[pipeline],
      ...(pipeline === "cascade"
        ? {
            replyGapP95Ms: { absent: ONE_CALL_NO_P95_ABSENCE },
            commitToFirstPlayoutMs: { absent: CASCADE_NO_COMMIT_MARK_ABSENCE },
          }
        : { commitToFirstPlayoutMs: { absent: MANAGED_NO_COMMIT_MARK_ABSENCE } }),
    });
    read[pipeline] = buildInspectReport(artifact);
  }

  const managed = read.managed!;
  const cascade = read.cascade!;
  assert.equal(managed.gaps.pipeline, "managed");
  assert.equal(cascade.gaps.pipeline, "cascade");
  assert.deepEqual(
    managed.gaps.rows.map((row) => row.row),
    cascade.gaps.rows.map((row) => row.row),
    "both engines print the same comparable gap rows",
  );
  assert.deepEqual(
    managed.gaps.rows.map((row) => row.label),
    cascade.gaps.rows.map((row) => row.label),
  );

  const row = (report: typeof managed, name: string) => report.gaps.rows.find((entry) => entry.row === name)!;
  assert.equal(row(managed, "screenToFirstPartialMs").absent, MANAGED_NO_PARTIALS_ABSENCE);
  assert.equal(row(cascade, "screenToFirstPartialMs").ms, 180);
  assert.equal(row(managed, "speechCompleteToFirstTokenMs").absent, MANAGED_NO_TOKEN_STREAM_ABSENCE);
  assert.equal(row(cascade, "speechCompleteToFirstTokenMs").ms, 240);
  assert.equal(row(managed, "replyGapP50Ms").ms, 900);
  assert.equal(row(cascade, "replyGapP50Ms").ms, 510);
  assert.equal(row(managed, "commitToFirstPlayoutMs").absent, "N/A — no commit mark on the managed artifact");
  assert.equal(row(cascade, "commitToFirstPlayoutMs").absent, CASCADE_NO_COMMIT_MARK_ABSENCE);
});

// ── Three cascade gaps from marks alone, and an honest N/A (ticket 114) ─────

/** Ledger marks in the ledger's own seconds, as `TimingLedger.summary()` writes them. */
const CASCADE_MARKS = {
  audio_in: 10,
  first_partial: 10.18,
  speech_complete: 10.6,
  first_token: 10.84,
  first_playout: 11.11,
};

/** The measured rows plus the two named N/As every cascade artifact carries. */
const CASCADE_LATENCY = {
  ...ENGINE_LATENCY.cascade,
  replyGapP95Ms: { absent: ONE_CALL_NO_P95_ABSENCE },
  commitToFirstPlayoutMs: { absent: CASCADE_NO_COMMIT_MARK_ABSENCE },
};

test("the three cascade gaps are computed from the ledger marks alone", () => {
  assert.deepEqual(cascadeLatencyFromMarks(CASCADE_MARKS), {
    screenToFirstPartialMs: 180,
    speechCompleteToFirstTokenMs: 240,
    replyGapP50Ms: 510,
  });
  assert.deepEqual(
    CASCADE_GAP_ROWS.map((row) => row.row),
    ["screenToFirstPartialMs", "speechCompleteToFirstTokenMs", "replyGapP50Ms"],
  );
});

test("a missing mark is a named N/A, never another row's number", () => {
  // `final` is present and `first_playout` is present: a fallback to the
  // managed anchor would yield a plausible reply gap. The cascade must not.
  const rows = cascadeLatencyFromMarks({
    audio_in: 0,
    final: 0.5,
    first_token: 0.8,
    first_playout: 1.2,
  });
  const absentOf = (value: unknown) =>
    value !== null && typeof value === "object" && "absent" in value
      ? (value as { absent: string }).absent
      : "";
  assert.match(absentOf(rows.screenToFirstPartialMs), /first_partial/);
  assert.match(absentOf(rows.speechCompleteToFirstTokenMs), /speech_complete/);
  assert.match(absentOf(rows.replyGapP50Ms), /speech_complete/);
  assert.match(absentOf(rows.replyGapP50Ms), /never "final"/);
});

test("the greeting and a cut are excluded from every cascade gap", () => {
  const withGreeting = cascadeLatencyFromMarks({
    ...CASCADE_MARKS,
    greeting_start: 0,
    greeting_first_audio: 0.05,
    greeting_done: 9.5,
    cancelled: 11.5,
  });
  assert.deepEqual(withGreeting, cascadeLatencyFromMarks(CASCADE_MARKS));
});

test("the reader refuses a reply gap borrowed from the final mark", () => {
  const raw = cascadeArtifact({
    ledger: { marks: { audio_in: 0, first_partial: 0.2, final: 0.5, first_token: 0.8, first_playout: 1.2 } },
    latency: {
      screenToFirstPartialMs: 200,
      // The think row already states the missing mark; the reply row is the
      // one that must never be silently filled from `final`.
      speechCompleteToFirstTokenMs: { absent: "N/A — no speech_complete mark" },
      replyGapP50Ms: 700,
      replyGapP95Ms: { absent: ONE_CALL_NO_P95_ABSENCE },
      commitToFirstPlayoutMs: { absent: CASCADE_NO_COMMIT_MARK_ABSENCE },
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(raw, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.replyGapP50Ms" &&
      /speech_complete/.test(error.message),
    "the row is derived from the ledger marks, never borrowed from another mark",
  );
});

test("the reader refuses a measured row where the ledger has no anchor mark", () => {
  const withoutComplete = { ...CASCADE_MARKS };
  delete (withoutComplete as { speech_complete?: number }).speech_complete;
  const raw = cascadeArtifact({
    ledger: { marks: withoutComplete },
    latency: CASCADE_LATENCY,
  });
  assert.throws(
    () => parseScoreboardArtifact(raw, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.speechCompleteToFirstTokenMs" &&
      /speech_complete/.test(error.message),
  );
});

test("a copied reply gap in the commit row is refused on the cascade", () => {
  const raw = cascadeArtifact({
    ledger: { marks: CASCADE_MARKS },
    latency: {
      screenToFirstPartialMs: 180,
      speechCompleteToFirstTokenMs: 240,
      replyGapP50Ms: 510,
      replyGapP95Ms: { absent: ONE_CALL_NO_P95_ABSENCE },
      commitToFirstPlayoutMs: 510,
    },
  });
  assert.throws(
    () => parseScoreboardArtifact(raw, "cascade.json"),
    (error: unknown) =>
      error instanceof ArtifactReadError &&
      error.field === "latency.commitToFirstPlayoutMs" &&
      /N\/A/.test(error.message),
    "the commit mark does not exist on the cascade; its row is N/A, not the reply gap",
  );
});

test("a cascade artifact whose rows agree with its ledger marks is accepted", () => {
  const raw = cascadeArtifact({
    ledger: { marks: CASCADE_MARKS },
    latency: CASCADE_LATENCY,
  });
  const parsed = parseScoreboardArtifact(raw, "cascade.json");
  assert.deepEqual(parsed.ledger?.marks, CASCADE_MARKS);
  assert.equal(parsed.latency?.replyGapP50Ms, 510);
});

test("the one writer refuses an invalid capture combination before writing", () => {
  const run = {
    runId: "run-write",
    variant: "managed",
    startedAt: "2026-10-29T10:00:00.000Z",
    finishedAt: "2026-10-29T10:00:03.000Z",
  };
  assert.throws(
    () =>
      buildArtifactShape({
        pipeline: "cascade",
        run,
        captures: { reference: capture("reference"), platform: capture("platform"), delivered: capture("delivered") },
        eligibility: { eligible: true },
      }),
    /platform capture/,
    "a cascade artifact cannot claim a platform capture",
  );
  assert.throws(
    () =>
      buildArtifactShape({
        pipeline: "managed",
        run,
        captures: { reference: capture("reference"), delivered: capture("delivered") },
        eligibility: { eligible: true },
      }),
    /platform capture/,
    "a managed artifact records all three legs",
  );
});

test("the scoreboard scripts read artifacts only through the one reader", () => {
  for (const file of ["score-demo.mts", "scoreboard-inspect.mts", "score-matrix.mts", "score-streak.mts"]) {
    const source = readFileSync(new URL(`../../../scripts/${file}`, import.meta.url), "utf8");
    assert.match(source, /artifact-reader/, `${file} must read through the shared artifact reader`);
  }
});
