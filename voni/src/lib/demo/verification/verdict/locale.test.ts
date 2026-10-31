import test from "node:test";
import assert from "node:assert/strict";

import { loadContract, type Contract } from "../contract";
import {
  DEFAULT_CORPUS_DIR,
  LOCALE_CORE_LOCALES,
  LOCALE_CORE_RULES,
  loadCorpus,
  localeCoreScenarioName,
  type Corpus,
  type LocaleCoreLocale,
} from "../scenarios";
import {
  LOCALE_UNDERSTANDING_RESIDUAL_RISK,
  judgeLocaleMatrix,
  judgeLocaleUnderstanding,
  type NativeReviewerSignoff,
} from "./locale";
import type { BarBinding, CallEligibilityFact, PropertyMeasurement } from "./types";

type DraftEvidence = {
  propertyId: string;
  bars: readonly BarBinding[];
  measurements: PropertyMeasurement[];
};

type DraftLocale = {
  locale: LocaleCoreLocale;
  evidence: DraftEvidence[];
  calls: CallEligibilityFact[];
};

/**
 * Ticket 16's verdict half: a Locale is judged from its own twelve calls only.
 *
 * The evidence below is synthetic at the public seam (a property measurement
 * with its Locale), because the adapters that capture real transcripts and WAVs
 * are later tickets. What is under test here is the matrix rule: a complete
 * Locale becomes `certified`, a borrowed or missing measurement is refused, and
 * an understanding claim without a named native reviewer is `pending-human`
 * with RR-02, never a pass.
 */

async function corpus(): Promise<Corpus> {
  const contract = await loadContract();
  return loadCorpus({
    dir: DEFAULT_CORPUS_DIR,
    knownProperties: contract.properties.map((property) => property.id),
  });
}

/** One complete Locale at the contract's own repetition counts. */
function evidenceFor(
  contract: Contract,
  locale: LocaleCoreLocale,
  options: { readonly drop?: { scenario: string; property: string; repetition: number } } = {},
): DraftEvidence[] {
  const byProperty = new Map<string, DraftEvidence>();
  for (const rule of LOCALE_CORE_RULES) {
    const scenario = localeCoreScenarioName(rule.slug, locale);
    for (const propertyId of rule.properties) {
      const property = contract.properties.find((entry) => entry.id === propertyId);
      assert.ok(property, `the contract has no ${propertyId}`);
      const bars = property.thresholds.map((threshold) => ({
        key: threshold.key,
        statistic: threshold.key.toLowerCase().includes("min") ? ("min" as const) : ("max" as const),
        comparison: threshold.key.toLowerCase().includes("min")
          ? ("at-least" as const)
          : ("at-most" as const),
      }));
      const sample = bars.some((bar) => bar.comparison === "at-least") ? 1 : 0;
      const existing = byProperty.get(propertyId) ?? { propertyId, bars, measurements: [] };
      for (let repetition = 1; repetition <= property.repetitions; repetition += 1) {
        if (
          options.drop?.scenario === scenario &&
          options.drop.property === propertyId &&
          options.drop.repetition === repetition
        ) {
          continue;
        }
        existing.measurements.push({
          propertyId,
          scenario,
          repetition,
          locale,
          outcome: "measured",
          samples: property.bar.numeric ? [sample] : [],
          ...(property.bar.numeric ? {} : { passed: true }),
          citations: [`turn:${scenario}:${repetition}`],
        });
      }
      byProperty.set(propertyId, existing);
    }
  }
  return [...byProperty.values()];
}

function callsFor(loaded: Corpus, locale: LocaleCoreLocale, repetitions = 1): CallEligibilityFact[] {
  return LOCALE_CORE_RULES.flatMap((rule) =>
    Array.from({ length: repetitions }, (_, index) => ({
      callId: `${locale}-${rule.slug}-${index + 1}`,
      scenario: localeCoreScenarioName(rule.slug, locale),
    })),
  );
}

function allEvidence(contract: Contract, loaded: Corpus, repetitions = 1): DraftLocale[] {
  return LOCALE_CORE_LOCALES.map((locale) => ({
    locale,
    evidence: evidenceFor(contract, locale),
    calls: callsFor(loaded, locale, repetitions),
  }));
}

