import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Contract, ContractPropertyEntry } from "../contract";
import { loadContract } from "../contract";
import { RUN_SCENARIO } from "../economics";
import { LOCALES, type Locale } from "../scenarios";
import {
  judgeRun,
  type PropertyEvidence,
  type PropertyMeasurement,
  type RunVerdict,
} from "../verdict";
import {
  CERTIFICATE_SCHEMA_VERSION,
  CERTIFICATE_TARGETS,
  CertificateError,
  ENGLISH_ONLY_SCOPE,
  FULL_SCOPE,
  OPEN_RESIDUAL_RISK_IDS,
  RESIDUAL_RISKS,
  buildCertificate,
  certificateExitCode,
  certificateFile,
  certificateFileName,
  parseCertificate,
  renderCertificate,
  serializeCertificate,
  validateCertificate,
  type Certificate,
  type CertificateBuildInput,
  type CertificationScope,
  type PanelSignature,
  type VendorBuild,
} from "./index";

/**
 * Ticket 08's acceptance: one certificate per run, bound to target, code,
 * corpus and vendor builds; explicit coverage gaps; per-property verdicts with
 * citations; the four verdicts; and a named refusal for every way the claim can
 * outrun the evidence.
 */

const FINGERPRINT = {
  head: "a".repeat(40),
  dirty: false,
  dirtyHash: "b".repeat(64),
};

const CORPUS_HASH = "c".repeat(64);

const PANEL: PanelSignature = {
  sessionId: "panel-2026-10-31",
  reviewer: "owner",
  signedAt: "2026-10-31",
  signature: "panel-attestation-1",
};

const VENDOR_BUILDS: readonly VendorBuild[] = [
  { leg: "stt", vendor: "assemblyai", model: "best", buildId: "stt-build-1" },
  { leg: "tts", vendor: "cartesia", model: "sonic", buildId: "tts-build-1" },
  { leg: "llm", vendor: "openai", model: "fast-model", buildId: "llm-build-1" },
];

const T1: ContractPropertyEntry = {
  id: "T1",
  family: "turn-taking",
  statement: "First response follows the caller's turn end",
  bar: { text: "p50 <= 350 ms", numeric: true },
  evidence: "ledger",
  kind: "timing",
  repetitions: 3,
  thresholds: [{ source: "budget-record", key: "p50", value: 350, unit: "ms" }],
};

const C9: ContractPropertyEntry = {
  id: "C9",
  family: "conduct",
  statement: "Answers honestly when asked whether it is an AI",
  bar: { text: "pass", numeric: false },
  evidence: "ledger",
  kind: "behaviour",
  repetitions: 3,
  thresholds: [],
};

const CONTRACT: Contract = {
  families: [
    { id: "turn-taking", title: "Turn taking", propertyCount: 1 },
    { id: "conduct", title: "Conduct", propertyCount: 1 },
  ],
  properties: [T1, C9],
};

const SCENARIOS = LOCALES.map((locale) => ({
  name: `hello-${locale}`,
  locale,
  heldOut: false,
  class: "golden-flow" as const,
}));

/** Only what an English-only run plans: one English scenario per repetition. */
const ENGLISH_SCENARIOS = SCENARIOS.filter((scenario) => scenario.locale === "en");

function attempts(
  filter: (locale: Locale) => boolean = () => true,
  scenarios: typeof SCENARIOS = SCENARIOS,
): NonNullable<CertificateBuildInput["attempts"]> {
  return scenarios.filter((scenario) => filter(scenario.locale)).flatMap((scenario) =>
    [1, 2, 3].map((repetition) => ({
      scenario: scenario.name,
      locale: scenario.locale,
      repetition,
      callId: `call-${scenario.name}-${repetition}`,
    })),
  );
}

function englishOnlyInput(overrides: Partial<CertificateBuildInput> = {}): CertificateBuildInput {
  return buildInput({
    run: runWith({ scenarios: ENGLISH_SCENARIOS }),
    scope: ENGLISH_ONLY_SCOPE,
    corpus: { version: 1, fingerprint: CORPUS_HASH, scenarios: ENGLISH_SCENARIOS },
    attempts: attempts(() => true, ENGLISH_SCENARIOS),
    ...overrides,
  });
}

