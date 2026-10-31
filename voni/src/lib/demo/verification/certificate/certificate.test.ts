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
}));

function attempts(
  filter: (locale: Locale) => boolean = () => true,
): NonNullable<CertificateBuildInput["attempts"]> {
  return SCENARIOS.filter((scenario) => filter(scenario.locale)).flatMap((scenario) =>
    [1, 2, 3].map((repetition) => ({
      scenario: scenario.name,
      locale: scenario.locale,
      repetition,
      callId: `call-${scenario.name}-${repetition}`,
    })),
  );
}

function evidence(failing?: { scenario: string; repetition: number }): PropertyEvidence[] {
  const numeric: PropertyMeasurement[] = [];
  const categorical: PropertyMeasurement[] = [];
  for (const scenario of SCENARIOS) {
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
} = {}): RunVerdict {
  return judgeRun({
    runId: "run-2026-10-31-01",
    contract: CONTRACT,
    evidence: overrides.evidence ?? evidence(overrides.failing),
    calls: overrides.calls ?? [],
  });
}

function buildInput(overrides: Partial<CertificateBuildInput> = {}): CertificateBuildInput {
  return {
    contract: CONTRACT,
    run: runWith(),
    target: "local",
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
  assert.deepEqual(certificate.code.fingerprint, FINGERPRINT);
  assert.equal(certificate.code.appBuild, "app-build-1");
  assert.equal(certificate.code.pipelineImage, `sha256:${"d".repeat(64)}`);
  assert.deepEqual(certificate.corpus, { version: 1, sha256: CORPUS_HASH });
  assert.deepEqual(certificate.vendorBuilds, VENDOR_BUILDS);
  assert.deepEqual(certificate.plan, { mode: "full", repetitions: 3 });
  assert.equal(certificate.coverage.expectedScenarios, 5);
  assert.equal(certificate.coverage.gapRows, 0);
  assert.equal(certificate.coverage.rows.length, 5);
  assert.equal(certificate.coverage.byLocale.length, LOCALES.length);
  assert.ok(certificate.coverage.byLocale.every((row) => row.status === "measured"));

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
  assert.equal(CERTIFICATE_SCHEMA_VERSION, 1);
  const copy = mutable(certified());
  copy.schemaVersion = CERTIFICATE_SCHEMA_VERSION + 1;
  assertRefusal(
    () => validateCertificate(copy),
    "unknown-schema-version",
    /schema version 2 is unknown/,
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
  assert.match(rendered, /risks RR-01 RR-02 RR-03 RR-04 RR-05 RR-06 RR-07/);

  const unsigned = renderCertificate(buildCertificate(buildInput({ panel: null })));
  assert.match(unsigned, /^CERTIFICATE PENDING-HUMAN \(NOT A PASS\)/);
  assert.match(unsigned, /panel UNSIGNED/);
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
