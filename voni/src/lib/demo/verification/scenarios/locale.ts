/**
 * The Locale core: twelve behaviours the demo runs in Spanish, French, German
 * and Portuguese, plus the two bounds a Locale run owes.
 *
 * The corpus is data (`corpus/locale-<slug>-<locale>/`); this module owns the
 * shape the four Locales must share. A translated scenario is the same
 * behaviour only when its class, trigger sequence, property set, soundscape and
 * fault are identical to the other Locales' version. A Locale that changed its
 * script is a named refusal, not a smaller matrix: the matrix exists so one
 * Locale's green cannot stand in for another's.
 *
 * The run ceilings are imported from the economics owner, never re-derived:
 * nightly runs the core once (48 calls), full certification three times (144).
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Scenario corpus and Locale
 * matrix"; RR-02 in `docs/agents/demo-verification.md`.
 */

import type { Contract } from "../contract";
import { preflightRunCeiling, type RunCeilingCheck, type RunKind } from "../economics";
import { ScenarioError } from "./errors";
import type { Corpus, LoadedScenario, Locale, ScenarioClass, TriggerType } from "./types";

/** The four non-English Locales the core certifies. English is the full run. */
export const LOCALE_CORE_LOCALES = ["es", "fr", "de", "pt"] as const;

export type LocaleCoreLocale = (typeof LOCALE_CORE_LOCALES)[number];

/**
 * The spec's twelve Locale-core behaviours, in its order: golden flow, golden
 * returning, backchannel, barge at a clause boundary, filler, nonsense, angry,
 * television, jitter, goodbye drain, slow tool, code switch.
 */
export const LOCALE_CORE_SLUGS = [
  "golden-flow",
  "golden-returning",
  "backchannel",
  "barge-clause",
  "filler",
  "nonsense",
  "angry",
  "television",
  "jitter",
  "goodbye-drain",
  "slow-tool",
  "code-switch",
] as const;

export type LocaleCoreSlug = (typeof LOCALE_CORE_SLUGS)[number];

export type LocaleCoreRule = {
  readonly slug: LocaleCoreSlug;
  readonly class: ScenarioClass;
  /** The exact property set every Locale's version cites; order is irrelevant. */
  readonly properties: readonly string[];
  /** The exact trigger sequence every Locale's version speaks. */
  readonly triggers: readonly TriggerType[];
  readonly soundscape: string;
  readonly fault?: "network-jitter";
};

/**
 * What "the same behaviour" means across Locales. Every Locale's version of a
 * slug must match this row exactly; a translation may change words, never the
 * measured conduct.
 */
export const LOCALE_CORE_RULES: readonly LocaleCoreRule[] = [
  {
    slug: "golden-flow",
    class: "golden-flow",
    properties: ["K5", "T1", "T2"],
    triggers: ["call-open", "agent-turn-end"],
    soundscape: "quiet-room",
  },
  {
    slug: "golden-returning",
    class: "golden-flow",
    properties: ["T2", "X10"],
    triggers: ["call-open", "agent-turn-end"],
    soundscape: "quiet-room",
  },
  {
    slug: "backchannel",
    class: "turn-taking",
    properties: ["T4"],
    triggers: ["call-open", "agent-speech-start", "agent-turn-end"],
    soundscape: "quiet-room",
  },
  {
    slug: "barge-clause",
    class: "turn-taking",
    properties: ["T3", "T6", "T7"],
    triggers: ["call-open", "agent-speech-start", "agent-turn-end"],
    soundscape: "quiet-room",
  },
  {
    slug: "filler",
    class: "turn-taking",
    properties: ["T4", "T5"],
    triggers: ["call-open", "silence", "agent-turn-end"],
    soundscape: "quiet-room",
  },
  {
    slug: "nonsense",
    class: "emotion",
    properties: ["C3", "K7"],
    triggers: ["call-open", "agent-turn-end", "agent-turn-end"],
    soundscape: "quiet-room",
  },
  {
    slug: "angry",
    class: "emotion",
    properties: ["C4", "K7"],
    triggers: ["call-open", "agent-turn-end", "agent-turn-end"],
    soundscape: "quiet-room",
  },
  {
    slug: "television",
    class: "soundscape",
    properties: ["A3", "A8"],
    triggers: ["call-open", "agent-turn-end"],
    soundscape: "television",
  },
  {
    slug: "jitter",
    class: "connectivity",
    properties: ["A6", "R1", "T7"],
    triggers: ["call-open", "agent-turn-end"],
    soundscape: "quiet-room",
    fault: "network-jitter",
  },
  {
    slug: "goodbye-drain",
    class: "ending",
    properties: ["C7", "C8", "L11", "L9"],
    triggers: ["call-open", "agent-turn-end"],
    soundscape: "quiet-room",
  },
  {
    slug: "slow-tool",
    class: "tools",
    properties: ["X1", "X2", "X3"],
    triggers: ["call-open", "agent-turn-end"],
    soundscape: "quiet-room",
  },
  {
    slug: "code-switch",
    class: "comprehension",
    properties: ["K5", "K6", "K7"],
    triggers: ["call-open", "agent-turn-end", "agent-turn-end"],
    soundscape: "quiet-room",
  },
];