function evidence(
  failing?: { scenario: string; repetition: number },
  scenarios: typeof SCENARIOS = SCENARIOS,
): PropertyEvidence[] {
  const numeric: PropertyMeasurement[] = [];
  const categorical: PropertyMeasurement[] = [];
  for (const scenario of scenarios) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const failed =
        failing?.scenario === scenario.name && failing.repetition === repetition;
      const citation = `call:${scenario.name}#${repetition}`;
      numeric.push({
        propertyId: "T1",
        scenario: scenario.name,
        repetition,
        locale: scenario.locale,
        outcome: "measured",
        samples: [failed ? 9_999 : 100 + repetition],
        citations: [citation],
      });
      categorical.push({
        propertyId: "C9",
        scenario: scenario.name,
        repetition,
        locale: scenario.locale,
        outcome: "measured",
        samples: [],
        passed: !failed,
        citations: [citation],
      });
    }
  }
  return [
    {
      propertyId: "T1",
      bars: [{ key: "p50", statistic: "p50", comparison: "at-most" }],
      measurements: numeric,
    },
    { propertyId: "C9", bars: [], measurements: categorical },
  ];
}

function runWith(overrides: {
  failing?: { scenario: string; repetition: number };
  calls?: Parameters<typeof judgeRun>[0]["calls"];
  evidence?: PropertyEvidence[];
  scenarios?: typeof SCENARIOS;
} = {}): RunVerdict {
  return judgeRun({
    runId: "run-2026-10-31-01",
    contract: CONTRACT,
    evidence:
      overrides.evidence ?? evidence(overrides.failing, overrides.scenarios ?? SCENARIOS),
    calls: overrides.calls ?? [],
  });
}

function buildInput(overrides: Partial<CertificateBuildInput> = {}): CertificateBuildInput {
  return {
    contract: CONTRACT,
    run: runWith(),
    target: "local",
    scope: FULL_SCOPE,
    plan: { mode: "full", repetitions: 3 },
    corpus: { version: 1, fingerprint: CORPUS_HASH, scenarios: SCENARIOS },
    attempts: attempts(),
    codeFingerprint: FINGERPRINT,
    appBuild: "app-build-1",
    pipelineImage: `sha256:${"d".repeat(64)}`,
    vendorBuilds: VENDOR_BUILDS,
    cost: { usd: 1.25, callCount: 15 },
    residualRiskIds: [...OPEN_RESIDUAL_RISK_IDS],
    panel: PANEL,
    ...overrides,
  };
}

function certified(): Certificate {
  return buildCertificate(buildInput());
}

type Mutable = Record<string, unknown>;

function mutable(certificate: Certificate): Mutable {
  return JSON.parse(JSON.stringify(certificate)) as Mutable;
}

function assertRefusal(run: () => unknown, code: string, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(
      error instanceof CertificateError,
      `expected CertificateError, got ${String(error)}`,
    );
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.equal(error.exitCode, 2, "a refusal is exit 2, never a skip");
    return true;
  });
}

test("a complete run builds one certificate with code, target, corpus, vendors, coverage and cited verdicts", () => {
  const certificate = certified();

  assert.equal(certificate.schemaVersion, CERTIFICATE_SCHEMA_VERSION);
  assert.equal(certificate.runId, "run-2026-10-31-01");
  assert.equal(certificate.target, "local");
  assert.deepEqual(certificate.scope, FULL_SCOPE);
  assert.deepEqual(certificate.code.fingerprint, FINGERPRINT);
  assert.equal(certificate.code.appBuild, "app-build-1");
  assert.equal(certificate.code.pipelineImage, `sha256:${"d".repeat(64)}`);
  assert.deepEqual(certificate.corpus, {
    version: 1,
    sha256: CORPUS_HASH,
    scenarios: SCENARIOS,
  });
  assert.deepEqual(certificate.vendorBuilds, VENDOR_BUILDS);
  assert.deepEqual(certificate.plan, { mode: "full", repetitions: 3 });
  assert.equal(certificate.coverage.expectedScenarios, 5);
  assert.equal(certificate.coverage.gapRows, 0);
  assert.equal(certificate.coverage.rows.length, 5);
  assert.equal(certificate.coverage.byLocale.length, LOCALES.length);
  assert.ok(certificate.coverage.byLocale.every((row) => row.status === "measured"));
  assert.ok(certificate.coverage.rows.every((row) => row.class === "golden-flow"));

  assert.equal(certificate.properties.length, 2);
  for (const property of certificate.properties) {
    assert.equal(property.status, "PASS");
    assert.ok(property.citations.length > 0, `${property.propertyId} cites its evidence`);
    assert.equal(property.sampleCount, 15);
  }
  assert.equal(certificate.eligibility.eligible, true);
  assert.deepEqual(certificate.runFailures, []);
  assert.deepEqual(certificate.cost, { usd: 1.25, callCount: 15 });
  assert.deepEqual(certificate.residualRiskIds, [...OPEN_RESIDUAL_RISK_IDS]);
  assert.deepEqual(certificate.panel, PANEL);

  assert.equal(certificate.verdict, "certified");
  assert.equal(certificate.pass, true);
  assert.equal(certificateExitCode(certificate.verdict), 0);
});

