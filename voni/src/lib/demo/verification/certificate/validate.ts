/**
 * The certificate validator: one reader that refuses what it cannot prove.
 *
 * A certificate is only usable for the run it names. The reader refuses an
 * unknown schema version, a v3 certificate with no declared scope, a target it
 * is not asked for, a code fingerprint or corpus hash that differs from the
 * run, a verdict without citations, an open residual risk that was dropped,
 * and a `certified` verdict with no panel signature — each by name. It also
 * recomputes the verdict from the recorded facts, and the coverage status of
 * every Locale from the declared scope, so a document that calls itself
 * certified while carrying a failure, a coverage gap, an out-of-scope Locale
 * that ran, or an invented scope decision cannot be read as a pass.
 *
 * The schema is the contract; this file is the only shape check the builder,
 * the CLI and ticket 27's signing hook share.
 */

import { readFileSync } from "node:fs";

import { FAMILIES } from "../contract";
import { LOCALES, SCENARIO_CLASSES, type Locale } from "../scenarios";
import type { PropertyVerdictReason } from "../verdict";
import { CertificateError, type CertificateErrorCode } from "./errors";
import { deriveCertificateVerdict } from "./derive";
import { OPEN_RESIDUAL_RISK_IDS, knownResidualRisk } from "./risks";
import { outOfScopeLocales } from "./scope";
import {
  CERTIFICATE_MODES,
  CERTIFICATE_SCHEMA_VERSION,
  CERTIFICATE_TARGETS,
  CERTIFICATE_VERDICTS,
  COVERAGE_STATUSES,
  LOCALE_COVERAGE_STATUSES,
  REQUIRED_VENDOR_LEGS,
  SCOPE_DECIDERS,
  VENDOR_LEGS,
  type Certificate,
  type CertificateCorpusScenario,
  type CertificateCoverage,
  type CertificateEligibility,
  type CertificateExpectation,
  type CertificateProperty,
  type CertificateResume,
  type CertificateScenarioVerdict,
  type CertificateVerdict,
  type CertificationScope,
  type CoverageRow,
  type CoverageStatus,
  type LocaleCoverage,
  type PanelSignature,
  type ScopeDecision,
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

function validateCorpus(raw: unknown, version: number): Certificate["corpus"] {
  const corpus = record(raw, "corpus");
  const corpusVersion = integer(corpus.version, "corpus.version", "invalid-corpus-reference", 1);
  const sha256 = text(corpus.sha256, "corpus.sha256", "invalid-corpus-reference");
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    refuse(
      "invalid-corpus-reference",
      `corpus.sha256 is not 64 lowercase hex characters (${sha256}); a certificate pins exact bytes`,
    );
  }
  if (corpus.scenarios === undefined) {
    if (version >= 3) {
      refuse(
        "invalid-corpus-reference",
        "a version 3 certificate must record the corpus scenarios it covers; without them a " +
          "reader cannot demand one coverage row per declared scenario",
      );
    }
    return { version: corpusVersion, sha256 };
  }
  if (!Array.isArray(corpus.scenarios) || corpus.scenarios.length === 0) {
    refuse("invalid-corpus-reference", "corpus.scenarios is not a non-empty array");
  }
  const seen = new Set<string>();
  const scenarios: CertificateCorpusScenario[] = corpus.scenarios.map((entry, index) => {
    const field = `corpus.scenarios[${index}]`;
    const scenario = record(entry, field);
    const name = text(scenario.name, `${field}.name`, "invalid-corpus-reference");
    if (seen.has(name)) {
      refuse("duplicate-corpus-scenario", `corpus scenario "${name}" appears twice`);
    }
    seen.add(name);
    return {
      name,
      locale: oneOf(scenario.locale, LOCALES, `${field}.locale`, "invalid-corpus-reference"),
      heldOut: boolean(scenario.heldOut, `${field}.heldOut`, "invalid-corpus-reference"),
      class: oneOf(scenario.class, SCENARIO_CLASSES, `${field}.class`, "invalid-corpus-reference"),
    };
  });
  return { version: corpusVersion, sha256, scenarios };
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

function validateScope(raw: unknown, version: number): CertificationScope | null {
  if (raw === undefined || raw === null) {
    if (version >= 3) {
      refuse(
        "missing-scope",
        "a version 3 certificate must carry scope (the declared Locales and the owner decision); " +
          "a claim that does not name its Locale set is refused",
      );
    }
    return null;
  }
  if (version < 3) {
    refuse(
      "invalid-scope",
      `a version ${version} certificate cannot carry a declared scope; a scoped claim is version 3`,
    );
  }
  const scope = record(raw, "scope");
  const decidedBy = oneOf(scope.decidedBy, SCOPE_DECIDERS, "scope.decidedBy", "invalid-scope");
  const decidedOn = text(scope.decidedOn, "scope.decidedOn", "invalid-scope");
  if (!ISO_DATE.test(decidedOn) || Number.isNaN(Date.parse(decidedOn))) {
    refuse("invalid-scope", `scope.decidedOn "${decidedOn}" is not a YYYY-MM-DD date`);
  }
  const reason = text(scope.reason, "scope.reason", "invalid-scope");
  if (!Array.isArray(scope.locales) || scope.locales.length === 0) {
    refuse("invalid-scope", "scope.locales is empty; a certificate is a claim about at least one Locale");
  }
  const seen = new Set<Locale>();
  for (const [index, value] of scope.locales.entries()) {
    const locale = oneOf(value, LOCALES, `scope.locales[${index}]`, "invalid-scope");
    if (seen.has(locale)) {
      refuse("invalid-scope", `scope.locales records Locale "${locale}" twice`);
    }
    seen.add(locale);
  }
  return {
    locales: LOCALES.filter((locale) => seen.has(locale)),
    decidedBy,
    decidedOn,
    reason,
  };
}

function scopeDecision(scope: CertificationScope): ScopeDecision {
  return {
    decidedBy: scope.decidedBy,
    decidedOn: scope.decidedOn,
    reason: scope.reason,
  };
}

/** An out-of-scope row must carry the same decision the certificate declares. */
function validateDecision(
  raw: unknown,
  field: string,
  scope: CertificationScope,
): ScopeDecision {
  if (raw === undefined || raw === null) {
    refuse(
      "invalid-scope",
      `${field}.decision is missing; an out-of-scope Locale names the owner decision that excludes it`,
    );
  }
  const decision = record(raw, `${field}.decision`);
  const decidedBy = oneOf(
    decision.decidedBy,
    SCOPE_DECIDERS,
    `${field}.decision.decidedBy`,
    "invalid-scope",
  );
  const decidedOn = text(decision.decidedOn, `${field}.decision.decidedOn`, "invalid-scope");
  const reason = text(decision.reason, `${field}.decision.reason`, "invalid-scope");
  if (
    decidedBy !== scope.decidedBy ||
    decidedOn !== scope.decidedOn ||
    reason !== scope.reason
  ) {
    refuse(
      "invalid-scope",
      `${field}.decision does not match the certificate's declared decision ` +
        `(${scope.decidedBy}, ${scope.decidedOn}, "${scope.reason}"); a row cannot invent its scope`,
    );
  }
  return { decidedBy, decidedOn, reason };
}

function validateRows(
  raw: unknown,
  planRepetitions: number,
  scope: CertificationScope | null,
  requireClass: boolean,
): CoverageRow[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    refuse("invalid-coverage", "coverage.rows is not a non-empty array");
  }
  const seen = new Set<string>();
  const classOf = new Map<string, string>();
  return raw.map((entry, index) => {
    const field = `coverage.rows[${index}]`;
    const row = record(entry, field);
    const locale = oneOf(row.locale, LOCALES, `${field}.locale`, "invalid-coverage");
    if (scope !== null && !scope.locales.includes(locale)) {
      refuse(
        "scope-violation",
        `${field} names Locale "${locale}", which the declared scope ` +
          `(${scope.locales.join(", ")}) excludes; a Locale that ran is measured, never out of scope`,
      );
    }
    const scenario = text(row.scenario, `${field}.scenario`, "invalid-coverage");
    let scenarioClass: CoverageRow["class"] = null;
    if (row.class !== undefined && row.class !== null) {
      scenarioClass = oneOf(
        row.class,
        SCENARIO_CLASSES,
        `${field}.class`,
        "invalid-coverage",
      );
    } else if (requireClass) {
      refuse(
        "invalid-coverage",
        `${field}.class is missing; a version 3 coverage row names its scenario class`,
      );
    }
    if (scenarioClass !== null) {
      const known = classOf.get(scenario);
      if (known !== undefined && known !== scenarioClass) {
        refuse(
          "invalid-coverage",
          `scenario "${scenario}" is recorded as class "${known}" and "${scenarioClass}"; ` +
            "a scenario has one class",
        );
      }
      classOf.set(scenario, scenarioClass);
    }
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
      class: scenarioClass,
      requiredRepetitions,
      measuredRepetitions,
      status,
      gap,
      calls,
    };
  });
}

