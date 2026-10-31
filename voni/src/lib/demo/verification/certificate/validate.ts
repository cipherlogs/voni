/**
 * The certificate validator: one reader that refuses what it cannot prove.
 *
 * A certificate is only usable for the run it names. The reader refuses an
 * unknown schema version, a target it is not asked for, a code fingerprint or
 * corpus hash that differs from the run, a verdict without citations, an open
 * residual risk that was dropped, and a `certified` verdict with no panel
 * signature — each by name. It also recomputes the verdict from the recorded
 * facts, so a document that calls itself certified while carrying a failure or
 * a coverage gap cannot be read as a pass.
 *
 * The schema is the contract; this file is the only shape check the builder,
 * the CLI and ticket 27's signing hook share.
 */

import { readFileSync } from "node:fs";

import { FAMILIES } from "../contract";
import { LOCALES } from "../scenarios";
import type { PropertyVerdictReason } from "../verdict";
import { CertificateError, type CertificateErrorCode } from "./errors";
import { deriveCertificateVerdict } from "./derive";
import { OPEN_RESIDUAL_RISK_IDS, knownResidualRisk } from "./risks";
import {
  CERTIFICATE_MODES,
  CERTIFICATE_SCHEMA_VERSION,
  CERTIFICATE_TARGETS,
  CERTIFICATE_VERDICTS,
  COVERAGE_STATUSES,
  REQUIRED_VENDOR_LEGS,
  VENDOR_LEGS,
  type Certificate,
  type CertificateCoverage,
  type CertificateEligibility,
  type CertificateExpectation,
  type CertificateProperty,
  type CertificateScenarioVerdict,
  type CertificateVerdict,
  type CoverageRow,
  type CoverageStatus,
  type LocaleCoverage,
  type PanelSignature,
  type VendorBuild,
} from "./types";

function refuse(code: CertificateErrorCode, message: string): never {
  throw new CertificateError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    refuse("malformed-certificate", `${field} is not an object`);
  }
  return value;
}

function text(
  value: unknown,
  field: string,
  code: CertificateErrorCode = "malformed-certificate",
): string {
  if (typeof value !== "string" || value.trim() === "") {
    refuse(code, `${field} is not a non-empty string (${JSON.stringify(value ?? null)})`);
  }
  return value;
}


function boolean(
  value: unknown,
  field: string,
  code: CertificateErrorCode = "malformed-certificate",
): boolean {
  if (typeof value !== "boolean") {
    refuse(code, `${field} is not a boolean (${JSON.stringify(value ?? null)})`);
  }
  return value;
}

