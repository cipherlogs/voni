/**
 * The Locale matrix: four Locales judged independently, and the one claim an
 * agent may never make — that a non-English Locale understands its callers —
 * held open as RR-02 until a named native reviewer signs.
 *
 * A Locale's verdict reads only its own evidence. A measurement recorded under
 * another Locale, a scenario from another Locale's core, a missing call or a
 * missing repetition is `ineligible`; it is never filled from a neighbour's
 * green. Conduct and timing can pass on the machine evidence; understanding
 * cannot, so a Locale with no reviewer is `pending-human`, not `certified`, and
 * names RR-02 on its own row.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Scenario corpus and Locale
 * matrix"; RR-02 in `docs/agents/demo-verification.md`.
 */

import type { Contract } from "../contract";
import {
  LOCALE_CORE_LOCALES,
  LOCALE_CORE_RULES,
  localeCoreContract,
  localeCorePlan,
  localeCoreScenarioName,
  type Corpus,
  type LocaleCoreLocale,
} from "../scenarios";
import { judgeRun } from "./judge";
import type {
  CallEligibilityFact,
  PropertyEvidence,
  PropertyMeasurement,
  PropertyVerdict,
  RunVerdictValue,
} from "./types";

/** The register id a Locale understanding claim carries while unverified. */
export const LOCALE_UNDERSTANDING_RESIDUAL_RISK = "RR-02" as const;

/** Role words are not people; a signature names a named human. */
const ROLE_WORDS = new Set(["owner", "operator", "engineer", "panel", "reviewer", "team"]);

/**
 * The owner's record that a native speaker reviewed one Locale's understanding
 * sample. It is evidence of a human act, so every field is required and a
 * malformed record is unverified, never a pass.
 */
export type NativeReviewerSignoff = {
  readonly locale: LocaleCoreLocale;
  /** The reviewer's name, not an account or a role. */
  readonly reviewer: string;
  /** The date the reviewer signed, ISO `YYYY-MM-DD`. */
  readonly signedAt: string;
  /** The understanding sample the review covers. */
  readonly sampleId: string;
  /** The gold-label record the sign-off created. */
  readonly goldLabelId: string;
};

export type LocaleUnderstandingVerdict = {
  readonly locale: LocaleCoreLocale;
  readonly status: "native-certified" | "unverified";
  readonly residualRisk: typeof LOCALE_UNDERSTANDING_RESIDUAL_RISK | null;
  readonly reviewer: string | null;
  readonly signedAt: string | null;
  readonly detail: string;
};

/** One Locale's evidence, labelled by the Locale it belongs to. */
export type LocaleEvidence = {
  readonly locale: LocaleCoreLocale;
  readonly evidence: readonly PropertyEvidence[];
  /** One call per scenario per repetition; a missing call is a shortfall. */
  readonly calls: readonly CallEligibilityFact[];
};

export type LocaleVerdictValue = "certified" | "not-demo-ready" | "ineligible" | "pending-human";

export type LocaleVerdict = {
  readonly locale: LocaleCoreLocale;
  readonly verdict: LocaleVerdictValue;
  readonly certifiable: boolean;
  /** Conduct, timing and content from this Locale's own calls. */
  readonly runVerdict: RunVerdictValue;
  readonly understanding: LocaleUnderstandingVerdict;
  readonly properties: readonly PropertyVerdict[];
  readonly failedPropertyIds: readonly string[];
  readonly outOfScopePropertyIds: readonly string[];
  /** Named risks this Locale carries; RR-02 while understanding is unverified. */
  readonly residualRisks: readonly string[];
  readonly calls: number;
  readonly detail: string;
};

export type LocaleMatrixVerdict = {
  readonly verdict: LocaleVerdictValue;
  readonly certifiable: boolean;
  readonly locales: readonly LocaleVerdict[];
  readonly residualRisks: readonly string[];
  readonly detail: string;
};