function validateCoverage(
  raw: unknown,
  planRepetitions: number,
  scope: CertificationScope | null,
  requireClass: boolean,
  declared?: readonly CertificateCorpusScenario[],
): CertificateCoverage {
  const coverage = record(raw, "coverage");
  const expectedScenarios = integer(
    coverage.expectedScenarios,
    "coverage.expectedScenarios",
    "invalid-coverage",
    1,
  );
  const rows = validateRows(coverage.rows, planRepetitions, scope, requireClass);
  if (rows.length !== expectedScenarios) {
    refuse(
      "coverage-row-missing",
      `coverage carries ${rows.length} rows but the corpus expects ${expectedScenarios}; ` +
        "a missing scenario is a gap row, never an omission",
    );
  }
  if (declared !== undefined) {
    const byKey = new Map(rows.map((row) => [`${row.locale}:${row.scenario}`, row]));
    for (const scenario of declared) {
      if (scope !== null && !scope.locales.includes(scenario.locale)) {
        refuse(
          "scope-violation",
          `the corpus declares scenario "${scenario.name}" in Locale "${scenario.locale}", which ` +
            `the declared scope (${scope.locales.join(", ")}) excludes; a scope narrowed after the ` +
            "run cannot delete a scenario it covered",
        );
      }
      const key = `${scenario.locale}:${scenario.name}`;
      const row = byKey.get(key);
      if (row === undefined) {
        refuse(
          "coverage-row-missing",
          `the corpus declares scenario "${scenario.name}" (${scenario.locale}) but the coverage ` +
            "carries no row for it; a missing row is a failure, never an omission",
        );
      }
      if (row.class !== scenario.class) {
        refuse(
          "invalid-coverage",
          `coverage row "${key}" records class "${String(row.class)}" but the corpus declares ` +
            `"${scenario.class}"`,
        );
      }
      if (row.heldOut !== scenario.heldOut) {
        refuse(
          "invalid-coverage",
          `coverage row "${key}" records heldOut ${String(row.heldOut)} but the corpus declares ` +
            `${String(scenario.heldOut)}`,
        );
      }
      byKey.delete(key);
    }
    if (byKey.size > 0) {
      refuse(
        "invalid-coverage",
        `coverage carries ${byKey.size} row(s) that are not in the declared corpus: ` +
          `${[...byKey.keys()].join(", ")}`,
      );
    }
    if (expectedScenarios !== declared.length) {
      refuse(
        "invalid-coverage",
        `coverage.expectedScenarios is ${expectedScenarios} but the certificate records ` +
          `${declared.length} corpus scenarios; the declared set is the denominator`,
      );
    }
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
  const outOfScope = scope === null ? [] : outOfScopeLocales(scope.locales);
  const decision = scope === null ? null : scopeDecision(scope);
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
    const status = oneOf(
      localeRow.status,
      LOCALE_COVERAGE_STATUSES,
      `${field}.status`,
      "invalid-coverage",
    );

    const localeRows = rows.filter((row) => row.locale === locale);
    if (decision !== null && outOfScope.includes(locale)) {
      if (expected !== 0 || measured !== 0 || gaps !== 0 || localeRows.length !== 0) {
        refuse(
          "scope-violation",
          `${field} is out of scope but records ${localeRows.length} row(s), ` +
            `${measured} measured, ${gaps} gap(s); a Locale that ran is measured, never out of scope`,
        );
      }
      if (status !== "out-of-scope") {
        refuse(
          "invalid-coverage",
          `${field}.status is "${status}" but Locale "${locale}" is excluded by the declared scope`,
        );
      }
      if (localeRow.gap !== null) {
        refuse("invalid-coverage", `${field}.gap must be null on an out-of-scope Locale`);
      }
      return {
        locale,
        expectedScenarios: 0,
        measuredScenarios: 0,
        gapRows: 0,
        status: "out-of-scope" as const,
        gap: null,
        decision: validateDecision(localeRow.decision, field, scope!),
      };
    }

    const actualMeasured = localeRows.filter((row) => row.status === "measured").length;
    const actualGaps = localeRows.length - actualMeasured;
    if (expected !== localeRows.length || measured !== actualMeasured || gaps !== actualGaps) {
      refuse(
        "invalid-coverage",
        `${field} counts do not match its rows: expected ${expected}/${localeRows.length}, ` +
          `measured ${measured}/${actualMeasured}, gaps ${gaps}/${actualGaps}`,
      );
    }
    if (status !== "measured" && status !== "gap") {
      refuse(
        "invalid-coverage",
        `${field}.status is "${status}" but Locale "${locale}" is inside the declared scope; ` +
          "only a Locale the scope excludes may be out of scope",
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
    if (localeRow.decision !== undefined && localeRow.decision !== null) {
      refuse(
        "invalid-coverage",
        `${field}.decision must be null on an in-scope Locale; only an out-of-scope row carries it`,
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
      decision: null,
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

function validateCost(raw: unknown, version: number): Certificate["cost"] {
  const cost = record(raw, "cost");
  const callCount = integer(cost.callCount, "cost.callCount", "invalid-cost");
  // A pre-v4 certificate recorded one exact total and was only written when
  // every leg was measured, so reading it as complete is the honest mapping of
  // its own refusal rule. A v4 document must carry the bound's terms.
  const legacyUsd = cost.usd;
  const measured = cost.usdMeasured;
  if (measured === undefined) {
    if (version >= 4) {
      refuse(
        "invalid-cost",
        "a version 4 certificate must carry cost.usdMeasured, cost.complete and cost.unpriced; " +
          "a bare usd cannot say whether it is exact or a lower bound",
      );
    }
    if (typeof legacyUsd !== "number" || !Number.isFinite(legacyUsd) || legacyUsd < 0) {
      refuse("invalid-cost", `cost.usd is not a finite non-negative number (${String(legacyUsd)})`);
    }
    return { usdMeasured: legacyUsd, complete: true, callCount, unpriced: [] };
  }
  if (typeof measured !== "number" || !Number.isFinite(measured) || measured < 0) {
    refuse(
      "invalid-cost",
      `cost.usdMeasured is not a finite non-negative number (${String(measured)})`,
    );
  }
  if (legacyUsd !== undefined) {
    refuse(
      "invalid-cost",
      "cost carries both usd and usdMeasured; a document says one thing about its money",
    );
  }
  const complete = boolean(cost.complete, "cost.complete", "invalid-cost");
  if (!Array.isArray(cost.unpriced)) {
    refuse("invalid-cost", "cost.unpriced is not an array; a bound names every unpriced leg");
  }
  const seen = new Set<string>();
  const unpriced = cost.unpriced.map((entry, index) => {
    const field = `cost.unpriced[${index}]`;
    const leg = record(entry, field);
    const callId = text(leg.callId, `${field}.callId`, "invalid-cost");
    const legName = text(leg.leg, `${field}.leg`, "invalid-cost");
    const unit = text(leg.unit, `${field}.unit`, "invalid-cost");
    const source = text(leg.source, `${field}.source`, "invalid-cost");
    const key = `${callId}:${legName}:${unit}`;
    if (seen.has(key)) {
      refuse("invalid-cost", `${field} records the unpriced leg "${key}" twice`);
    }
    seen.add(key);
    return { callId, leg: legName, unit, source };
  });
  if (complete !== (unpriced.length === 0)) {
    refuse(
      "invalid-cost",
      complete
        ? "cost.complete is true but cost.unpriced names legs; an incomplete price is not exact"
        : "cost.complete is false but cost.unpriced is empty; a bound must name what it cannot price",
    );
  }
  return { usdMeasured: measured, complete, callCount, unpriced };
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

function validateResume(raw: unknown, legacy: boolean): CertificateResume | null {
  if (legacy) {
    if (raw !== undefined) {
      refuse("malformed-certificate", "a version 1 certificate cannot carry resume");
    }
    return null;
  }
  if (raw === undefined) {
    refuse(
      "malformed-certificate",
      "a version 2 certificate must carry resume (null for a run made in one piece)",
    );
  }
  if (raw === null) return null;
  const resume = record(raw, "resume");
  const reusedCalls = strings(
    resume.reusedCalls,
    "resume.reusedCalls",
    "malformed-certificate",
  );
  const madeCalls = strings(resume.madeCalls, "resume.madeCalls", "malformed-certificate");
  const all = [...reusedCalls, ...madeCalls];
  if (all.length === 0) {
    refuse(
      "malformed-certificate",
      "resume records no calls; a resumed certificate names what each half contributed",
    );
  }
  if (new Set(all).size !== all.length) {
    refuse("malformed-certificate", "resume records the same call in both halves");
  }
  const instant = (value: unknown, field: string): string => {
    const stamp = text(value, field, "malformed-certificate");
    if (Number.isNaN(Date.parse(stamp))) {
      refuse("malformed-certificate", `${field} "${stamp}" is not a date`);
    }
    return stamp;
  };
  return {
    journalRunId: text(resume.journalRunId, "resume.journalRunId", "malformed-certificate"),
    journalPath: text(resume.journalPath, "resume.journalPath", "malformed-certificate"),
    originalStartedAt: instant(resume.originalStartedAt, "resume.originalStartedAt"),
    resumedAt: instant(resume.resumedAt, "resume.resumedAt"),
    reusedCalls,
    madeCalls,
  };
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
  const legacy = root.schemaVersion === 1;
  const readable = [1, 2, 3, CERTIFICATE_SCHEMA_VERSION];
  if (!readable.includes(root.schemaVersion)) {
    refuse(
      "unknown-schema-version",
      `certificate schema version ${root.schemaVersion} is unknown; this reader understands ` +
        `${readable.join(", ")}`,
    );
  }
  const runId = text(root.runId, "runId");
  const target = oneOf(root.target, CERTIFICATE_TARGETS, "target", "unknown-target");
  const scope = validateScope(root.scope, root.schemaVersion);
  const code = validateCode(root.code);
  const corpus = validateCorpus(root.corpus, root.schemaVersion);
  const vendorBuilds = validateVendorBuilds(root.vendorBuilds);

  const plan = record(root.plan, "plan");
  const mode = oneOf(plan.mode, CERTIFICATE_MODES, "plan.mode", "unknown-mode");
  const repetitions = integer(plan.repetitions, "plan.repetitions", "invalid-plan", 1);
  if (repetitions > 100) {
    refuse("invalid-plan", `plan.repetitions ${repetitions} exceeds 100`);
  }

  const coverage = validateCoverage(
    root.coverage,
    repetitions,
    scope,
    root.schemaVersion >= 3,
    corpus.scenarios,
  );
  const properties = validateProperties(root.properties);
  const eligibility = validateEligibility(root.eligibility);
  const runFailures = strings(root.runFailures, "runFailures", "malformed-certificate");
  const cost = validateCost(root.cost, root.schemaVersion);
  const residualRiskIds = validateResidualRisks(root.residualRiskIds);
  const verdict = oneOf(root.verdict, CERTIFICATE_VERDICTS, "verdict", "malformed-certificate");
  const panel = validatePanel(root.panel, verdict);
  const resume = validateResume(root.resume, legacy);
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
  if (expectation.scope !== undefined) {
    const actual = scope?.locales ?? LOCALES;
    const expected = LOCALES.filter((locale) => expectation.scope!.includes(locale));
    if (
      actual.length !== expected.length ||
      !expected.every((locale) => actual.includes(locale)) ||
      expected.length !== expectation.scope.length
    ) {
      refuse(
        "scope-mismatch",
        `certificate declares scope ${actual.join(", ")}, not the expected ` +
          `${expectation.scope.join(", ")}; a claim about another Locale set is not this run's`,
      );
    }
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
    schemaVersion: root.schemaVersion as Certificate["schemaVersion"],
    runId,
    target,
    scope,
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
    resume,
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