test("a certificate round-trips through committed JSON without losing a field", () => {
  const certificate = certified();
  const document = serializeCertificate(certificate);
  assert.ok(document.endsWith("\n"), "a committed file ends with a newline");
  const parsed = parseCertificate(document, {
    target: certificate.target,
    runId: certificate.runId,
    codeFingerprint: FINGERPRINT,
    corpus: { version: 1, sha256: CORPUS_HASH },
  });
  assert.deepEqual(parsed, certificate);
});

test("a certificate for one target can never be read as a certificate for another", () => {
  const staging = buildCertificate(buildInput({ target: "staging" }));
  assert.equal(staging.target, "staging");
  assert.doesNotThrow(() => validateCertificate(staging, { target: "staging" }));
  assertRefusal(
    () => validateCertificate(staging, { target: "production" }),
    "target-mismatch",
    /true for target "staging", not "production"/,
  );
  assert.deepEqual([...CERTIFICATE_TARGETS], ["local", "staging", "production"]);
});

test("a certificate whose code fingerprint or corpus hash differs from the run is refused by name", () => {
  const certificate = certified();
  assertRefusal(
    () =>
      validateCertificate(certificate, {
        codeFingerprint: { ...FINGERPRINT, head: "e".repeat(40) },
      }),
    "code-fingerprint-mismatch",
    /does not match the run/,
  );
  assertRefusal(
    () =>
      validateCertificate(certificate, {
        corpus: { version: 1, sha256: "f".repeat(64) },
      }),
    "corpus-hash-mismatch",
    /pins corpus/,
  );
  assertRefusal(
    () => validateCertificate(certificate, { runId: "run-other" }),
    "run-id-mismatch",
    /names run/,
  );
});

test("coverage gaps are explicit rows for every unrun scenario and Locale, never omissions", () => {
  const englishOnly = buildCertificate(
    buildInput({
      attempts: attempts((locale) => locale === "en"),
    }),
  );

  assert.equal(englishOnly.coverage.rows.length, 5, "one row per corpus scenario");
  assert.equal(englishOnly.coverage.gapRows, 4);
  const gaps = englishOnly.coverage.rows.filter((row) => row.status === "gap");
  assert.deepEqual(
    gaps.map((row) => row.locale),
    ["es", "fr", "de", "pt"],
  );
  for (const row of gaps) {
    assert.equal(row.measuredRepetitions, 0);
    assert.match(row.gap ?? "", /not run in this certification/);
  }
  const spanish = englishOnly.coverage.byLocale.find((row) => row.locale === "es");
  assert.equal(spanish?.status, "gap");
  assert.equal(spanish?.gap, "1 of 1 scenarios not measured");
  assert.equal(englishOnly.verdict, "not-demo-ready");
  assert.equal(englishOnly.pass, false);
  assert.equal(certificateExitCode(englishOnly.verdict), 1);
  assert.match(renderCertificate(englishOnly), /GAP es hello-es: not run/);

  const omitted = mutable(englishOnly);
  (omitted.coverage as Mutable).rows = (
    (omitted.coverage as Mutable).rows as unknown[]
  ).slice(0, 4);
  assertRefusal(
    () => validateCertificate(omitted),
    "coverage-row-missing",
    /a missing scenario is a gap row/,
  );
});

test("a verdict without citations is refused, from the builder and from a committed document", () => {
  const certificate = certified();
  const copy = mutable(certificate);
  const properties = copy.properties as Mutable[];
  properties[0].citations = [];
  assertRefusal(
    () => validateCertificate(copy),
    "verdict-without-citations",
    /T1/,
  );

  const run = runWith();
  const uncited: RunVerdict = {
    ...run,
    properties: run.properties.map((property) =>
      property.propertyId === "T1" ? { ...property, citations: [] } : property,
    ),
  };
  assertRefusal(
    () => buildCertificate(buildInput({ run: uncited })),
    "verdict-without-citations",
    /T1 is "PASS" .* with no citation/,
  );

  const failedRun = runWith({ failing: { scenario: "hello-en", repetition: 2 } });
  const uncitedFailure: RunVerdict = {
    ...failedRun,
    properties: failedRun.properties.map((property) =>
      property.propertyId === "C9" ? { ...property, citations: [] } : property,
    ),
  };
  assertRefusal(
    () => buildCertificate(buildInput({ run: uncitedFailure })),
    "verdict-without-citations",
    /C9 is "FAIL" \(below-bar\) with no citation/,
  );
});

test("an unsigned clean run is pending-human; a certified verdict without a panel signature is refused by name", () => {
  const unsigned = buildCertificate(buildInput({ panel: null }));
  assert.equal(unsigned.verdict, "pending-human");
  assert.equal(unsigned.pass, false);
  assert.equal(unsigned.panel, null);
  assert.equal(certificateExitCode(unsigned.verdict), 3);
  assert.doesNotThrow(() => validateCertificate(unsigned));

  const forged = mutable(unsigned);
  forged.verdict = "certified";
  forged.pass = true;
  assertRefusal(
    () => validateCertificate(forged),
    "missing-panel-signature",
    /unsigned certificate is pending-human, never certified/,
  );
});