function integer(
  value: unknown,
  field: string,
  code: CertificateErrorCode,
  minimum = 0,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    refuse(
      code,
      `${field} is not an integer >= ${minimum} (${JSON.stringify(value ?? null)})`,
    );
  }
  return value;
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  code: CertificateErrorCode,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    refuse(code, `${field} is "${String(value)}", not one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function strings(
  value: unknown,
  field: string,
  code: CertificateErrorCode,
  allowEmpty = true,
): string[] {
  if (!Array.isArray(value)) {
    refuse(code, `${field} is not an array`);
  }
  if (!allowEmpty && value.length === 0) {
    refuse(code, `${field} is empty`);
  }
  return value.map((entry, index) => text(entry, `${field}[${index}]`, code));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateCode(raw: unknown): Certificate["code"] {
  const code = record(raw, "code");
  const fingerprint = record(code.fingerprint, "code.fingerprint");
  const head = text(fingerprint.head, "code.fingerprint.head", "invalid-code-fingerprint");
  const dirty = boolean(fingerprint.dirty, "code.fingerprint.dirty", "invalid-code-fingerprint");
  const dirtyHash = text(
    fingerprint.dirtyHash,
    "code.fingerprint.dirtyHash",
    "invalid-code-fingerprint",
  );
  const appBuild = text(code.appBuild, "code.appBuild", "invalid-build");
  const pipelineImage = text(code.pipelineImage, "code.pipelineImage", "invalid-build");
  return {
    fingerprint: { head, dirty, dirtyHash },
    appBuild,
    pipelineImage,
  };
}

function validateCorpus(raw: unknown): Certificate["corpus"] {
  const corpus = record(raw, "corpus");
  const version = integer(corpus.version, "corpus.version", "invalid-corpus-reference", 1);
  const sha256 = text(corpus.sha256, "corpus.sha256", "invalid-corpus-reference");
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    refuse(
      "invalid-corpus-reference",
      `corpus.sha256 is not 64 lowercase hex characters (${sha256}); a certificate pins exact bytes`,
    );
  }
  return { version, sha256 };
}

function validateVendorBuilds(raw: unknown): VendorBuild[] {
  if (!Array.isArray(raw)) {
    refuse("invalid-vendor-builds", "vendorBuilds is not an array");
  }
  const seen = new Set<string>();
  const builds: VendorBuild[] = [];
  for (const [index, entry] of raw.entries()) {
    const build = record(entry, `vendorBuilds[${index}]`);
    const leg = oneOf(build.leg, VENDOR_LEGS, `vendorBuilds[${index}].leg`, "unknown-vendor-leg");
    if (seen.has(leg)) {
      refuse("duplicate-vendor-leg", `vendor leg "${leg}" is recorded twice`);
    }
    seen.add(leg);
    const vendor = text(build.vendor, `vendorBuilds[${index}].vendor`, "invalid-vendor-builds");
    const model = text(build.model, `vendorBuilds[${index}].model`, "invalid-vendor-builds");
    const buildId = text(
      build.buildId,
      `vendorBuilds[${index}].buildId`,
      "invalid-vendor-builds",
    );
    if (buildId === "unknown") {
      refuse(
        "invalid-vendor-builds",
        `vendor leg "${leg}" records build id "unknown"; an unrecorded build refuses the run (RR-03)`,
      );
    }
    builds.push({ leg, vendor, model, buildId });
  }
  for (const leg of REQUIRED_VENDOR_LEGS) {
    if (!seen.has(leg)) {
      refuse(
        "missing-vendor-build",
        `vendor leg "${leg}" has no recorded build id (RR-03); the certificate would describe a ` +
          "vendor nobody can reproduce",
      );
    }
  }
  return builds;
}

function validateRows(raw: unknown, planRepetitions: number): CoverageRow[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    refuse("invalid-coverage", "coverage.rows is not a non-empty array");
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const field = `coverage.rows[${index}]`;
    const row = record(entry, field);
    const locale = oneOf(row.locale, LOCALES, `${field}.locale`, "invalid-coverage");
    const scenario = text(row.scenario, `${field}.scenario`, "invalid-coverage");
    const key = `${locale}:${scenario}`;
    if (seen.has(key)) {
      refuse("invalid-coverage", `coverage row "${key}" appears twice`);
    }
    seen.add(key);
    const heldOut = boolean(row.heldOut, `${field}.heldOut`, "invalid-coverage");
    const requiredRepetitions = integer(
      row.requiredRepetitions,
      `${field}.requiredRepetitions`,
      "invalid-coverage",
      1,
    );
    if (requiredRepetitions !== planRepetitions) {
      refuse(
        "invalid-coverage",
        `${field}.requiredRepetitions is ${requiredRepetitions} but the plan requires ` +
          `${planRepetitions} repetitions`,
      );
    }
    const measuredRepetitions = integer(
      row.measuredRepetitions,
      `${field}.measuredRepetitions`,
      "invalid-coverage",
    );
    if (measuredRepetitions > requiredRepetitions) {
      refuse(
        "invalid-coverage",
        `${field} measured ${measuredRepetitions} repetitions of a ${requiredRepetitions}-repetition plan`,
      );
    }
    const status = oneOf(row.status, COVERAGE_STATUSES, `${field}.status`, "invalid-coverage");
    const expectedStatus: CoverageStatus =
      measuredRepetitions >= requiredRepetitions ? "measured" : "gap";
    if (status !== expectedStatus) {
      refuse(
        "invalid-coverage",
        `${field}.status is "${status}" but ${measuredRepetitions}/${requiredRepetitions} ` +
          `repetitions is "${expectedStatus}"`,
      );
    }
    let gap: string | null;
    if (status === "gap") {
      gap = text(row.gap, `${field}.gap`, "invalid-coverage");
    } else {
      if (row.gap !== null) {
        refuse("invalid-coverage", `${field}.gap must be null on a measured row`);
      }
      gap = null;
    }
    const calls = strings(row.calls, `${field}.calls`, "invalid-coverage");
    return {
      locale,
      scenario,
      heldOut,
      requiredRepetitions,
      measuredRepetitions,
      status,
      gap,
      calls,
    };
  });
}

function validateCoverage(raw: unknown, planRepetitions: number): CertificateCoverage {
  const coverage = record(raw, "coverage");
  const expectedScenarios = integer(
    coverage.expectedScenarios,
    "coverage.expectedScenarios",
    "invalid-coverage",
    1,
  );
  const rows = validateRows(coverage.rows, planRepetitions);
  if (rows.length !== expectedScenarios) {
    refuse(
      "coverage-row-missing",
      `coverage carries ${rows.length} rows but the corpus expects ${expectedScenarios}; ` +
        "a missing scenario is a gap row, never an omission",
    );
  }
  const recomputedGapRows = rows.filter((row) => row.status === "gap").length;
  const gapRows = integer(coverage.gapRows, "coverage.gapRows", "invalid-coverage");
  if (gapRows !== recomputedGapRows) {
    refuse(
      "invalid-coverage",
      `coverage.gapRows is ${gapRows} but the rows carry ${recomputedGapRows} gaps`,
    );
  }

  if (!Array.isArray(coverage.byLocale) || coverage.byLocale.length !== LOCALES.length) {
    refuse(
      "invalid-coverage",
      `coverage.byLocale must carry exactly the ${LOCALES.length} demo Locales`,
    );
  }
  const seenLocales = new Set<string>();
  const byLocale: LocaleCoverage[] = coverage.byLocale.map((entry, index) => {
    const field = `coverage.byLocale[${index}]`;
    const localeRow = record(entry, field);
    const locale = oneOf(localeRow.locale, LOCALES, `${field}.locale`, "invalid-coverage");
    if (seenLocales.has(locale)) {
      refuse("invalid-coverage", `coverage.byLocale records Locale "${locale}" twice`);
    }
    seenLocales.add(locale);
    const expected = integer(
      localeRow.expectedScenarios,
      `${field}.expectedScenarios`,
      "invalid-coverage",
    );
    const measured = integer(
      localeRow.measuredScenarios,
      `${field}.measuredScenarios`,
      "invalid-coverage",
    );
    const gaps = integer(localeRow.gapRows, `${field}.gapRows`, "invalid-coverage");
    const status = oneOf(localeRow.status, COVERAGE_STATUSES, `${field}.status`, "invalid-coverage");

    const localeRows = rows.filter((row) => row.locale === locale);
    const actualMeasured = localeRows.filter((row) => row.status === "measured").length;
    const actualGaps = localeRows.length - actualMeasured;
    if (expected !== localeRows.length || measured !== actualMeasured || gaps !== actualGaps) {
      refuse(
        "invalid-coverage",
        `${field} counts do not match its rows: expected ${expected}/${localeRows.length}, ` +
          `measured ${measured}/${actualMeasured}, gaps ${gaps}/${actualGaps}`,
      );
    }
    const expectedStatus: CoverageStatus =
      localeRows.length > 0 && actualGaps === 0 ? "measured" : "gap";
    if (status !== expectedStatus) {
      refuse(
        "invalid-coverage",
        `${field}.status is "${status}" but ${actualMeasured}/${localeRows.length} scenarios ` +
          `were measured`,
      );
    }
    const gap =
      expectedStatus === "gap"
        ? text(localeRow.gap, `${field}.gap`, "invalid-coverage")
        : checkNullGap(localeRow.gap, field);
    return {
      locale,
      expectedScenarios: expected,
      measuredScenarios: measured,
      gapRows: gaps,
      status,
      gap,
    };
  });
  for (const locale of LOCALES) {
    if (!seenLocales.has(locale)) {
      refuse("invalid-coverage", `coverage.byLocale omits Locale "${locale}"`);
    }
  }

  return { expectedScenarios, gapRows, rows, byLocale };
}

function checkNullGap(value: unknown, field: string): null {
  if (value !== null) {
    refuse("invalid-coverage", `${field}.gap must be null when the Locale is measured`);
  }
  return null;
}

function validateProperties(raw: unknown): CertificateProperty[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    refuse("invalid-property-verdict", "properties is not a non-empty array");
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const field = `properties[${index}]`;
    const property = record(entry, field);
    const propertyId = text(property.propertyId, `${field}.propertyId`, "invalid-property-verdict");
    if (seen.has(propertyId)) {
      refuse("duplicate-property-verdict", `property "${propertyId}" is recorded twice`);
    }
    seen.add(propertyId);
    const family = oneOf(property.family, FAMILIES, `${field}.family`, "invalid-property-verdict");
    const status = oneOf(
      property.status,
      ["PASS", "FAIL"] as const,
      `${field}.status`,
      "invalid-property-verdict",
    );
    const reason = text(
      property.reason,
      `${field}.reason`,
      "invalid-property-verdict",
    ) as PropertyVerdictReason;
    const sampleCount = integer(
      property.sampleCount,
      `${field}.sampleCount`,
      "invalid-property-verdict",
    );
    if (status === "PASS" && sampleCount === 0) {
      refuse(
        "invalid-property-verdict",
        `${propertyId} passes with zero samples; an unmeasured property cannot pass`,
      );
    }
    const citationValues = property.citations;
    if (!Array.isArray(citationValues) || citationValues.length === 0) {
      refuse(
        "verdict-without-citations",
        `${propertyId} carries no citation; a verdict names the evidence that proves it`,
      );
    }
    const citations = citationValues.map((entry, citationIndex) =>
      text(entry, `${field}.citations[${citationIndex}]`, "verdict-without-citations"),
    );
    const gaps = strings(property.gaps, `${field}.gaps`, "invalid-property-verdict");

    if (!Array.isArray(property.scenarios)) {
      refuse("invalid-property-verdict", `${field}.scenarios is not an array`);
    }
    const scenarios: CertificateScenarioVerdict[] = property.scenarios.map(
      (scenarioEntry, scenarioIndex) => {
        const scenarioField = `${field}.scenarios[${scenarioIndex}]`;
        const scenario = record(scenarioEntry, scenarioField);
        const locale =
          scenario.locale === undefined
            ? undefined
            : oneOf(scenario.locale, LOCALES, `${scenarioField}.locale`, "invalid-property-verdict");
        return {
          scenario: text(scenario.scenario, `${scenarioField}.scenario`, "invalid-property-verdict"),
          ...(locale === undefined ? {} : { locale }),
          status: oneOf(
            scenario.status,
            ["PASS", "FAIL"] as const,
            `${scenarioField}.status`,
            "invalid-property-verdict",
          ),
          reason: text(
            scenario.reason,
            `${scenarioField}.reason`,
            "invalid-property-verdict",
          ) as PropertyVerdictReason,
          sampleCount: integer(
            scenario.sampleCount,
            `${scenarioField}.sampleCount`,
            "invalid-property-verdict",
          ),
          citations: strings(
            scenario.citations,
            `${scenarioField}.citations`,
            "invalid-property-verdict",
          ),
        };
      },
    );

    return {
      propertyId,
      family,
      status,
      reason,
      sampleCount,
      citations,
      gaps,
      scenarios,
    };
  });
}

function validateEligibility(raw: unknown): CertificateEligibility {
  const eligibility = record(raw, "eligibility");
  const eligible = boolean(eligibility.eligible, "eligibility.eligible", "invalid-eligibility");
  const reasons = strings(eligibility.reasons, "eligibility.reasons", "invalid-eligibility");
  if (!eligible && reasons.length === 0) {
    refuse(
      "invalid-eligibility",
      "eligibility.eligible is false but no reason is recorded; an ineligible run names why",
    );
  }
  if (eligible && reasons.length > 0) {
    refuse(
      "invalid-eligibility",
      `eligibility.eligible is true but ${reasons.length} ineligibility reason(s) are recorded`,
    );
  }
  return { eligible, reasons };
}

function validateCost(raw: unknown): Certificate["cost"] {
  const cost = record(raw, "cost");
  if (typeof cost.usd !== "number" || !Number.isFinite(cost.usd) || cost.usd < 0) {
    refuse("invalid-cost", `cost.usd is not a finite non-negative number (${String(cost.usd)})`);
  }
  const callCount = integer(cost.callCount, "cost.callCount", "invalid-cost");
  return { usd: cost.usd, callCount };
}

function validateResidualRisks(raw: unknown): string[] {
  const ids = strings(raw, "residualRiskIds", "invalid-residual-risks", false);
  if (new Set(ids).size !== ids.length) {
    refuse("invalid-residual-risks", "residualRiskIds records an id twice");
  }
  for (const id of ids) {
    if (knownResidualRisk(id) === undefined) {
      refuse(
        "unknown-residual-risk",
        `residual risk "${id}" is not in the register (docs/agents/demo-verification.md)`,
      );
    }
  }
  const missing = OPEN_RESIDUAL_RISK_IDS.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    refuse(
      "missing-residual-risk",
      `the certificate omits open residual risks ${missing.join(", ")}; an omitted risk is a ` +
        "false green",
    );
  }
  return ids;
}

function validatePanel(raw: unknown, verdict: CertificateVerdict): PanelSignature | null {
  if (raw === null) {
    if (verdict === "certified") {
      refuse(
        "missing-panel-signature",
        "the certificate says certified but carries no panel signature; an unsigned certificate " +
          "is pending-human, never certified",
      );
    }
    return null;
  }
  const panel = record(raw, "panel");
  const signature: PanelSignature = {
    sessionId: text(panel.sessionId, "panel.sessionId", "invalid-panel-signature"),
    reviewer: text(panel.reviewer, "panel.reviewer", "invalid-panel-signature"),
    signedAt: text(panel.signedAt, "panel.signedAt", "invalid-panel-signature"),
    signature: text(panel.signature, "panel.signature", "invalid-panel-signature"),
  };
  if (!ISO_DATE.test(signature.signedAt) || Number.isNaN(Date.parse(signature.signedAt))) {
    refuse(
      "invalid-panel-signature",
      `panel.signedAt is "${signature.signedAt}", not a YYYY-MM-DD date`,
    );
  }
  if (verdict === "pending-human") {
    refuse(
      "unexpected-panel-signature",
      "the certificate says pending-human but carries a panel signature; a signed clean run is " +
        "certified",
    );
  }
  return signature;
}

function sameFingerprint(
  left: Certificate["code"]["fingerprint"],
  right: Certificate["code"]["fingerprint"],
): boolean {
  return (
    left.head === right.head &&
    left.dirty === right.dirty &&
    left.dirtyHash === right.dirtyHash
  );
}

/**
 * Read and validate a certificate. Structural refusals always apply; when an
 * expectation is supplied, the certificate must also match that run's target,
 * run id, code fingerprint and corpus hash.
 */
export function validateCertificate(
  raw: unknown,
  expectation: CertificateExpectation = {},
): Certificate {
  const root = record(raw, "certificate");
  if (typeof root.schemaVersion !== "number" || !Number.isInteger(root.schemaVersion)) {
    refuse("malformed-certificate", "certificate.schemaVersion is not an integer");
  }
  if (root.schemaVersion !== CERTIFICATE_SCHEMA_VERSION) {
    refuse(
      "unknown-schema-version",
      `certificate schema version ${root.schemaVersion} is unknown; this reader understands ` +
        `${CERTIFICATE_SCHEMA_VERSION}`,
    );
  }
  const runId = text(root.runId, "runId");
  const target = oneOf(root.target, CERTIFICATE_TARGETS, "target", "unknown-target");
  const code = validateCode(root.code);
  const corpus = validateCorpus(root.corpus);
  const vendorBuilds = validateVendorBuilds(root.vendorBuilds);

  const plan = record(root.plan, "plan");
  const mode = oneOf(plan.mode, CERTIFICATE_MODES, "plan.mode", "unknown-mode");
  const repetitions = integer(plan.repetitions, "plan.repetitions", "invalid-plan", 1);
  if (repetitions > 100) {
    refuse("invalid-plan", `plan.repetitions ${repetitions} exceeds 100`);
  }

  const coverage = validateCoverage(root.coverage, repetitions);
  const properties = validateProperties(root.properties);
  const eligibility = validateEligibility(root.eligibility);
  const runFailures = strings(root.runFailures, "runFailures", "malformed-certificate");
  const cost = validateCost(root.cost);
  const residualRiskIds = validateResidualRisks(root.residualRiskIds);
  const verdict = oneOf(root.verdict, CERTIFICATE_VERDICTS, "verdict", "malformed-certificate");
  const panel = validatePanel(root.panel, verdict);
  const pass = boolean(root.pass, "pass");

  if (pass !== (verdict === "certified")) {
    refuse(
      "pass-without-certified",
      `certificate.pass is ${pass} but the verdict is "${verdict}"; only certified may be a pass`,
    );
  }

  const derived = deriveCertificateVerdict({ eligibility, properties, runFailures, coverage, panel });
  if (verdict !== derived) {
    refuse(
      "verdict-mismatch",
      `certificate says "${verdict}" but its own facts derive "${derived}"; a verdict is computed, ` +
        "not asserted",
    );
  }

  if (expectation.target !== undefined && expectation.target !== target) {
    refuse(
      "target-mismatch",
      `certificate is true for target "${target}", not "${expectation.target}"; a green never ` +
        "inherits across targets",
    );
  }
  if (expectation.runId !== undefined && expectation.runId !== runId) {
    refuse(
      "run-id-mismatch",
      `certificate names run "${runId}", not "${expectation.runId}"`,
    );
  }
  if (
    expectation.codeFingerprint !== undefined &&
    !sameFingerprint(code.fingerprint, expectation.codeFingerprint)
  ) {
    refuse(
      "code-fingerprint-mismatch",
      `certificate code fingerprint ${code.fingerprint.head}` +
        `${code.fingerprint.dirty ? "+dirty" : ""} does not match the run's ` +
        `${expectation.codeFingerprint.head}` +
        `${expectation.codeFingerprint.dirty ? "+dirty" : ""}; the green does not carry over`,
    );
  }
  if (
    expectation.corpus !== undefined &&
    (expectation.corpus.version !== corpus.version ||
      expectation.corpus.sha256 !== corpus.sha256)
  ) {
    refuse(
      "corpus-hash-mismatch",
      `certificate pins corpus v${corpus.version} ${corpus.sha256}, not the run's ` +
        `v${expectation.corpus.version} ${expectation.corpus.sha256}`,
    );
  }

  return {
    schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    runId,
    target,
    code,
    corpus,
    vendorBuilds,
    plan: { mode, repetitions },
    coverage,
    properties,
    eligibility,
    runFailures,
    cost,
    residualRiskIds,
    panel,
    verdict,
    pass,
  };
}

/** Parse committed JSON and validate it. */
export function parseCertificate(
  document: string,
  expectation: CertificateExpectation = {},
): Certificate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document) as unknown;
  } catch (error) {
    refuse(
      "invalid-json",
      `certificate is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateCertificate(parsed, expectation);
}

/** Read a committed certificate file and validate it for the run it names. */
export function readCertificate(
  path: string,
  expectation: CertificateExpectation = {},
): Certificate {
  let document: string;
  try {
    document = readFileSync(path, "utf8");
  } catch (error) {
    refuse(
      "unreadable-certificate",
      `cannot read certificate ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseCertificate(document, expectation);
}

/** Serialize a certificate for commit. An invalid claim is refused, never written. */
export function serializeCertificate(
  certificate: Certificate,
  expectation: CertificateExpectation = {},
): string {
  return `${JSON.stringify(validateCertificate(certificate, expectation), null, 2)}\n`;
}