function validSignoff(signoff: NativeReviewerSignoff): string | null {
  const reviewer = signoff.reviewer.trim();
  if (reviewer === "") return "the reviewer is unnamed";
  if (ROLE_WORDS.has(reviewer.toLowerCase())) {
    return `"${reviewer}" is a role, not a named person`;
  }
  if (signoff.sampleId.trim() === "") return "the sign-off names no understanding sample";
  if (signoff.goldLabelId.trim() === "") return "the sign-off records no gold label";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signoff.signedAt) || !Number.isFinite(Date.parse(signoff.signedAt))) {
    return `the signed date "${signoff.signedAt}" is not an ISO date`;
  }
  return null;
}

/**
 * One Locale's understanding claim. No sign-off means unverified and RR-02;
 * a malformed sign-off is unverified too, never a pass.
 */
export function judgeLocaleUnderstanding(
  locale: LocaleCoreLocale,
  signoffs: readonly NativeReviewerSignoff[],
): LocaleUnderstandingVerdict {
  const signoff = signoffs.find((entry) => entry.locale === locale);
  if (signoff === undefined) {
    return {
      locale,
      status: "unverified",
      residualRisk: LOCALE_UNDERSTANDING_RESIDUAL_RISK,
      reviewer: null,
      signedAt: null,
      detail:
        `no named native reviewer has signed the ${locale} understanding sample; ` +
        "understanding is unverified and the Locale carries RR-02, never a green",
    };
  }
  const problem = validSignoff(signoff);
  if (problem !== null) {
    return {
      locale,
      status: "unverified",
      residualRisk: LOCALE_UNDERSTANDING_RESIDUAL_RISK,
      reviewer: null,
      signedAt: null,
      detail: `the ${locale} sign-off is not a valid human record (${problem}); unverified with RR-02`,
    };
  }
  return {
    locale,
    status: "native-certified",
    residualRisk: null,
    reviewer: signoff.reviewer.trim(),
    signedAt: signoff.signedAt,
    detail: `${signoff.reviewer.trim()} signed the ${locale} understanding sample on ${signoff.signedAt}`,
  };
}

type ExpectedMeasurement = {
  readonly scenario: string;
  readonly propertyId: string;
  readonly repetition: number;
};

function expectedMeasurements(contract: Contract, locale: LocaleCoreLocale): ExpectedMeasurement[] {
  const expected: ExpectedMeasurement[] = [];
  for (const rule of LOCALE_CORE_RULES) {
    const scenario = localeCoreScenarioName(rule.slug, locale);
    for (const propertyId of rule.properties) {
      const property = contract.properties.find((entry) => entry.id === propertyId);
      if (property === undefined) {
        // The scenario cites a property the contract no longer knows; it can
        // never be measured, so the Locale is ineligible rather than smaller.
        expected.push({ scenario, propertyId, repetition: 1 });
        continue;
      }
      for (let repetition = 1; repetition <= property.repetitions; repetition += 1) {
        expected.push({ scenario, propertyId, repetition });
      }
    }
  }
  return expected;
}

/**
 * The matrix's completeness rule: every cited property, for every scenario
 * that cites it, at every declared repetition, recorded under this Locale.
 */