test("an unknown schema version is refused by name, not reinterpreted", () => {
  assert.equal(CERTIFICATE_SCHEMA_VERSION, 3);
  const copy = mutable(certified());
  copy.schemaVersion = CERTIFICATE_SCHEMA_VERSION + 1;
  assertRefusal(
    () => validateCertificate(copy),
    "unknown-schema-version",
    /schema version 4 is unknown/,
  );
});

test("a v1 or v2 certificate stays readable; a v3 certificate must carry scope and resume", () => {
  const v1 = mutable(certified());
  v1.schemaVersion = 1;
  delete v1.resume;
  delete v1.scope;
  delete (v1.corpus as Mutable).scenarios;
  for (const row of (v1.coverage as Mutable).rows as Mutable[]) delete row.class;
  const parsedV1 = validateCertificate(v1);
  assert.equal(parsedV1.resume, null, "a v1 certificate predates the resume record");
  assert.equal(parsedV1.scope, null, "a v1 certificate predates the declared scope");
  assert.equal(parsedV1.schemaVersion, 1, "a v1 document is read and kept as v1");

  const v2 = mutable(certified());
  v2.schemaVersion = 2;
  delete v2.scope;
  delete (v2.corpus as Mutable).scenarios;
  for (const row of (v2.coverage as Mutable).rows as Mutable[]) delete row.class;
  const parsedV2 = validateCertificate(v2);
  assert.equal(parsedV2.scope, null, "a v2 certificate declared no scope; every Locale is required");
  assert.equal(parsedV2.resume, null);
  assert.equal(parsedV2.coverage.rows[0]?.class, null, "a v2 row predates the class field");

  const missingResume = mutable(certified());
  delete missingResume.resume;
  assertRefusal(
    () => validateCertificate(missingResume),
    "malformed-certificate",
    /resume/,
  );
});

test("a v3 certificate without a declared scope is refused by name", () => {
  const missingScope = mutable(certified());
  delete missingScope.scope;
  assertRefusal(
    () => validateCertificate(missingScope),
    "missing-scope",
    /must carry scope/,
  );
});

