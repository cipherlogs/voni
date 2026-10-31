import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BODY_SOURCES,
  BODY_SOURCE_CLAIMS,
  bodySourceClaim,
  bodySourceForPipeline,
} from "./body-source";
import { buildSkeletonArtifact, DEFAULT_GATE_VOICE } from "./scoreboard";
import { buildInspectReport, formatInspectReport } from "./scoreboard-report";
import {
  READINESS_EVIDENCE_BODY_SOURCE,
  formatReadinessPack,
  type ReadinessPack,
} from "./readiness-pack";
import { parseScoreboardArtifact } from "./artifact-reader";

function readRepoFile(relative: string): string {
  return readFileSync(new URL(`../../../../${relative}`, import.meta.url), "utf8");
}

function artifact() {
  return buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "stop-over",
    runnerStdout: "  ✓ stop-over #1\n",
    exitCode: 0,
    durationMs: 1000,
    runs: 1,
    dryRun: true,
    runId: "run-body-source",
  });
}

function cascadeArtifact() {
  const runId = "run-cascade-body-source";
  return buildSkeletonArtifact({
    voice: DEFAULT_GATE_VOICE,
    scenario: "cascade",
    runnerStdout: "cascade call ledger.json\n",
    exitCode: null,
    durationMs: 0,
    runs: 1,
    dryRun: true,
    runId,
    engine: {
      pipeline: "cascade",
      run: {
        runId,
        variant: "cascade",
        startedAt: "2026-10-30T10:00:00.000Z",
        finishedAt: "2026-10-30T10:01:00.000Z",
      },
      captures: {
        reference: { path: "reference.wav", sha256: "a".repeat(64) },
        platform: { absent: "a cascade run has no platform capture" },
        delivered: { path: "delivered.wav", sha256: "b".repeat(64) },
      },
      eligibility: { eligible: true },
    },
  });
}

test("the two body sources are named, and an absent pipeline reads as managed", () => {
  assert.deepEqual([...BODY_SOURCES], ["cascade", "managed"]);
  assert.equal(bodySourceForPipeline("cascade"), "cascade");
  assert.equal(bodySourceForPipeline("managed"), "managed");
  // An artifact written before the pipeline discriminator played a managed run.
  assert.equal(bodySourceForPipeline(undefined), "managed");
});

test("the managed body read is labelled managed-only, never as cascade evidence", () => {
  assert.match(BODY_SOURCE_CLAIMS.managed, /managed-only/i);
  assert.match(BODY_SOURCE_CLAIMS.managed, /never describes a cascade run/i);
  assert.match(BODY_SOURCE_CLAIMS.cascade, /cascade/i);
  // Each claim names the body it reads: platform stored agent vs app-signed body.
  assert.match(BODY_SOURCE_CLAIMS.managed, /platform-served stored-agent body/i);
  assert.match(BODY_SOURCE_CLAIMS.cascade, /app-signed demo body/i);
  assert.equal(bodySourceClaim("cascade"), BODY_SOURCE_CLAIMS.cascade);
  assert.equal(bodySourceClaim(undefined), BODY_SOURCE_CLAIMS.managed);
});

test("the inspect report prints which body its claims come from", () => {
  const managed = buildInspectReport(artifact());
  assert.equal(managed.body.source, "managed");
  assert.ok(
    formatInspectReport(managed).includes(BODY_SOURCE_CLAIMS.managed),
    "the managed inspect report must carry the managed body-source claim",
  );

  const cascade = buildInspectReport({
    ...artifact(),
    pipeline: "cascade",
    bodySource: "cascade",
  });
  assert.equal(cascade.body.source, "cascade");
  assert.ok(
    formatInspectReport(cascade).includes(BODY_SOURCE_CLAIMS.cascade),
    "the cascade inspect report must carry the cascade body-source claim",
  );
});

test("every artifact records the body its claims come from", () => {
  assert.equal(artifact().bodySource, "managed");
  const cascade = cascadeArtifact();
  assert.equal(cascade.bodySource, "cascade");
  assert.equal(buildInspectReport(cascade).body.source, "cascade");
});

test("an artifact cannot label its body as the other engine's", () => {
  const mislabelled = { ...cascadeArtifact(), bodySource: "managed" };
  assert.throws(
    () => parseScoreboardArtifact(mislabelled, "artifact.json"),
    /bodySource|body source/i,
    "a cascade artifact claiming the managed body must be refused, not read",
  );
  assert.throws(
    () => parseScoreboardArtifact({ ...artifact(), bodySource: "stored" }, "artifact.json"),
    /bodySource/i,
    "an unknown body source is refused by name, never defaulted",
  );
});

test("the readiness pack states that its evidence is cascade-only", () => {
  assert.equal(READINESS_EVIDENCE_BODY_SOURCE, "cascade");
  const pack: ReadinessPack = {
    schemaVersion: 1,
    kind: "all-subject-readiness-pack",
    status: "blocked",
    ready: false,
    recordedAt: "2026-10-30T00:00:00.000Z",
    evidenceBody: READINESS_EVIDENCE_BODY_SOURCE,
    required: { demoVoices: ["audrey"], tenants: [] },
    rule: "rule",
    subjects: [],
    blockers: ["audrey: nothing measured"],
  };
  const markdown = formatReadinessPack(pack);
  assert.ok(
    markdown.includes(BODY_SOURCE_CLAIMS.cascade),
    "the readiness pack must name the body its claims come from",
  );
  assert.match(markdown, /managed artifact/i);
});

test("the scoreboard doc quotes both body-source claims verbatim", () => {
  const doc = readRepoFile("docs/agents/demo-scoreboard.md");
  for (const source of BODY_SOURCES) {
    assert.ok(
      doc.includes(BODY_SOURCE_CLAIMS[source]),
      `docs/agents/demo-scoreboard.md must quote the ${source} claim verbatim; ` +
        "a claim that loses its source label must fail a test",
    );
  }
});

test("the pipeline README describes the shipped cascade, not the gateway/Cartesia slice", () => {
  const readme = readRepoFile("voice-pipeline/README.md");
  for (const shipped of [
    "Meta", // Meta STT
    "Muse Spark", // the Standard LLM rung
    "AssemblyAI", // the TTS leg
    "/v1/call-body", // the signed call-body channel
    "VOICE_PIPELINE_ENVELOPE_SECRET",
    "routing=demo",
  ]) {
    assert.ok(readme.includes(shipped), `voice-pipeline/README.md must name ${shipped}`);
  }
  for (const voice of ["audrey", "malvina", "donatien", "jorg", "benicio"]) {
    assert.ok(readme.includes(voice), `voice-pipeline/README.md must name the demo voice ${voice}`);
  }
  for (const stale of [
    "CARTESIA_API_KEY",
    "smoke_call.py",
    "gateway key funds the LLM leg",
    "P1 talking slice",
    "AssemblyAI STT, gateway LLM, Cartesia TTS",
  ]) {
    assert.ok(
      !readme.includes(stale),
      `voice-pipeline/README.md still describes the replaced slice (${stale}); ` +
        "remove it or label it historical",
    );
  }
});