function localeShortfalls(input: {
  readonly contract: Contract;
  readonly plan: ReturnType<typeof localeCorePlan>;
  readonly locale: LocaleCoreLocale;
  readonly evidence: readonly PropertyEvidence[];
  readonly calls: readonly CallEligibilityFact[];
  readonly repetitions: 1 | 3;
}): string[] {
  const problems: string[] = [];
  const scenarioNames = new Set(
    input.plan.scenarios.filter((entry) => entry.locale === input.locale).map((entry) => entry.name),
  );
  const byRule = new Map(
    LOCALE_CORE_RULES.map((rule) => [localeCoreScenarioName(rule.slug, input.locale), rule]),
  );

  const callCounts = new Map<string, number>();
  for (const call of input.calls) {
    if (!scenarioNames.has(call.scenario)) {
      problems.push(
        `a call records scenario "${call.scenario}", which is not in the ${input.locale} core`,
      );
      continue;
    }
    callCounts.set(call.scenario, (callCounts.get(call.scenario) ?? 0) + 1);
  }
  for (const scenario of scenarioNames) {
    const count = callCounts.get(scenario) ?? 0;
    if (count !== input.repetitions) {
      problems.push(
        `scenario "${scenario}" has ${count} call${count === 1 ? "" : "s"}, expected ${input.repetitions}`,
      );
    }
  }
  if (input.calls.length !== scenarioNames.size * input.repetitions) {
    problems.push(
      `the ${input.locale} Locale recorded ${input.calls.length} calls, expected ${
        scenarioNames.size * input.repetitions
      }`,
    );
  }

  const actual = new Map<string, PropertyMeasurement>();
  for (const property of input.evidence) {
    for (const measurement of property.measurements) {
      if (measurement.locale !== input.locale) {
        problems.push(
          `property ${property.propertyId} scenario "${measurement.scenario}" repetition ` +
            `${measurement.repetition} is recorded under Locale "${String(measurement.locale)}"; ` +
            `a ${input.locale} Locale cannot borrow another Locale's measurement`,
        );
        continue;
      }
      const rule = byRule.get(measurement.scenario);
      if (rule === undefined) {
        problems.push(
          `property ${property.propertyId} carries scenario "${measurement.scenario}", ` +
            `which is not in the ${input.locale} core`,
        );
        continue;
      }
      if (!rule.properties.includes(property.propertyId)) {
        // A broader run may carry extra properties; the Locale scope ignores
        // them rather than letting them stand in for a cited one.
        continue;
      }
      actual.set(`${measurement.scenario}|${property.propertyId}|${measurement.repetition}`, measurement);
    }
  }

  for (const expected of expectedMeasurements(input.contract, input.locale)) {
    const key = `${expected.scenario}|${expected.propertyId}|${expected.repetition}`;
    if (!actual.has(key)) {
      problems.push(
        `missing measurement: scenario "${expected.scenario}" property ${expected.propertyId} ` +
          `repetition ${expected.repetition}`,
      );
    }
  }
  return problems;
}

function scopedEvidence(
  contract: Contract,
  locale: LocaleCoreLocale,
  corpus: Corpus,
  evidence: readonly PropertyEvidence[],
): PropertyEvidence[] {
  const scoped = new Set(localeCoreContract(contract, corpus, locale).properties.map((entry) => entry.id));
  const scenarios = new Set(
    localeCorePlan(corpus).scenarios.filter((entry) => entry.locale === locale).map((entry) => entry.name),
  );
  return evidence
    .filter((entry) => scoped.has(entry.propertyId))
    .map((entry) => ({
      ...entry,
      measurements: entry.measurements.filter(
        (measurement) => measurement.locale === locale && scenarios.has(measurement.scenario),
      ),
    }))
    .filter((entry) => entry.measurements.length > 0);
}

function worst(values: readonly LocaleVerdictValue[]): LocaleVerdictValue {
  if (values.includes("ineligible")) return "ineligible";
  if (values.includes("not-demo-ready")) return "not-demo-ready";
  if (values.includes("pending-human")) return "pending-human";
  return "certified";
}