test("an English-only scope certifies when every in-scope scenario passes and names the other Locales out of scope", () => {
  const certificate = buildCertificate(englishOnlyInput());

  assert.equal(certificate.verdict, "certified");
  assert.equal(certificate.pass, true);
  assert.equal(certificate.scope?.locales.join(","), "en");
  assert.equal(certificate.coverage.expectedScenarios, 1);
  assert.equal(certificate.coverage.gapRows, 0);
  assert.equal(certificate.coverage.byLocale.find((row) => row.locale === "en")?.status, "measured");

  for (const locale of ["es", "fr", "de", "pt"] as const) {
    const row = certificate.coverage.byLocale.find((entry) => entry.locale === locale);
    assert.ok(row, `${locale} is present, never silently absent`);
    assert.equal(row.status, "out-of-scope");
    assert.equal(row.gap, null);
    assert.equal(row.expectedScenarios, 0);
    assert.equal(row.decision?.decidedBy, "owner");
    assert.equal(row.decision?.decidedOn, "2026-11-02");
    assert.match(row.decision?.reason ?? "", /English-only/);
  }

  const text = renderCertificate(certificate);
  assert.match(text, /scope en \(owner 2026-11-02/);
  assert.match(text, /OUT OF SCOPE es, fr, de, pt/);
  assert.match(text, /es OUT-OF-SCOPE/);
});

test("an English failure still makes a scoped certificate not-demo-ready", () => {
  const failing = buildCertificate(
    englishOnlyInput({
      run: runWith({
        scenarios: ENGLISH_SCENARIOS,
        failing: { scenario: "hello-en", repetition: 2 },
      }),
    }),
  );
  assert.equal(failing.verdict, "not-demo-ready");
  assert.equal(failing.pass, false);
  assert.equal(failing.coverage.gapRows, 0, "the four other Locales are not the reason");
  assert.ok(
    failing.properties.some((property) => property.status === "FAIL"),
    "the English failure is still the failing fact",
  );

  const gap = buildCertificate(
    englishOnlyInput({
      attempts: attempts((locale) => locale === "en", ENGLISH_SCENARIOS).filter(
        (attempt) => !(attempt.scenario === "hello-en" && attempt.repetition === 3),
      ),
    }),
  );
  assert.equal(gap.verdict, "not-demo-ready", "an unmeasured English repetition fails closed");
  assert.equal(gap.coverage.gapRows, 1);
});

test("out of scope cannot cover a Locale that ran, and a measured Locale cannot be a gap by choice", () => {
  // The scope excludes es but the corpus (and the attempts) still hold it.
  assertRefusal(
    () => buildCertificate(englishOnlyInput({ corpus: buildInput().corpus })),
    "scope-violation",
    /Locale "es".*declared scope/,
  );
  assertRefusal(
    () => buildCertificate(englishOnlyInput({ attempts: attempts() })),
    "scope-violation",
    /ran Locale "es"/,
  );

  // A forged row: es out of scope while carrying a measured scenario.
  const forged = mutable(buildCertificate(englishOnlyInput()));
  const es = (forged.coverage as Mutable).byLocale as Mutable[];
  const spanish = es.find((row) => row.locale === "es")!;
  spanish.expectedScenarios = 1;
  assertRefusal(
    () => validateCertificate(forged),
    "scope-violation",
    /is out of scope but records/,
  );
});

test("an out-of-scope row carries the certificate's own decision and no invented one", () => {
  const forged = mutable(buildCertificate(englishOnlyInput()));
  const spanish = ((forged.coverage as Mutable).byLocale as Mutable[]).find(
    (row) => row.locale === "es",
  )!;
  (spanish.decision as Mutable).reason = "we skipped Spanish";
  assertRefusal(
    () => validateCertificate(forged),
    "invalid-scope",
    /does not match the certificate's declared decision/,
  );
});

test("a declared Locale with no scenario and no calls is a gap, not out of scope", () => {
  const scope: CertificationScope = {
    ...ENGLISH_ONLY_SCOPE,
    locales: ["en", "es"],
  };
  const certificate = buildCertificate(
    englishOnlyInput({
      scope,
      corpus: { version: 1, fingerprint: CORPUS_HASH, scenarios: ENGLISH_SCENARIOS },
    }),
  );
  const spanish = certificate.coverage.byLocale.find((row) => row.locale === "es");
  assert.equal(spanish?.status, "gap");
  assert.match(spanish?.gap ?? "", /no scenario for this Locale/);
  assert.equal(certificate.verdict, "not-demo-ready", "an in-scope Locale is never neutral");
});

const MULTI_ENGLISH = [
  { name: "hello-en", locale: "en" as const, heldOut: false, class: "golden-flow" as const },
  { name: "barge-en", locale: "en" as const, heldOut: false, class: "turn-taking" as const },
  { name: "goodbye-en", locale: "en" as const, heldOut: false, class: "ending" as const },
];

function multiEnglishInput(overrides: Partial<CertificateBuildInput> = {}): CertificateBuildInput {
  return buildInput({
    run: runWith({ scenarios: MULTI_ENGLISH }),
    scope: ENGLISH_ONLY_SCOPE,
    corpus: { version: 1, fingerprint: CORPUS_HASH, scenarios: MULTI_ENGLISH },
    attempts: attempts(() => true, MULTI_ENGLISH),
    ...overrides,
  });
}

test("a dropped coverage row and a lowered expectedScenarios cannot hide a failure", () => {
  const forged = mutable(buildCertificate(multiEnglishInput()));
  const rows = (forged.coverage as Mutable).rows as Mutable[];
  rows.splice(
    rows.findIndex((row) => row.scenario === "barge-en"),
    1,
  );
  (forged.coverage as Mutable).expectedScenarios = rows.length;
  const english = ((forged.coverage as Mutable).byLocale as Mutable[]).find(
    (row) => row.locale === "en",
  )!;
  english.expectedScenarios = rows.length;
  english.measuredScenarios = rows.length;
  english.gapRows = 0;
  english.status = "measured";

  assertRefusal(
    () => validateCertificate(forged),
    "coverage-row-missing",
    /declared corpus|declared scenario|barge-en/,
  );
});

test("a scope narrowed after the fact cannot turn the other Locales' rows out of scope", () => {
  const forged = mutable(certified());
  forged.scope = ENGLISH_ONLY_SCOPE;
  const rows = (forged.coverage as Mutable).rows as Mutable[];
  (forged.coverage as Mutable).rows = rows.filter((row) => row.locale === "en");
  (forged.coverage as Mutable).expectedScenarios = 1;

  const decision = {
    decidedBy: ENGLISH_ONLY_SCOPE.decidedBy,
    decidedOn: ENGLISH_ONLY_SCOPE.decidedOn,
    reason: ENGLISH_ONLY_SCOPE.reason,
  };
  (forged.coverage as Mutable).byLocale = (
    (forged.coverage as Mutable).byLocale as Mutable[]
  ).map((row) =>
    row.locale === "en"
      ? row
      : {
          locale: row.locale,
          expectedScenarios: 0,
          measuredScenarios: 0,
          gapRows: 0,
          status: "out-of-scope",
          gap: null,
          decision,
        },
  );

  assertRefusal(
    () => validateCertificate(forged),
    "scope-violation",
    /declared corpus|declared scope|hello-es/,
  );
});

test("a forged scenario class cannot make the one-per-class sample vacuous", () => {
  const forged = mutable(buildCertificate(multiEnglishInput()));
  for (const row of (forged.coverage as Mutable).rows as Mutable[]) {
    row.class = "golden-flow";
  }
  assertRefusal(
    () => validateCertificate(forged),
    "invalid-coverage",
    /class|barge-en/,
  );
});

test("a reader that expects a Locale set refuses a certificate claiming another", () => {
  const certificate = certified();
  assertRefusal(
    () => validateCertificate(certificate, { scope: ["en"] }),
    "scope-mismatch",
    /scope|Locale/,
  );
});

test("a v1 or v2 certificate re-serializes as what it is, never as an invalid v3", () => {
  const legacy = mutable(certified());
  legacy.schemaVersion = 2;
  legacy.resume = null;
  delete legacy.scope;
  delete (legacy.corpus as Mutable).scenarios;
  for (const row of (legacy.coverage as Mutable).rows as Mutable[]) delete row.class;

  const parsed = validateCertificate(legacy);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.scope, null);
  const document = serializeCertificate(parsed);
  assert.match(document, /"schemaVersion": 2/);
  assert.deepEqual(parseCertificate(document), parsed);
});

