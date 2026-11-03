/**
 * The H1-H5/H7 gate: human-quality properties computed from the panel's gold
 * labels against the contract's frozen bars.
 *
 * These five properties are ratios, per-Locale floors, medians and a minimum
 * over the same 12-call sample; they are not one value per scenario attempt.
 * The generic per-attempt evaluator therefore cannot express them honestly (a
 * median over 0/1 samples is not a ratio), so this module is the one gate that
 * computes them. Every number still comes from the loaded contract entry; this
 * file holds no threshold.
 *
 * Fail closed: an absent in-scope Locale, an absent gold-label set, a missing
 * signature, an A/B judgment floor below 40 per in-scope Locale or an empty
 * sample is a failure, never a skip. Under a one-Locale scope the floor is the
 * same number applied to the one declared Locale: 40 judgments. Labels from a
 * Locale the scope excludes are neutral and never counted. H6 is not computed
 * here: ticket 26's calibration owns it.
 */

import { percentile } from "../../scoreboard";
import type { Contract, ContractPropertyEntry } from "../contract";
import { LOCALES, type Locale } from "../scenarios";
import type { PropertyStatus, PropertyVerdict, PropertyVerdictReason } from "../verdict";
import { PanelError } from "./errors";
import { PANEL_STAY_YES_MIN, type PanelGoldLabel, type PanelJudgementInput } from "./types";

const HUMAN_PROPERTY_IDS = ["H1", "H2", "H3", "H4", "H5", "H7"] as const;

function threshold(property: ContractPropertyEntry, key: string): number {
  const entry = property.thresholds.find((candidate) => candidate.key === key);
  if (entry === undefined) {
    throw new PanelError(
      "invalid-certificate",
      `${property.id} has no resolved threshold "${key}"; the panel cannot invent a bar`,
    );
  }
  return entry.value;
}

function humanProperties(contract: Contract): Map<string, ContractPropertyEntry> {
  const properties = new Map<string, ContractPropertyEntry>();
  for (const id of HUMAN_PROPERTY_IDS) {
    const property = contract.properties.find((candidate) => candidate.id === id);
    if (property === undefined) {
      throw new PanelError(
        "missing-panel-property",
        `the contract has no human property "${id}"; the panel cannot complete a contract that ` +
          "does not ask for it",
      );
    }
    properties.set(id, property);
  }
  return properties;
}