function signoff(locale: LocaleCoreLocale): NativeReviewerSignoff {
  return {
    locale,
    reviewer: `reviewer-${locale}`,
    signedAt: "2026-10-31",
    sampleId: `sample-${locale}`,
    goldLabelId: `gold-${locale}`,
  };
}

test("RR-02 is the one named residual risk a Locale understanding claim can carry", () => {
  assert.equal(LOCALE_UNDERSTANDING_RESIDUAL_RISK, "RR-02");
});

test("a Locale with no named native reviewer is unverified and cites RR-02", async () => {
  const loaded = await corpus();
  const contract = await loadContract();
  const verdict = judgeLocaleMatrix({
    contract,
    corpus: loaded,
    repetitions: 1,
    evidence: allEvidence(contract, loaded),
    signoffs: [],
  });
  assert.equal(verdict.verdict, "pending-human");
  assert.equal(verdict.certifiable, false);
  for (const locale of verdict.locales) {
    assert.equal(locale.understanding.status, "unverified");
    assert.deepEqual(locale.residualRisks, ["RR-02"]);
    assert.match(locale.detail, /RR-02/);
  }
  assert.deepEqual(verdict.residualRisks, ["RR-02"]);
});

test("a named native reviewer per Locale lets every Locale certify on its own calls", async () => {
  const loaded = await corpus();
  const contract = await loadContract();
  const verdict = judgeLocaleMatrix({
    contract,
    corpus: loaded,
    repetitions: 1,
    evidence: allEvidence(contract, loaded),
    signoffs: LOCALE_CORE_LOCALES.map(signoff),
  });
  assert.equal(verdict.verdict, "certified");
  assert.equal(verdict.certifiable, true);
  for (const locale of verdict.locales) {
    assert.equal(locale.verdict, "certified");
    assert.equal(locale.understanding.status, "native-certified");
    assert.deepEqual(locale.residualRisks, []);
    assert.equal(locale.outOfScopePropertyIds.includes("H1"), true, "a Locale report names what it did not measure");
  }
});

test("one Locale's failed bar never turns another Locale red or green", async () => {
  const loaded = await corpus();
  const contract = await loadContract();
  const evidence = allEvidence(contract, loaded);
  const spanish = evidence.find((entry) => entry.locale === "es");
  assert.ok(spanish);
  const t1 = spanish.evidence.find((entry) => entry.propertyId === "T1");
  assert.ok(t1);
  t1.measurements = t1.measurements.map((measurement) => ({ ...measurement, samples: [9_999] }));
  const verdict = judgeLocaleMatrix({
    contract,
    corpus: loaded,
    repetitions: 1,
    evidence,
    signoffs: LOCALE_CORE_LOCALES.map(signoff),
  });
  const spanishRow = verdict.locales.find((entry) => entry.locale === "es");
  const frenchRow = verdict.locales.find((entry) => entry.locale === "fr");
  assert.equal(spanishRow?.verdict, "not-demo-ready");
  assert.equal(spanishRow?.failedPropertyIds.includes("T1"), true);
  assert.equal(frenchRow?.verdict, "certified");
  assert.equal(verdict.verdict, "not-demo-ready");
  assert.equal(verdict.certifiable, false);
});

test("one Locale's sign-off never certifies another", async () => {
  const loaded = await corpus();
  const contract = await loadContract();
  const verdict = judgeLocaleMatrix({
    contract,
    corpus: loaded,
    repetitions: 1,
    evidence: allEvidence(contract, loaded),
    signoffs: [signoff("es")],
  });
  assert.equal(verdict.verdict, "pending-human");
  const spanish = verdict.locales.find((entry) => entry.locale === "es");
  const french = verdict.locales.find((entry) => entry.locale === "fr");
  assert.equal(spanish?.understanding.status, "native-certified");
  assert.equal(french?.understanding.status, "unverified");
  assert.deepEqual(french?.residualRisks, ["RR-02"]);
});

