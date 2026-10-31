/**
 * The certificate builder: one certificate from one run's own evidence.
 *
 * The builder copies what the verdict core measured and records the gaps it
 * could not measure. It never invents a bar, a sample, a citation, a vendor
 * build or a signature: a missing citation on a pass refuses the build, and a
 * scenario the run did not attempt becomes an explicit gap row. The finished
 * document is passed through the validator, so the builder cannot emit a
 * certificate its own reader would refuse.
 *
 * Target, code fingerprint and corpus hash are recorded as the run reported
 * them. Binding a certificate to a different target or run is the reader's
 * job ({@link validateCertificate}); a green never inherits.
 */

import { FAMILIES } from "../contract";
import { RUN_SCENARIO } from "../economics";
import { LOCALES, type Locale } from "../scenarios";
import type { RunVerdict } from "../verdict";
import { CertificateError } from "./errors";
import type { CertificateErrorCode } from "./errors";
import { deriveCertificateVerdict } from "./derive";
import { OPEN_RESIDUAL_RISK_IDS, knownResidualRisk } from "./risks";
import {
  CERTIFICATE_MODES,
  CERTIFICATE_SCHEMA_VERSION,
  CERTIFICATE_TARGETS,
  REQUIRED_VENDOR_LEGS,
  VENDOR_LEGS,
  type Certificate,
  type CertificateBuildInput,
  type CertificateCoverage,
  type CertificateCorpusScenario,
  type CertificateEligibility,
  type CertificateProperty,
  type CertificateScenarioVerdict,
  type CertificationAttempt,
  type CoverageRow,
  type LocaleCoverage,
  type VendorBuild,
} from "./types";
import { validateCertificate } from "./validate";

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function refuse(code: CertificateErrorCode, message: string): never {
  throw new CertificateError(code, message);
}

/** Every contract property must appear once, in contract order. */
function assertRunMatchesContract(input: CertificateBuildInput): void {
  const expected = input.contract.properties.map((property) => property.id);
  const actual = input.run.properties.map((property) => property.propertyId);
  const seen = new Set<string>();
  for (const id of actual) {
    if (seen.has(id)) {
      refuse("property-contract-mismatch", `run verdict records property "${id}" twice`);
    }
    seen.add(id);
  }
  if (expected.length !== actual.length) {
    refuse(
      "property-contract-mismatch",
      `run verdict carries ${actual.length} properties but the contract owns ${expected.length}; ` +
        "a certificate must carry every property",
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) {
      refuse(
        "property-contract-mismatch",
        `run verdict property ${index + 1} is "${actual[index]}" but the contract orders ` +
          `"${expected[index]}" there`,
      );
    }
  }
}

function assertPlan(input: CertificateBuildInput): void {
  if (!(CERTIFICATE_MODES as readonly string[]).includes(input.plan.mode)) {
    refuse("unknown-mode", `plan mode "${String(input.plan.mode)}" is not a run plan`);
  }
  if (
    !Number.isInteger(input.plan.repetitions) ||
    input.plan.repetitions < 1 ||
    input.plan.repetitions > 100
  ) {
    refuse(
      "invalid-plan",
      `plan repetitions ${String(input.plan.repetitions)} is not an integer between 1 and 100`,
    );
  }
}

function assertCorpus(input: CertificateBuildInput): Map<string, CertificateCorpusScenario> {
  if (!Number.isInteger(input.corpus.version) || input.corpus.version < 1) {
    refuse(
      "invalid-corpus-reference",
      `corpus version ${String(input.corpus.version)} is not a positive integer`,
    );
  }
  if (input.corpus.fingerprint.trim() === "") {
    refuse("invalid-corpus-reference", "the corpus carries no fingerprint; a certificate pins one");
  }
  if (input.corpus.scenarios.length === 0) {
    refuse("empty-corpus", "the corpus names no scenario; a certificate covers at least one");
  }
  const byName = new Map<string, CertificateCorpusScenario>();
  for (const scenario of input.corpus.scenarios) {
    if (byName.has(scenario.name)) {
      refuse("duplicate-corpus-scenario", `corpus scenario "${scenario.name}" appears twice`);
    }
    if (!(LOCALES as readonly string[]).includes(scenario.locale)) {
      refuse(
        "locale-mismatch",
        `corpus scenario "${scenario.name}" declares unknown Locale "${String(scenario.locale)}"`,
      );
    }
    byName.set(scenario.name, scenario);
  }
  return byName;
}

/**
 * Coverage by Locale and scenario. Every corpus scenario gets exactly one row;
 * a scenario the run did not finish is a gap row with a named reason, and every
 * demo Locale gets a summary row even when the corpus has nothing for it.
 */