function judgeLocale(input: {
  readonly contract: Contract;
  readonly corpus: Corpus;
  readonly locale: LocaleCoreLocale;
  readonly entry: LocaleEvidence;
  readonly repetitions: 1 | 3;
  readonly signoffs: readonly NativeReviewerSignoff[];
}): LocaleVerdict {
  const plan = localeCorePlan(input.corpus);
  const scoped = localeCoreContract(input.contract, input.corpus, input.locale);
  const outOfScopePropertyIds = input.contract.properties
    .filter((property) => !scoped.properties.some((entry) => entry.id === property.id))
    .map((property) => property.id);
  const understanding = judgeLocaleUnderstanding(input.locale, input.signoffs);
  const shortfalls = localeShortfalls({
    contract: input.contract,
    plan,
    locale: input.locale,
    evidence: input.entry.evidence,
    calls: input.entry.calls,
    repetitions: input.repetitions,
  });

  if (shortfalls.length > 0) {
    return {
      locale: input.locale,
      verdict: "ineligible",
      certifiable: false,
      runVerdict: "ineligible",
      understanding,
      properties: [],
      failedPropertyIds: [],
      outOfScopePropertyIds,
      residualRisks: understanding.residualRisk === null ? [] : [understanding.residualRisk],
      calls: input.entry.calls.length,
      detail:
        `the ${input.locale} Locale is ineligible: ${shortfalls.length} evidence shortfall` +
        `${shortfalls.length === 1 ? "" : "s"} — ${shortfalls.slice(0, 3).join("; ")}` +
        (shortfalls.length > 3 ? `; and ${shortfalls.length - 3} more` : ""),
    };
  }

  const judged = judgeRun({
    runId: `locale-${input.locale}`,
    contract: scoped,
    evidence: scopedEvidence(input.contract, input.locale, input.corpus, input.entry.evidence),
    calls: input.entry.calls,
  });

  const failedPropertyIds = judged.failedPropertyIds;
  const verdict: LocaleVerdictValue =
    judged.verdict === "ineligible"
      ? "ineligible"
      : failedPropertyIds.length > 0 || judged.failures.length > 0
        ? "not-demo-ready"
        : understanding.status === "native-certified"
          ? "certified"
          : "pending-human";

  const detail =
    verdict === "ineligible"
      ? judged.detail
      : verdict === "not-demo-ready"
        ? judged.detail
        : verdict === "pending-human"
          ? `the ${input.locale} Locale's conduct and timing passed on its own calls, but ` +
            `understanding is unverified (${understanding.detail})`
          : `the ${input.locale} Locale certified on ${input.entry.calls.length} own call` +
            `${input.entry.calls.length === 1 ? "" : "s"}`;

  return {
    locale: input.locale,
    verdict,
    certifiable: verdict === "certified",
    runVerdict: judged.verdict,
    understanding,
    properties: judged.properties,
    failedPropertyIds,
    outOfScopePropertyIds,
    residualRisks: understanding.residualRisk === null ? [] : [understanding.residualRisk],
    calls: input.entry.calls.length,
    detail,
  };
}

/**
 * Judge the four-Locale matrix. Every Locale must be present exactly once with
 * its own complete evidence; the matrix verdict is the worst row, and the
 * certificate may call it a pass only when every row certified.
 */
export function judgeLocaleMatrix(input: {
  readonly contract: Contract;
  readonly corpus: Corpus;
  readonly repetitions: 1 | 3;
  readonly evidence: readonly LocaleEvidence[];
  readonly signoffs: readonly NativeReviewerSignoff[];
}): LocaleMatrixVerdict {
  localeCorePlan(input.corpus);
  const problems: string[] = [];
  const byLocale = new Map<LocaleCoreLocale, LocaleEvidence>();
  for (const entry of input.evidence) {
    if (!(LOCALE_CORE_LOCALES as readonly string[]).includes(entry.locale)) {
      problems.push(`evidence names Locale "${String(entry.locale)}", which is not in the Locale core`);
      continue;
    }
    if (byLocale.has(entry.locale)) {
      problems.push(`Locale "${entry.locale}" has two evidence sets; one Locale has one owner`);
      continue;
    }
    byLocale.set(entry.locale, entry);
  }
  const missing = LOCALE_CORE_LOCALES.filter((locale) => !byLocale.has(locale));
  if (missing.length > 0) {
    problems.push(`no evidence for Locale${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
  if (problems.length > 0) {
    return {
      verdict: "ineligible",
      certifiable: false,
      locales: [],
      residualRisks: [LOCALE_UNDERSTANDING_RESIDUAL_RISK],
      detail: `the Locale matrix is ineligible: ${problems.join("; ")}`,
    };
  }

  const locales = LOCALE_CORE_LOCALES.map((locale) =>
    judgeLocale({
      contract: input.contract,
      corpus: input.corpus,
      locale,
      entry: byLocale.get(locale) as LocaleEvidence,
      repetitions: input.repetitions,
      signoffs: input.signoffs,
    }),
  );
  const verdict = worst(locales.map((entry) => entry.verdict));
  const residualRisks = [...new Set(locales.flatMap((entry) => entry.residualRisks))];
  return {
    verdict,
    certifiable: verdict === "certified",
    locales,
    residualRisks,
    detail:
      verdict === "certified"
        ? `certified: all four Locales passed their own twelve calls with a named native reviewer`
        : `${verdict}: ${locales
            .filter((entry) => entry.verdict !== "certified")
            .map((entry) => `${entry.locale} ${entry.verdict}`)
            .join(", ")}`,
  };
}