/** The one directory name a behaviour has in one Locale. */
export function localeCoreScenarioName(slug: LocaleCoreSlug, locale: LocaleCoreLocale): string {
  return `locale-${slug}-${locale}`;
}

export type LocaleCorePlanEntry = {
  readonly slug: LocaleCoreSlug;
  readonly locale: LocaleCoreLocale;
  readonly name: string;
};

export type LocaleCorePlan = {
  readonly locales: readonly LocaleCoreLocale[];
  readonly scenarios: readonly LocaleCorePlanEntry[];
  /** One call per scenario at nightly; the plan ticket 30 hands the runner. */
  readonly calls: number;
};

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function refuse(code: ScenarioError["code"], message: string): never {
  throw new ScenarioError(code, message);
}

/** Validate one Locale's version of one behaviour against the shared rule. */
function checkScenario(rule: LocaleCoreRule, locale: LocaleCoreLocale, scenario: LoadedScenario): void {
  const name = localeCoreScenarioName(rule.slug, locale);
  if (scenario.name !== name) {
    refuse(
      "locale-scenario-mismatch",
      `scenario "${scenario.name}" is the ${rule.slug}/${locale} version but is not named "${name}"`,
    );
  }
  if (scenario.locale !== locale) {
    refuse(
      "locale-scenario-mismatch",
      `scenario "${name}" declares Locale "${scenario.locale}", expected "${locale}"`,
    );
  }
  if (scenario.heldOut) {
    refuse(
      "locale-scenario-mismatch",
      `scenario "${name}" is held out; a held-out scenario never joins the Locale core (RR-07)`,
    );
  }
  if (scenario.class !== rule.class) {
    refuse(
      "locale-scenario-mismatch",
      `scenario "${name}" is class "${scenario.class}", but ${rule.slug} is "${rule.class}" in every Locale`,
    );
  }
  if (!sameSet(scenario.expectedProperties, rule.properties)) {
    refuse(
      "locale-scenario-mismatch",
      `scenario "${name}" cites [${[...scenario.expectedProperties].sort().join(", ")}], ` +
        `but ${rule.slug} cites [${[...rule.properties].sort().join(", ")}] in every Locale`,
    );
  }
  const triggers = scenario.script.map((step) => step.trigger.type);
  if (triggers.length !== rule.triggers.length || triggers.some((type, index) => type !== rule.triggers[index])) {
    refuse(
      "locale-scenario-mismatch",
      `scenario "${name}" speaks [${triggers.join(", ")}], but ${rule.slug} speaks ` +
        `[${rule.triggers.join(", ")}] in every Locale`,
    );
  }
  if (scenario.soundscape.id !== rule.soundscape) {
    refuse(
      "locale-scenario-mismatch",
      `scenario "${name}" uses soundscape "${scenario.soundscape.id}", expected "${rule.soundscape}"`,
    );
  }
  const faults = scenario.faults.map((fault) => fault.kind);
  const expectedFaults = rule.fault === undefined ? [] : [rule.fault];
  if (faults.length !== expectedFaults.length || faults.some((kind, index) => kind !== expectedFaults[index])) {
    refuse(
      "locale-scenario-mismatch",
      `scenario "${name}" injects [${faults.join(", ") || "no fault"}], expected ` +
        `[${expectedFaults.join(", ") || "no fault"}]`,
    );
  }
}