function buildCoverage(
  input: CertificateBuildInput,
  scenarios: Map<string, CertificateCorpusScenario>,
): CertificateCoverage {
  const measured = new Map<string, CertificationAttempt[]>();
  const seen = new Set<string>();
  for (const attempt of input.attempts) {
    const scenario = scenarios.get(attempt.scenario);
    if (scenario === undefined) {
      refuse(
        "unknown-scenario",
        `attempt names scenario "${attempt.scenario}", which is not in the corpus`,
      );
    }
    if (attempt.locale !== scenario.locale) {
      refuse(
        "locale-mismatch",
        `scenario "${attempt.scenario}" declares Locale "${scenario.locale}" but the attempt ` +
          `records "${attempt.locale}"`,
      );
    }
    if (
      !Number.isInteger(attempt.repetition) ||
      attempt.repetition < 1 ||
      attempt.repetition > input.plan.repetitions
    ) {
      refuse(
        "repetition-out-of-plan",
        `scenario "${attempt.scenario}" attempt ${String(attempt.repetition)} is outside the ` +
          `plan's 1..${input.plan.repetitions} repetitions`,
      );
    }
    const key = `${attempt.scenario}#${attempt.repetition}`;
    if (seen.has(key)) {
      refuse(
        "duplicate-attempt",
        `scenario "${attempt.scenario}" repetition ${attempt.repetition} is recorded twice; ` +
          "a retry cannot replace a failure",
      );
    }
    seen.add(key);
    const list = measured.get(attempt.scenario) ?? [];
    list.push(attempt);
    measured.set(attempt.scenario, list);
  }

  const rows: CoverageRow[] = [];
  for (const scenario of scenarios.values()) {
    const attempts = measured.get(scenario.name) ?? [];
    const measuredRepetitions = attempts.length;
    const requiredRepetitions = input.plan.repetitions;
    const gap =
      measuredRepetitions >= requiredRepetitions
        ? null
        : measuredRepetitions === 0
          ? "not run in this certification"
          : `measured ${measuredRepetitions} of ${requiredRepetitions} repetitions`;
    rows.push({
      locale: scenario.locale,
      scenario: scenario.name,
      heldOut: scenario.heldOut,
      requiredRepetitions,
      measuredRepetitions,
      status: gap === null ? "measured" : "gap",
      gap,
      calls: unique(attempts.map((attempt) => attempt.callId ?? "")),
    });
  }

  const byLocale: LocaleCoverage[] = [];
  for (const locale of LOCALES) {
    const localeRows = rows.filter((row) => row.locale === locale);
    const measuredScenarios = localeRows.filter((row) => row.status === "measured").length;
    const gapRows = localeRows.length - measuredScenarios;
    const gap =
      localeRows.length === 0
        ? "no scenario for this Locale in the corpus"
        : gapRows === 0
          ? null
          : `${gapRows} of ${localeRows.length} scenarios not measured`;
    byLocale.push({
      locale,
      expectedScenarios: localeRows.length,
      measuredScenarios,
      gapRows,
      status: gap === null ? "measured" : "gap",
      gap,
    });
  }

  return {
    expectedScenarios: rows.length,
    gapRows: rows.filter((row) => row.status === "gap").length,
    rows,
    byLocale,
  };
}

/** A measured failure must cite its call; a structural gap cites the registry. */
const STRUCTURAL_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "unresolved",
  "no-evaluator",
  "unmeasured",
  "skipped",
  "evaluator-error",
  "missing-evidence",
  "empty-sample",
  "invalid-sample",
  "repetition-shortfall",
  "duplicate-repetition",
  "bar-unbound",
  "categorical-missing-verdict",
]);

function buildProperties(
  run: RunVerdict,
  scenarios: ReadonlyMap<string, CertificateCorpusScenario>,
): CertificateProperty[] {
  return run.properties.map((property) => {
    const citations = unique(property.citations);
    if (citations.length === 0) {
      if (!STRUCTURAL_FAILURE_REASONS.has(property.reason)) {
        refuse(
          "verdict-without-citations",
          `${property.propertyId} is "${property.status}" (${property.reason}) with no citation; ` +
            "a measured verdict names the evidence that proves it",
        );
      }
      // A structural failure is still a pointer: the contract entry says why no
      // evaluator or no measurement answered.
      citations.push(`contract:${property.propertyId}`);
    }
    if (!(FAMILIES as readonly string[]).includes(property.family)) {
      refuse(
        "invalid-property-verdict",
        `${property.propertyId} names unknown family "${String(property.family)}"`,
      );
    }
    const scenarioRows: CertificateScenarioVerdict[] = property.scenarios.map((scenario) => {
      const known = scenarios.get(scenario.scenario);
      const locale =
        scenario.locale === undefined ? undefined : certificateLocale(scenario.locale);
      // A run-scoped property (E3's run ceiling) is judged on the run, not on a
      // call: its synthetic scenario has no corpus row and no Locale. Every
      // other scenario must be one the corpus pins.
      if (scenario.scenario === RUN_SCENARIO) {
        if (locale !== undefined) {
          refuse(
            "locale-mismatch",
            `${property.propertyId} is run-scoped, but its verdict records Locale "${locale}"`,
          );
        }
      } else if (known === undefined) {
        refuse(
          "unknown-scenario",
          `${property.propertyId} was judged on scenario "${scenario.scenario}", which is not in ` +
            "the corpus the certificate pins",
        );
      } else if (locale !== undefined && locale !== known.locale) {
        refuse(
          "locale-mismatch",
          `${property.propertyId} scenario "${scenario.scenario}" declares Locale ` +
            `"${known.locale}" but the verdict records "${locale}"`,
        );
      }
      return {
        scenario: scenario.scenario,
        ...(locale === undefined ? {} : { locale }),
        status: scenario.status,
        reason: scenario.reason,
        sampleCount: scenario.sampleCount,
        citations: unique(scenario.citations),
      };
    });
    return {
      propertyId: property.propertyId,
      family: property.family,
      status: property.status,
      reason: property.reason,
      sampleCount: property.sampleCount,
      citations,
      gaps: unique(property.gaps ?? []),
      scenarios: scenarioRows,
    };
  });
}