function assertGoldLabels(input: PanelJudgementInput): void {
  const { goldLabels } = input;
  if (typeof goldLabels !== "object" || goldLabels === null) {
    throw new PanelError("missing-labels", "the panel gate was handed no gold-label set");
  }
  if (goldLabels.sessionId.trim() === "" || goldLabels.reviewer.trim() === "") {
    throw new PanelError(
      "invalid-session",
      "the gold-label set has no session id or reviewer; a panel label is never anonymous",
    );
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(goldLabels.signedAt) ||
    Number.isNaN(Date.parse(goldLabels.signedAt))
  ) {
    throw new PanelError(
      "missing-signature-date",
      `the gold-label set's date "${goldLabels.signedAt}" is not YYYY-MM-DD`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(goldLabels.digest)) {
    throw new PanelError(
      "invalid-session",
      "the gold-label set carries no sha256 digest; the labels a signature covers are pinned",
    );
  }
  if (goldLabels.labels.length === 0) {
    throw new PanelError("missing-labels", "the gold-label set carries no label");
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function citation(sessionId: string, label: PanelGoldLabel): string {
  return `panel:${sessionId}#${label.itemId}`;
}

function base(property: ContractPropertyEntry): Omit<PropertyVerdict, "status" | "reason" | "detail"> {
  return {
    propertyId: property.id,
    family: property.family,
    statement: property.statement,
    bar: property.bar.text,
    barNumeric: property.bar.numeric,
    kind: property.kind,
    evidence: property.evidence,
    sampleCount: 0,
    requiredRepetitions: property.repetitions,
    smallSample: false,
    summary: null,
    scenarios: [],
    checks: [],
    citations: [],
    gaps: property.gaps ?? [],
  };
}

function verdict(
  property: ContractPropertyEntry,
  input: {
    status: PropertyStatus;
    reason: PropertyVerdictReason;
    detail: string;
    sampleCount: number;
    citations: readonly string[];
    gaps?: readonly string[];
  },
): PropertyVerdict {
  return {
    ...base(property),
    status: input.status,
    reason: input.reason,
    detail: input.detail,
    sampleCount: input.sampleCount,
    citations: unique(input.citations),
    gaps: unique([...(property.gaps ?? []), ...(input.gaps ?? [])]),
  };
}

function unmeasured(
  property: ContractPropertyEntry,
  detail: string,
  citations: readonly string[],
  gaps: readonly string[] = [],
  sampleCount = 0,
): PropertyVerdict {
  return verdict(property, {
    status: "FAIL",
    reason: "unmeasured",
    detail,
    sampleCount,
    citations,
    gaps,
  });
}

function belowBar(
  property: ContractPropertyEntry,
  detail: string,
  sampleCount: number,
  citations: readonly string[],
  gaps: readonly string[] = [],
): PropertyVerdict {
  return verdict(property, {
    status: "FAIL",
    reason: "below-bar",
    detail,
    sampleCount,
    citations,
    gaps,
  });
}

function passed(
  property: ContractPropertyEntry,
  detail: string,
  sampleCount: number,
  citations: readonly string[],
): PropertyVerdict {
  return verdict(property, {
    status: "PASS",
    reason: "pass",
    detail,
    sampleCount,
    citations,
  });
}

function labelsFor(locale: Locale, labels: readonly PanelGoldLabel[]): PanelGoldLabel[] {
  return labels.filter((label) => label.locale === locale);
}

/** The Locales the certificate declares; omitted means every demo Locale. */
function scopeLocales(input: PanelJudgementInput): readonly Locale[] {
  const scope = input.scope;
  if (scope === undefined) return LOCALES;
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new PanelError(
      "invalid-scope",
      "the panel was handed an empty certification scope; a certificate is a claim about at " +
        "least one Locale",
    );
  }
  const seen = new Set<Locale>();
  for (const locale of scope) {
    if (!(LOCALES as readonly string[]).includes(locale)) {
      throw new PanelError("invalid-scope", `the panel scope names unknown Locale "${String(locale)}"`);
    }
    if (seen.has(locale)) {
      throw new PanelError("invalid-scope", `the panel scope records Locale "${locale}" twice`);
    }
    seen.add(locale);
  }
  return LOCALES.filter((locale) => seen.has(locale));
}

/** The labels that belong to the declared scope; the rest are neutral. */
function scopedLabels(input: PanelJudgementInput): PanelGoldLabel[] {
  const locales = scopeLocales(input);
  return input.goldLabels.labels.filter((label) => locales.includes(label.locale));
}

function median(values: readonly number[]): number | null {
  return percentile([...values], 50);
}

/** H1: >= 80% yes overall and no Locale below 70%. */
function h1(property: ContractPropertyEntry, input: PanelJudgementInput): PropertyVerdict {
  const locales = scopeLocales(input);
  const labels = scopedLabels(input);
  const citations = labels.map((label) => citation(label.sessionId, label));
  if (labels.length === 0) {
    return unmeasured(property, "H1: the panel carries no gold label; an unmeasured property fails", []);
  }
  const missing = locales.filter((locale) => labelsFor(locale, labels).length === 0);
  if (missing.length > 0) {
    return unmeasured(
      property,
      `H1: no panel label for Locale(s) ${missing.join(", ")}; a Locale without a label is unmeasured`,
      citations,
    );
  }
  const overallBar = threshold(property, "dvStayOnCallYesMinRatio");
  const localeBar = threshold(property, "dvStayOnCallLocaleMinRatio");
  const yes = (label: PanelGoldLabel): boolean =>
    (label.axes.stayOnCall ?? 0) >= PANEL_STAY_YES_MIN;
  const overall = labels.filter(yes).length / labels.length;
  const byLocale = locales.map((locale) => {
    const group = labelsFor(locale, labels);
    const ratio = group.filter(yes).length / group.length;
    return { locale, ratio, count: group.length };
  });
  const low = byLocale.filter((entry) => entry.ratio < localeBar);
  const detail =
    `H1: yes ${overall.toFixed(3)} (bar ${overallBar}) over ${labels.length} labels; ` +
    byLocale.map((entry) => `${entry.locale} ${entry.ratio.toFixed(3)} (n=${entry.count})`).join(", ");
  if (overall < overallBar || low.length > 0) {
    return belowBar(
      property,
      `${detail}; below bar: ${[
        ...(overall < overallBar ? [`overall ${overall.toFixed(3)} < ${overallBar}`] : []),
        ...low.map((entry) => `${entry.locale} ${entry.ratio.toFixed(3)} < ${localeBar}`),
      ].join(", ")}`,
      labels.length,
      citations,
      ["H1 yes is the 4-5 band of the five-point stay axis (spec bar is binary)."],
    );
  }
  return passed(property, detail, labels.length, citations);
}

/** H2: 40-60% human detection per Locale, with at least 40 judgments per Locale. */
function h2(property: ContractPropertyEntry, input: PanelJudgementInput): PropertyVerdict {
  const locales = scopeLocales(input);
  const ab = scopedLabels(input).filter((label) => label.humanDetected !== null);
  const citations = ab.map((label) => citation(label.sessionId, label));
  if (ab.length === 0) {
    return unmeasured(
      property,
      "H2: the panel carries no blind A/B judgment; there is no baseline to compare against",
      [],
    );
  }
  const minRatio = threshold(property, "dvHumanDetectionMinRatio");
  const maxRatio = threshold(property, "dvHumanDetectionMaxRatio");
  const minJudgments = threshold(property, "dvHumanDetectionMinJudgments");
  const byLocale = locales.map((locale) => {
    const group = labelsFor(locale, ab);
    const detected = group.filter((label) => label.humanDetected === true).length;
    return {
      locale,
      count: group.length,
      ratio: group.length === 0 ? null : detected / group.length,
    };
  });
  const short = byLocale.filter((entry) => entry.count < minJudgments);
  const detail =
    `H2: ${ab.length} A/B judgments; ` +
    byLocale
      .map((entry) =>
        entry.ratio === null
          ? `${entry.locale} no judgments`
          : `${entry.locale} ${entry.ratio.toFixed(3)} (n=${entry.count})`,
      )
      .join(", ");
  if (short.length > 0) {
    return unmeasured(
      property,
      `H2: one panel session exports ${ab.length} A/B judgments; the floor is ` +
        `${minJudgments} per Locale (short: ` +
        `${short.map((entry) => `${entry.locale} (${entry.count})`).join(", ")}). ` +
        `${detail}; below-bar agreement is unverified, which is a failure (RR-10: no merge path ` +
        "accumulates a later session's labels; the owner decides whether the floor or the " +
        "accumulation changes)",
      citations,
      [
        `RR-10: one panel session exports ${ab.length} A/B judgments; the floor is ` +
          `${minJudgments} per Locale. No merge path accumulates a later session's labels; the ` +
          "owner decides whether the floor or the accumulation changes.",
      ],
      ab.length,
    );
  }
  const outside = byLocale.filter(
    (entry) => entry.ratio !== null && (entry.ratio < minRatio || entry.ratio > maxRatio),
  );
  if (outside.length > 0) {
    return belowBar(
      property,
      `${detail}; outside ${minRatio}-${maxRatio}: ` +
        outside
          .map((entry) => `${entry.locale} ${entry.ratio?.toFixed(3) ?? "n/a"}`)
          .join(", "),
      ab.length,
      citations,
    );
  }
  return passed(property, detail, ab.length, citations);
}

/** H3: median >= 4 and no call below 3. */
function h3(property: ContractPropertyEntry, input: PanelJudgementInput): PropertyVerdict {
  const labels = scopedLabels(input);
  const scores = labels.map((label) => label.axes.soundsHuman ?? 0);
  const citations = labels.map((label) => citation(label.sessionId, label));
  const medianBar = threshold(property, "dvSoundsHumanMedianMin");
  const callBar = threshold(property, "dvSoundsHumanCallMin");
  if (scores.length === 0) {
    return unmeasured(property, "H3: the panel carries no sounds-human rating", []);
  }
  const middle = median(scores);
  const low = labels.filter((label) => (label.axes.soundsHuman ?? 0) < callBar);
  const detail =
    `H3: median ${middle ?? "n/a"} (bar ${medianBar}), minimum ${Math.min(...scores)} ` +
    `(bar ${callBar}) over ${scores.length} labels`;
  if (middle === null || middle < medianBar || low.length > 0) {
    return belowBar(
      property,
      `${detail}; ${low.length} call(s) below ${callBar}: ` +
        low.map((label) => label.itemId).join(", "),
      scores.length,
      citations,
    );
  }
  return passed(property, detail, scores.length, citations);
}

/** H4: median turn-taking rating >= 4. */
function h4(property: ContractPropertyEntry, input: PanelJudgementInput): PropertyVerdict {
  const labels = scopedLabels(input);
  const scores = labels.map((label) => label.axes.turnTaking ?? 0);
  const citations = labels.map((label) => citation(label.sessionId, label));
  const medianBar = threshold(property, "dvTurnTakingMedianMin");
  if (scores.length === 0) {
    return unmeasured(property, "H4: the panel carries no turn-taking rating", []);
  }
  const middle = median(scores);
  const detail = `H4: median ${middle ?? "n/a"} (bar ${medianBar}) over ${scores.length} labels`;
  if (middle === null || middle < medianBar) {
    return belowBar(property, detail, scores.length, citations);
  }
  return passed(property, detail, scores.length, citations);
}

/** H5: agent not preferred < 40%. The spec's operator is strict. */
function h5(property: ContractPropertyEntry, input: PanelJudgementInput): PropertyVerdict {
  const ab = scopedLabels(input).filter((label) => label.preference !== null);
  const citations = ab.map((label) => citation(label.sessionId, label));
  const maxRatio = threshold(property, "dvAgentNotPreferredMaxRatio");
  if (ab.length === 0) {
    return unmeasured(
      property,
      "H5: the panel carries no A/B preference; there is no baseline to compare against",
      [],
    );
  }
  const agent = ab.filter((label) => label.preference === "agent").length;
  const ratio = agent / ab.length;
  const detail =
    `H5: agent preferred ${ratio.toFixed(3)} (bar < ${maxRatio}) over ${ab.length} A/B preferences`;
  if (!(ratio < maxRatio)) {
    return belowBar(property, detail, ab.length, citations, [
      "H5 uses the spec's strict '< 40%' operator; exactly 40% fails.",
    ]);
  }
  return passed(property, detail, ab.length, citations);
}

/** H7: the panel signature is present, named and dated. */
function h7(property: ContractPropertyEntry, input: PanelJudgementInput): PropertyVerdict {
  const signature = input.signature;
  if (signature === null) {
    return unmeasured(
      property,
      "H7: the panel signature is absent; the certificate is pending-human, never certified",
      [],
    );
  }
  const citations = [`panel:signature:${signature.sessionId}`];
  if (signature.sessionId !== input.goldLabels.sessionId) {
    return belowBar(
      property,
      `H7: the signature names session "${signature.sessionId}", not the panel session ` +
        `"${input.goldLabels.sessionId}"`,
      1,
      citations,
    );
  }
  if (signature.reviewer.trim() === "") {
    return belowBar(property, "H7: the signature has no named reviewer", 1, citations);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signature.signedAt) || Number.isNaN(Date.parse(signature.signedAt))) {
    return belowBar(
      property,
      `H7: the signature date "${signature.signedAt}" is not a YYYY-MM-DD date`,
      1,
      citations,
    );
  }
  if (signature.signature.trim() === "") {
    return belowBar(property, "H7: the signature carries no attestation", 1, citations);
  }
  return passed(
    property,
    `H7: session ${signature.sessionId} signed by ${signature.reviewer} on ${signature.signedAt}`,
    1,
    citations,
  );
}

/**
 * Compute H1-H5 and H7 for one certificate from the panel's gold labels. The
 * contract supplies every statement and bar; the gold labels and the signature
 * supply every measurement.
 */
export function judgePanel(contract: Contract, input: PanelJudgementInput): PropertyVerdict[] {
  assertGoldLabels(input);
  const properties = humanProperties(contract);
  return [
    h1(properties.get("H1")!, input),
    h2(properties.get("H2")!, input),
    h3(properties.get("H3")!, input),
    h4(properties.get("H4")!, input),
    h5(properties.get("H5")!, input),
    h7(properties.get("H7")!, input),
  ];
}