function byName(corpus: Corpus): Map<string, LoadedScenario> {
  return new Map(corpus.scenarios.map((scenario) => [scenario.name, scenario]));
}

/**
 * The forty-eight scenarios the Locale core runs, or a named refusal.
 *
 * A missing directory fails the whole plan: thirty-six of forty-eight is a
 * different claim, never a smaller matrix.
 */
export function localeCorePlan(corpus: Corpus): LocaleCorePlan {
  const index = byName(corpus);
  const scenarios: LocaleCorePlanEntry[] = [];
  const missing: string[] = [];
  for (const locale of LOCALE_CORE_LOCALES) {
    for (const rule of LOCALE_CORE_RULES) {
      const name = localeCoreScenarioName(rule.slug, locale);
      const scenario = index.get(name);
      if (scenario === undefined) {
        missing.push(name);
        continue;
      }
      checkScenario(rule, locale, scenario);
      scenarios.push({ slug: rule.slug, locale, name });
    }
  }
  if (missing.length > 0) {
    refuse(
      "missing-locale-scenario",
      `the Locale core needs ${missing.length} missing scenario${missing.length === 1 ? "" : "s"}: ` +
        `${missing.join(", ")}. Twelve behaviours on four Locales is the contract; a partial matrix ` +
        "is a refusal, not a smaller run.",
    );
  }
  return {
    locales: [...LOCALE_CORE_LOCALES],
    scenarios,
    calls: scenarios.length,
  };
}

/** Every property any Locale's twelve scenarios cite. */
export function localeCorePropertyIds(corpus: Corpus): readonly string[] {
  localeCorePlan(corpus);
  return [...new Set(LOCALE_CORE_RULES.flatMap((rule) => rule.properties))].sort();
}

/**
 * The contract one Locale's run reads: only the properties its own twelve
 * scenarios cite. A property another Locale measured is absent here, so its
 * verdict cannot be borrowed.
 */
export function localeCoreContract(contract: Contract, corpus: Corpus, locale: LocaleCoreLocale): Contract {
  const plan = localeCorePlan(corpus);
  if (!plan.locales.includes(locale)) {
    refuse("locale-scenario-mismatch", `"${String(locale)}" is not a Locale-core Locale`);
  }
  const cited = new Set(localeCorePropertyIds(corpus));
  const properties = contract.properties.filter((property) => cited.has(property.id));
  const measured = new Set(
    plan.scenarios.filter((entry) => entry.locale === locale).flatMap((entry) => {
      const rule = LOCALE_CORE_RULES.find((candidate) => candidate.slug === entry.slug);
      return rule?.properties ?? [];
    }),
  );
  return {
    families: contract.families,
    properties: properties.filter((property) => measured.has(property.id)),
  };
}

/** Repetitions the spec gives each run kind: nightly 1, full 3. */
export const LOCALE_CORE_REPETITIONS: Readonly<Record<"nightly" | "full", number>> = {
  nightly: 1,
  full: 3,
};

/**
 * The pre-run bound: the core's planned calls times the frozen per-call
 * ceiling, checked against the run kind's own ceiling. The economics owner
 * computes both numbers; this module only supplies the plan size.
 */
export function localeCoreRunCeiling(input: {
  readonly contract: Contract;
  readonly kind: RunKind;
}): RunCeilingCheck {
  if (input.kind !== "nightly" && input.kind !== "full") {
    refuse(
      "locale-ceiling-unset",
      `the Locale core runs at nightly or full certification, not "${String(input.kind)}"; ` +
        "no Locale runs inside the English fast contract",
    );
  }
  const repetitions = LOCALE_CORE_REPETITIONS[input.kind];
  return preflightRunCeiling({
    kind: input.kind,
    contract: input.contract,
    plannedCalls: LOCALE_CORE_SLUGS.length * LOCALE_CORE_LOCALES.length * repetitions,
  });
}