function assertVendorBuilds(builds: readonly VendorBuild[]): VendorBuild[] {
  const seen = new Set<string>();
  for (const build of builds) {
    if (!(VENDOR_LEGS as readonly string[]).includes(build.leg)) {
      refuse("unknown-vendor-leg", `vendor leg "${String(build.leg)}" is not a recorded leg`);
    }
    if (seen.has(build.leg)) {
      refuse("duplicate-vendor-leg", `vendor leg "${build.leg}" is recorded twice`);
    }
    seen.add(build.leg);
    if (build.buildId.trim() === "" || build.buildId === "unknown") {
      refuse(
        "invalid-vendor-builds",
        `vendor leg "${build.leg}" has no build id; an unrecorded build refuses the run (RR-03)`,
      );
    }
  }
  for (const leg of REQUIRED_VENDOR_LEGS) {
    if (!seen.has(leg)) {
      refuse(
        "missing-vendor-build",
        `vendor leg "${leg}" has no recorded build; the certificate would describe a vendor ` +
          "nobody can reproduce (RR-03)",
      );
    }
  }
  return builds.map((build) => ({
    leg: build.leg,
    vendor: build.vendor,
    model: build.model,
    buildId: build.buildId,
  }));
}

function assertResidualRisks(ids: readonly string[]): string[] {
  const uniqueIds = unique(ids);
  if (uniqueIds.length === 0) {
    refuse("invalid-residual-risks", "the certificate cites no residual risk id");
  }
  for (const id of uniqueIds) {
    if (knownResidualRisk(id) === undefined) {
      refuse(
        "unknown-residual-risk",
        `residual risk "${id}" is not in the register (docs/agents/demo-verification.md)`,
      );
    }
  }
  const missing = OPEN_RESIDUAL_RISK_IDS.filter((id) => !uniqueIds.includes(id));
  if (missing.length > 0) {
    refuse(
      "missing-residual-risk",
      `the certificate omits open residual risks ${missing.join(", ")}; an omitted risk is a ` +
        "false green",
    );
  }
  return uniqueIds;
}

function eligibilityOf(run: RunVerdict): CertificateEligibility {
  return { eligible: run.eligibility.eligible, reasons: unique(run.eligibility.reasons) };
}

/**
 * Build the certificate for one run. The result is validated before it is
 * returned, so an invalid claim is a named refusal at its source.
 */
export function buildCertificate(input: CertificateBuildInput): Certificate {
  assertPlan(input);
  assertRunMatchesContract(input);
  if (!(CERTIFICATE_TARGETS as readonly string[]).includes(input.target)) {
    refuse("unknown-target", `target "${String(input.target)}" is not a certificate target`);
  }

  const scenarios = assertCorpus(input);
  const coverage = buildCoverage(input, scenarios);
  const properties = buildProperties(input.run, scenarios);
  const eligibility = eligibilityOf(input.run);
  const runFailures = unique(input.run.failures);
  const vendorBuilds = assertVendorBuilds(input.vendorBuilds);
  const residualRiskIds = assertResidualRisks(input.residualRiskIds);
  const panel = input.panel ?? null;

  const verdict = deriveCertificateVerdict({
    eligibility,
    properties,
    runFailures,
    coverage,
    panel,
  });

  const certificate: Certificate = {
    schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    runId: input.run.runId,
    target: input.target,
    code: {
      fingerprint: { ...input.codeFingerprint },
      appBuild: input.appBuild,
      pipelineImage: input.pipelineImage,
    },
    corpus: {
      version: input.corpus.version,
      sha256: input.corpus.fingerprint,
    },
    vendorBuilds,
    plan: { mode: input.plan.mode, repetitions: input.plan.repetitions },
    coverage,
    properties,
    eligibility,
    runFailures,
    cost: { usd: input.cost.usd, callCount: input.cost.callCount },
    residualRiskIds,
    panel:
      panel === null
        ? null
        : {
            sessionId: panel.sessionId,
            reviewer: panel.reviewer,
            signedAt: panel.signedAt,
            signature: panel.signature,
          },
    verdict,
    pass: verdict === "certified",
  };

  return validateCertificate(certificate);
}

/** A helper for callers that hold a Locale string; the schema refuses the rest. */
export function certificateLocale(value: string): Locale {
  if (!(LOCALES as readonly string[]).includes(value)) {
    refuse("locale-mismatch", `Locale "${value}" is not one of ${LOCALES.join(", ")}`);
  }
  return value as Locale;
}