test("a missing measurement fails the Locale by scenario, property and repetition", async () => {
  const loaded = await corpus();
  const contract = await loadContract();
  const evidence = allEvidence(contract, loaded);
  const spanish = evidence.find((entry) => entry.locale === "es");
  assert.ok(spanish);
  spanish.evidence = evidenceFor(contract, "es", {
    drop: { scenario: "locale-golden-flow-es", property: "T1", repetition: 2 },
  });
  const verdict = judgeLocaleMatrix({
    contract,
    corpus: loaded,
    repetitions: 1,
    evidence,
    signoffs: LOCALE_CORE_LOCALES.map(signoff),
  });
  assert.equal(verdict.verdict, "ineligible");
  const locale = verdict.locales.find((entry) => entry.locale === "es");
  assert.equal(locale?.verdict, "ineligible");
  assert.match(locale?.detail ?? "", /locale-golden-flow-es/);
  assert.match(locale?.detail ?? "", /T1/);
  assert.match(locale?.detail ?? "", /repetition 2/);
});

test("a Locale cannot borrow another Locale's measurement", async () => {
  const loaded = await corpus();
  const contract = await loadContract();
  const evidence = allEvidence(contract, loaded);
  const spanish = evidence.find((entry) => entry.locale === "es");
  assert.ok(spanish);
  for (const property of spanish.evidence) {
    property.measurements = property.measurements.map((measurement) => ({
      ...measurement,
      locale: "fr",
    }));
  }
  const verdict = judgeLocaleMatrix({
    contract,
    corpus: loaded,
    repetitions: 1,
    evidence,
    signoffs: LOCALE_CORE_LOCALES.map(signoff),
  });
  assert.equal(verdict.verdict, "ineligible");
  const locale = verdict.locales.find((entry) => entry.locale === "es");
  assert.match(locale?.detail ?? "", /fr/);
  assert.match(locale?.detail ?? "", /borrow|Locale/i);
});

test("a Locale with a missing call or a missing Locale evidence is ineligible, never skipped", async () => {
  const loaded = await corpus();
  const contract = await loadContract();
  const evidence = allEvidence(contract, loaded);
  const german = evidence.find((entry) => entry.locale === "de");
  assert.ok(german);
  german.calls = german.calls.slice(1);
  const verdict = judgeLocaleMatrix({
    contract,
    corpus: loaded,
    repetitions: 1,
    evidence,
    signoffs: LOCALE_CORE_LOCALES.map(signoff),
  });
  assert.equal(verdict.verdict, "ineligible");
  const germanRow = verdict.locales.find((entry) => entry.locale === "de");
  assert.equal(germanRow?.verdict, "ineligible");
  assert.match(germanRow?.detail ?? "", /locale-[a-z-]+-de|12 calls|missing/i);

  const withoutPortuguese = evidence.filter((entry) => entry.locale !== "pt");
  const second = judgeLocaleMatrix({
    contract,
    corpus: loaded,
    repetitions: 1,
    evidence: withoutPortuguese,
    signoffs: LOCALE_CORE_LOCALES.map(signoff),
  });
  assert.equal(second.verdict, "ineligible");
  assert.match(second.detail, /pt/);
});

test("an unverified understanding is reported even when conduct and timing pass", async () => {
  const understanding = judgeLocaleUnderstanding("pt", []);
  assert.equal(understanding.status, "unverified");
  assert.equal(understanding.residualRisk, "RR-02");
  assert.match(understanding.detail, /native reviewer/i);
});

test("a role name is not a named native reviewer", async () => {
  const authority = judgeLocaleUnderstanding("de", [
    { ...signoff("de"), reviewer: "owner" },
  ]);
  assert.equal(authority.status, "unverified");
  assert.equal(authority.residualRisk, "RR-02");
  assert.match(authority.detail, /named person|role/i);
});

test("a malformed sign-off is unverified rather than a pass", async () => {
  const malformed = judgeLocaleUnderstanding("fr", [
    { ...signoff("fr"), signedAt: "not-a-date" },
  ]);
  assert.equal(malformed.status, "unverified");
  assert.equal(malformed.residualRisk, "RR-02");
});