test("every v3 coverage row names its scenario class", () => {
  const missing = mutable(certified());
  delete ((missing.coverage as Mutable).rows as Mutable[])[0]!.class;
  assertRefusal(() => validateCertificate(missing), "invalid-coverage", /class is missing/);

  const unknown = mutable(certified());
  ((unknown.coverage as Mutable).rows as Mutable[])[0]!.class = "not-a-class";
  assertRefusal(() => validateCertificate(unknown), "invalid-coverage", /not one of/);
});

test("a call id claimed by two attempts is refused, not deduped", () => {
  const duplicated = attempts().map((attempt, index) =>
    index === 1 ? { ...attempt, callId: attempts()[0]!.callId } : attempt,
  );
  assertRefusal(
    () => buildCertificate(buildInput({ attempts: duplicated })),
    "duplicate-call-id",
    /call id/,
  );
});

test("an ineligible run is never a pass, whatever its properties say", () => {
  const ineligible = buildCertificate(
    buildInput({
      run: runWith({
        calls: [
          {
            callId: "call-hello-en-1",
            scenario: "hello-en",
            providerFallback: "stt at connect",
          },
        ],
      }),
    }),
  );
  assert.equal(ineligible.verdict, "ineligible");
  assert.equal(ineligible.pass, false);
  assert.equal(ineligible.eligibility.eligible, false);
  assert.match(ineligible.eligibility.reasons[0] ?? "", /provider fallback/);
  assert.equal(certificateExitCode(ineligible.verdict), 1);
  assert.match(renderCertificate(ineligible), /INELIGIBLE call "call-hello-en-1"/);
});

test("a run-level structural failure keeps the certificate not-demo-ready", () => {
  const run = runWith({
    evidence: [
      ...evidence(),
      { propertyId: "ZZ9", bars: [], measurements: [] },
    ] as PropertyEvidence[],
  });
  const certificate = buildCertificate(buildInput({ run }));
  assert.equal(certificate.verdict, "not-demo-ready");
  assert.equal(certificate.runFailures.length, 1);
  assert.match(certificate.runFailures[0] ?? "", /unknown property "ZZ9"/);
  assert.match(renderCertificate(certificate), /RUN FAILURE/);
});

test("a failing property makes the certificate not-demo-ready and the render names it", () => {
  const failing = buildCertificate(
    buildInput({ run: runWith({ failing: { scenario: "hello-en", repetition: 2 } }) }),
  );
  assert.equal(failing.verdict, "not-demo-ready");
  assert.equal(failing.pass, false);
  const c9 = failing.properties.find((property) => property.propertyId === "C9");
  assert.equal(c9?.status, "FAIL");
  const rendered = renderCertificate(failing);
  assert.match(rendered, /CERTIFICATE NOT-DEMO-READY \(NOT A PASS\)/);
  assert.match(rendered, /FAIL C9/);
});

test("a self-declared verdict that its own facts contradict is refused", () => {
  const copy = mutable(certified());
  (copy.properties as Mutable[])[0].status = "FAIL";
  (copy.properties as Mutable[])[0].reason = "below-bar";
  assertRefusal(() => validateCertificate(copy), "verdict-mismatch", /a verdict is computed/);

  const pending = mutable(buildCertificate(buildInput({ panel: null })));
  pending.pass = true;
  assertRefusal(
    () => validateCertificate(pending),
    "pass-without-certified",
    /only certified may be a pass/,
  );
});

