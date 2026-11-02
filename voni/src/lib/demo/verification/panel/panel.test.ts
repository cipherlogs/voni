/**
 * The panel gate: H1-H5 and H7 from synthetic gold labels, against the real
 * contract's frozen bars. H6 is not re-owned here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../contract";
import { LOCALES } from "../scenarios";
import { judgeRun, type PropertyVerdict } from "../verdict";
import { deriveCertificateVerdict } from "../certificate/derive";
import {
  applyPanelVerdict,
  judgePanel,
  type PanelGoldLabel,
  type PanelGoldLabelSet,
} from "./index";

const SESSION = "rating-" + "a".repeat(64);
const REVIEWER = "owner";
const DATE = "2026-10-31";

function label(overrides: Partial<PanelGoldLabel> = {}): PanelGoldLabel {
  return {
    sessionId: SESSION,
    callId: overrides.callId ?? `call-${Math.random().toString(16).slice(2)}`,
    itemId: overrides.itemId ?? `item-${Math.random().toString(16).slice(2)}`,
    scenario: overrides.scenario ?? "panel",
    locale: overrides.locale ?? "en",
    axes: {
      stayOnCall: 5,
      soundsHuman: 5,
      turnTaking: 5,
      understanding: 5,
      languageNaturalness: 5,
      warmth: 5,
      pacing: 5,
      ...(overrides.axes ?? {}),
    },
    humanDetected: overrides.humanDetected === undefined ? true : overrides.humanDetected,
    preference: overrides.preference === undefined ? "baseline" : overrides.preference,
    ratedAt: DATE,
  };
}

function set(labels: readonly PanelGoldLabel[]): PanelGoldLabelSet {
  return {
    sessionId: SESSION,
    runId: "run-1",
    reviewer: REVIEWER,
    signedAt: DATE,
    labels,
    digest: "d".repeat(64),
  };
}

function byLocale(perLocale: number, factory: (locale: (typeof LOCALES)[number], index: number) => PanelGoldLabel): PanelGoldLabel[] {
  const labels: PanelGoldLabel[] = [];
  for (const locale of LOCALES) {
    for (let index = 0; index < perLocale; index += 1) {
      labels.push(factory(locale, index));
    }
  }
  return labels;
}

function signature(overrides: Record<string, string> = {}) {
  return {
    sessionId: SESSION,
    reviewer: REVIEWER,
    signedAt: DATE,
    signature: "panel-v1:" + "e".repeat(64),
    ...overrides,
  };
}

function property(verdicts: readonly PropertyVerdict[], id: string): PropertyVerdict {
  const found = verdicts.find((entry) => entry.propertyId === id);
  assert.ok(found, `${id} is in the panel verdict`);
  return found;
}

test("H1 passes at 80% yes overall and no Locale below 70%, and fails each bar by name", async () => {
  const contract = await loadContract();
  const good = judgePanel(contract, {
    goldLabels: set(byLocale(2, (locale) => label({ locale }))),
    signature: null,
  });
  assert.equal(property(good, "H1").status, "PASS");
  assert.equal(property(good, "H1").sampleCount, 10);

  const lowLocale = judgePanel(contract, {
    goldLabels: set(
      byLocale(2, (locale, index) =>
        locale === "pt" && index === 0 ? label({ locale, axes: { stayOnCall: 2 } }) : label({ locale }),
      ),
    ),
    signature: null,
  });
  assert.equal(property(lowLocale, "H1").status, "FAIL");
  assert.match(property(lowLocale, "H1").detail, /pt 0\.500 < 0\.7/);

  const lowOverall = judgePanel(contract, {
    goldLabels: set(
      byLocale(2, (locale, index) =>
        index === 0 ? label({ locale, axes: { stayOnCall: 1 } }) : label({ locale }),
      ),
    ),
    signature: null,
  });
  assert.equal(property(lowOverall, "H1").status, "FAIL");
  assert.match(property(lowOverall, "H1").detail, /overall 0\.500 < 0\.8/);

  const missingLocale = judgePanel(contract, {
    goldLabels: set([label({ locale: "en" })]),
    signature: null,
  });
  assert.equal(property(missingLocale, "H1").status, "FAIL");
  assert.equal(property(missingLocale, "H1").reason, "unmeasured");
  assert.match(property(missingLocale, "H1").detail, /es, fr, de, pt/);
});

test("H2 refuses below 40 judgments per Locale and judges 40-60% only above the floor", async () => {
  const contract = await loadContract();
  const belowFloor = judgePanel(contract, {
    goldLabels: set(byLocale(2, (locale) => label({ locale }))),
    signature: null,
  });
  assert.equal(property(belowFloor, "H2").status, "FAIL");
  assert.equal(property(belowFloor, "H2").reason, "unmeasured");
  assert.match(property(belowFloor, "H2").detail, /the floor is 40 per Locale/);
  assert.equal(property(belowFloor, "H2").sampleCount, 10);

  const inRange = judgePanel(contract, {
    goldLabels: set(
      byLocale(40, (locale, index) =>
        label({ locale, humanDetected: index < 20 ? false : true }),
      ),
    ),
    signature: null,
  });
  assert.equal(property(inRange, "H2").status, "PASS");
  assert.equal(property(inRange, "H2").sampleCount, 200);
  assert.match(property(inRange, "H2").detail, /0\.500/);

  const tooHigh = judgePanel(contract, {
    goldLabels: set(
      byLocale(40, (locale, index) => label({ locale, humanDetected: index < 32 })),
    ),
    signature: null,
  });
  assert.equal(property(tooHigh, "H2").status, "FAIL");
  assert.match(property(tooHigh, "H2").detail, /0\.800/);
});

test("a one-Locale scope applies H1 and the H2 floor to that Locale only", async () => {
  const contract = await loadContract();
  const scope = ["en"] as const;
  const fortyEnglish = Array.from({ length: 40 }, (_, index) =>
    label({ locale: "en", humanDetected: index < 20 }),
  );

  const judged = judgePanel(contract, {
    goldLabels: set(fortyEnglish),
    signature: null,
    scope,
  });
  assert.equal(property(judged, "H2").status, "PASS");
  assert.equal(property(judged, "H2").sampleCount, 40);
  assert.match(property(judged, "H2").detail, /en 0\.500 \(n=40\)/);
  assert.doesNotMatch(property(judged, "H2").detail, /es|fr|de|pt/);
  assert.equal(property(judged, "H1").status, "PASS", "no missing out-of-scope Locale");

  const short = judgePanel(contract, {
    goldLabels: set(fortyEnglish.slice(0, 39)),
    signature: null,
    scope,
  });
  assert.equal(property(short, "H2").status, "FAIL");
  assert.equal(property(short, "H2").reason, "unmeasured");
  assert.match(property(short, "H2").detail, /the floor is 40 per Locale/);
  assert.equal(property(short, "H2").sampleCount, 39);

  const noEnglish = judgePanel(contract, {
    goldLabels: set(byLocale(40, (locale) => label({ locale })).filter((entry) => entry.locale !== "en")),
    signature: null,
    scope,
  });
  assert.equal(property(noEnglish, "H1").status, "FAIL");
  assert.equal(property(noEnglish, "H1").reason, "unmeasured");
  assert.match(property(noEnglish, "H1").detail, /no gold label/);
});

test("H3 requires a median of 4 and no call below 3; H4 requires median 4", async () => {
  const contract = await loadContract();
  const good = judgePanel(contract, {
    goldLabels: set(byLocale(2, (locale) => label({ locale, axes: { soundsHuman: 4, turnTaking: 4 } }))),
    signature: null,
  });
  assert.equal(property(good, "H3").status, "PASS");
  assert.equal(property(good, "H4").status, "PASS");

  const lowCall = judgePanel(contract, {
    goldLabels: set(
      byLocale(2, (locale, index) =>
        label({ locale, axes: { soundsHuman: index === 0 ? 2 : 5, turnTaking: 4 } }),
      ),
    ),
    signature: null,
  });
  assert.equal(property(lowCall, "H3").status, "FAIL");
  assert.match(property(lowCall, "H3").detail, /5 call\(s\) below 3/);

  const lowTurn = judgePanel(contract, {
    goldLabels: set(byLocale(2, (locale) => label({ locale, axes: { soundsHuman: 5, turnTaking: 3 } }))),
    signature: null,
  });
  assert.equal(property(lowTurn, "H4").status, "FAIL");
  assert.match(property(lowTurn, "H4").detail, /median 3/);
});

test("H5 uses the spec's strict '< 40%' preference bar", async () => {
  const contract = await loadContract();
  const below = judgePanel(contract, {
    goldLabels: set(
      byLocale(5, (locale, index) =>
        label({ locale, preference: index === 0 ? "agent" : "baseline" }),
      ),
    ),
    signature: null,
  });
  assert.equal(property(below, "H5").status, "PASS", "20% agent preference is below 40%");

  const atBar = judgePanel(contract, {
    goldLabels: set(
      byLocale(5, (locale, index) =>
        label({ locale, preference: index < 2 ? "agent" : "baseline" }),
      ),
    ),
    signature: null,
  });
  assert.equal(property(atBar, "H5").status, "FAIL", "exactly 40% is not < 40%");
  assert.match(property(atBar, "H5").detail, /0\.400/);
});

test("H7 is present, named and dated; unsigned is unmeasured and never certified", async () => {
  const contract = await loadContract();
  const labels = set(byLocale(2, (locale) => label({ locale })));

  const unsigned = judgePanel(contract, { goldLabels: labels, signature: null });
  assert.equal(property(unsigned, "H7").status, "FAIL");
  assert.equal(property(unsigned, "H7").reason, "unmeasured");
  assert.match(property(unsigned, "H7").detail, /pending-human/);

  const signed = judgePanel(contract, { goldLabels: labels, signature: signature() });
  assert.equal(property(signed, "H7").status, "PASS");
  assert.equal(property(signed, "H7").sampleCount, 1);

  for (const [field, value, pattern] of [
    ["reviewer", "", /no named reviewer/],
    ["signedAt", "", /not a YYYY-MM-DD/],
    ["sessionId", "rating-" + "f".repeat(64), /not the panel session/],
    ["signature", "", /no attestation/],
  ] as const) {
    const broken = judgePanel(contract, {
      goldLabels: labels,
      signature: signature({ [field]: value }),
    });
    assert.equal(property(broken, "H7").status, "FAIL", `${field} must fail H7`);
    assert.match(property(broken, "H7").detail, pattern);
  }
});

test("the panel gate owns H1-H5/H7 and leaves H6 to the judge calibration", async () => {
  const contract = await loadContract();
  const verdicts = judgePanel(contract, {
    goldLabels: set(byLocale(2, (locale) => label({ locale }))),
    signature: null,
  });
  assert.deepEqual(
    verdicts.map((entry) => entry.propertyId),
    ["H1", "H2", "H3", "H4", "H5", "H7"],
  );
});

test("the merged run takes panel failures seriously and never makes a machine failure green", async () => {
  const contract = await loadContract();
  const human = contract.properties.filter((entry) => /^H[1-7]$/.test(entry.id));
  const mini = { families: contract.families.filter((family) => family.id === "human"), properties: human };
  const base = judgeRun({ runId: "run-1", contract: mini, evidence: [] });
  assert.ok(base.properties.every((entry) => entry.status === "FAIL"));

  const panel = judgePanel(contract, {
    goldLabels: set(byLocale(2, (locale) => label({ locale }))),
    signature: signature(),
  });
  const merged = applyPanelVerdict(base, panel);
  assert.equal(merged.properties.find((entry) => entry.propertyId === "H1")?.status, "PASS");
  assert.equal(merged.properties.find((entry) => entry.propertyId === "H6")?.status, "FAIL");
  assert.equal(merged.verdict, "not-demo-ready");

  const cleanPanel = judgePanel(contract, {
    goldLabels: set(
      byLocale(40, (locale, index) =>
        label({ locale, humanDetected: index < 20 ? false : true }),
      ),
    ),
    signature: signature(),
  });

  const clean = judgeRun({
    runId: "run-1",
    contract: mini,
    evidence: [
      {
        propertyId: "H6",
        bars: [{ key: "dvJudgeKappaMin", statistic: "each", comparison: "at-least" }],
        measurements: [
          {
            propertyId: "H6",
            scenario: "calibration",
            repetition: 1,
            outcome: "measured",
            samples: [0.9],
            citations: ["judge:panel-1"],
          },
          {
            propertyId: "H6",
            scenario: "calibration",
            repetition: 2,
            outcome: "measured",
            samples: [0.9],
            citations: ["judge:panel-1"],
          },
          {
            propertyId: "H6",
            scenario: "calibration",
            repetition: 3,
            outcome: "measured",
            samples: [0.9],
            citations: ["judge:panel-1"],
          },
        ],
      },
    ],
  });
  const certified = applyPanelVerdict(clean, cleanPanel);
  assert.equal(certified.verdict, "certified");
});

test("an unsigned clean certificate is pending-human even when H7 is the only failure", async () => {
  const contract = await loadContract();
  const human = contract.properties.filter((entry) => /^H[1-7]$/.test(entry.id));
  const mini = { families: contract.families.filter((family) => family.id === "human"), properties: human };
  const run = judgeRun({
    runId: "run-1",
    contract: mini,
    evidence: [
      {
        propertyId: "H6",
        bars: [{ key: "dvJudgeKappaMin", statistic: "each", comparison: "at-least" }],
        measurements: [1, 2, 3].map((repetition) => ({
          propertyId: "H6",
          scenario: "calibration",
          repetition,
          outcome: "measured" as const,
          samples: [0.9],
          citations: ["judge:panel-1"],
        })),
      },
    ],
  });
  const unsignedPanel = judgePanel(contract, {
    goldLabels: set(
      byLocale(40, (locale, index) =>
        label({ locale, humanDetected: index < 20 ? false : true }),
      ),
    ),
    signature: null,
  });
  const merged = applyPanelVerdict(run, unsignedPanel);
  const certificateProperties = merged.properties.map((entry) => ({
    propertyId: entry.propertyId,
    family: entry.family,
    status: entry.status,
    reason: entry.reason,
    sampleCount: entry.sampleCount,
    citations: entry.citations,
    gaps: entry.gaps,
    scenarios: [],
  }));
  const verdict = deriveCertificateVerdict({
    eligibility: { eligible: true, reasons: [] },
    properties: certificateProperties,
    runFailures: [],
    coverage: {
      expectedScenarios: 1,
      gapRows: 0,
      rows: [],
      byLocale: LOCALES.map((locale) => ({
        locale,
        expectedScenarios: 0,
        measuredScenarios: 0,
        gapRows: 0,
        status: "measured" as const,
        gap: null,
      })),
    },
    panel: null,
  });
  assert.equal(verdict, "pending-human");
});