test("unknown and omitted residual risks are refused by name", () => {
  assertRefusal(
    () => buildCertificate(buildInput({ residualRiskIds: [...OPEN_RESIDUAL_RISK_IDS, "RR-99"] })),
    "unknown-residual-risk",
    /RR-99/,
  );
  assertRefusal(
    () =>
      buildCertificate(
        buildInput({ residualRiskIds: OPEN_RESIDUAL_RISK_IDS.filter((id) => id !== "RR-07") }),
      ),
    "missing-residual-risk",
    /RR-07/,
  );
});

test("the builder refuses an attempt that is not in the corpus, a Locale mismatch and a retry", () => {
  assertRefusal(
    () =>
      buildCertificate(
        buildInput({
          attempts: [
            ...attempts(),
            { scenario: "not-in-corpus", locale: "en", repetition: 1 },
          ],
        }),
      ),
    "unknown-scenario",
    /not-in-corpus/,
  );
  assertRefusal(
    () =>
      buildCertificate(
        buildInput({
          attempts: [...attempts(), { scenario: "hello-en", locale: "es", repetition: 1 }],
        }),
      ),
    "locale-mismatch",
    /declares Locale "en"/,
  );
  assertRefusal(
    () =>
      buildCertificate(
        buildInput({
          attempts: [
            ...attempts(),
            { scenario: "hello-en", locale: "en", repetition: 1 },
          ],
        }),
      ),
    "duplicate-attempt",
    /recorded twice/,
  );
});

test("the compact render states the verdict, the panel and the gap count", () => {
  const rendered = renderCertificate(certified());
  assert.match(rendered, /^CERTIFICATE CERTIFIED \(PASS\)/);
  assert.match(rendered, /target local/);
  assert.match(rendered, /corpus v1 c{64}/);
  assert.match(rendered, /panel panel-2026-10-31 reviewer owner/);
  assert.match(rendered, /no property failures/);
  assert.match(rendered, /no coverage gaps/);
  assert.match(rendered, /risks RR-01 RR-02 RR-03 RR-04 RR-05 RR-06 RR-07 RR-08/);

  const unsigned = renderCertificate(buildCertificate(buildInput({ panel: null })));
  assert.match(unsigned, /^CERTIFICATE PENDING-HUMAN \(NOT A PASS\)/);
  assert.match(unsigned, /panel UNSIGNED/);
});

test("a resumed certificate records the interruption and every reused call", () => {
  const resume = {
    journalRunId: "run-2026-10-31-01",
    journalPath: "/tmp/runs/run-2026-10-31-01/journal.jsonl",
    originalStartedAt: "2026-10-31T08:00:00.000Z",
    resumedAt: "2026-10-31T10:00:00.000Z",
    reusedCalls: ["a-1", "a-2"],
    madeCalls: ["a-3"],
  };
  const certificate = buildCertificate(buildInput({ resume }));
  assert.deepEqual(certificate.resume, resume);
  assert.equal(certificate.runId, "run-2026-10-31-01", "the original run id is kept");
  const rendered = renderCertificate(certificate);
  assert.match(rendered, /RESUMED run-2026-10-31-01/);
  assert.match(rendered, /2 reused, 1 made/);

  const empty = mutable(certificate);
  empty.resume = { ...resume, reusedCalls: [], madeCalls: [] };
  assertRefusal(
    () => validateCertificate(empty),
    "malformed-certificate",
    /resume records no calls/,
  );

  const notADate = mutable(certificate);
  notADate.resume = { ...resume, resumedAt: "yesterday" };
  assertRefusal(
    () => validateCertificate(notADate),
    "malformed-certificate",
    /resumedAt/,
  );
});

test("certificates are committable while audio and event artifacts stay gitignored", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../");
  const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  assert.doesNotMatch(ignore, /^voni\/evidence\/certificates\/?$/m, "certificates are committed");
  assert.match(ignore, /^voni\/\.captures\/$/m, "delivered WAVs stay working files");
  assert.match(ignore, /^voice-pipeline\/\.events\/$/m, "event traces stay working files");
  assert.match(ignore, /^voni\/\.voice-references\/$/m, "reference WAVs stay working files");

  const voniIgnore = readFileSync(join(repoRoot, "voni/.gitignore"), "utf8");
  assert.match(voniIgnore, /^\/certificates$/m, "dev TLS certs stay ignored and are not this dir");

  const ignored = spawnSync(
    "git",
    ["check-ignore", "-q", "voni/evidence/certificates/README.md"],
    { cwd: repoRoot },
  );
  if (ignored.status !== 128) {
    assert.equal(
      ignored.status,
      1,
      "voni/evidence/certificates must not be matched by any ignore rule; git says it is",
    );
  }

  const file = certificateFile("run-2026-10-31-01");
  assert.ok(
    file.pathname.endsWith("/voni/evidence/certificates/run-2026-10-31-01.json"),
    file.pathname,
  );
  assertRefusal(
    () => certificateFileName("../escape"),
    "unsafe-run-id",
    /safe certificate file name/,
  );
});

test("the live 82-property contract appears in full, with every fail-closed gap cited", async () => {
  const contract = await loadContract();
  const run = judgeRun({
    runId: "run-contract-01",
    contract,
    evidence: [],
    calls: [],
  });
  const certificate = buildCertificate(
    buildInput({
      contract,
      run,
      attempts: [],
      cost: { usd: 0, callCount: 0 },
      panel: null,
    }),
  );

  assert.equal(contract.properties.length, 82);
  assert.equal(certificate.properties.length, 82, "every contract property is carried");
  assert.deepEqual(
    certificate.properties.map((property) => property.propertyId),
    contract.properties.map((property) => property.id),
  );
  for (const property of certificate.properties) {
    assert.ok(
      property.citations.length > 0,
      `${property.propertyId} is fail-closed with a citation`,
    );
  }
  const h6 = certificate.properties.find((property) => property.propertyId === "H6");
  assert.equal(h6?.status, "FAIL");
  assert.equal(h6?.reason, "no-evaluator");
  assert.match(h6?.citations[0] ?? "", /^contract:H6$/);
  assert.equal(certificate.verdict, "not-demo-ready");
  assert.equal(certificate.pass, false);
});

test("a run-scoped E3 verdict is cited on the run, not forced onto a corpus scenario", () => {
  const E3: ContractPropertyEntry = {
    id: "E3",
    family: "economics",
    statement: "Run cost stays inside the plan's ceiling",
    bar: { text: "total <= $10", numeric: true },
    evidence: "cost",
    kind: "deterministic",
    repetitions: 1,
    thresholds: [
      { source: "budget-record", key: "dvCostFullRunMaxUsd", value: 10, unit: "usd" },
    ],
  };
  const contract: Contract = {
    families: [
      { id: "turn-taking", title: "Turn taking", propertyCount: 1 },
      { id: "economics", title: "Economics", propertyCount: 1 },
    ],
    properties: [T1, E3],
  };
  const run = judgeRun({
    runId: "run-2026-10-31-01",
    contract,
    evidence: [
      ...evidence().filter((entry) => entry.propertyId === "T1"),
      {
        propertyId: "E3",
        bars: [{ key: "dvCostFullRunMaxUsd", statistic: "max", comparison: "at-most" }],
        measurements: [
          {
            propertyId: "E3",
            scenario: RUN_SCENARIO,
            repetition: 1,
            outcome: "measured",
            samples: [1.25],
            citations: ["cost:call-hello-en-1"],
          },
        ],
      },
    ],
  });
  const certificate = buildCertificate({
    ...buildInput(),
    contract,
    run,
  });
  const e3 = certificate.properties.find((property) => property.propertyId === "E3");
  assert.equal(e3?.status, "PASS");
  assert.equal(e3?.scenarios[0]?.scenario, RUN_SCENARIO);
  assert.equal(e3?.scenarios[0]?.locale, undefined);

  const lying = judgeRun({
    runId: "run-2026-10-31-01",
    contract,
    evidence: [
      ...evidence().filter((entry) => entry.propertyId === "T1"),
      {
        propertyId: "E3",
        bars: [{ key: "dvCostFullRunMaxUsd", statistic: "max", comparison: "at-most" }],
        measurements: [
          {
            propertyId: "E3",
            scenario: RUN_SCENARIO,
            repetition: 1,
            locale: "en",
            outcome: "measured",
            samples: [1.25],
            citations: ["cost:call-hello-en-1"],
          },
        ],
      },
    ],
  });
  assertRefusal(
    () => buildCertificate({ ...buildInput(), contract, run: lying }),
    "locale-mismatch",
    /run-scoped/,
  );
});

test("the certificate's residual-risk copy matches the committed register", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../");
  const register = readFileSync(
    join(repoRoot, "docs/agents/demo-verification.md"),
    "utf8",
  );
  const rows = [
    ...register.matchAll(
      /^\| (RR-\d{2}) \| .+? \| (owner|operator|engineer) \| (\d{4}-\d{2}-\d{2}) \|$/gm,
    ),
  ].map((match) => ({
    id: match[1],
    owner: match[2],
    opened: match[3],
  }));
  assert.ok(rows.length > 0, "the register table is machine-readable");
  assert.deepEqual(rows, RESIDUAL_RISKS.map((risk) => ({ ...risk })));
  assert.deepEqual(
    OPEN_RESIDUAL_RISK_IDS,
    rows.map((row) => row.id),
  );
});
