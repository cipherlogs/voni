/**
 * What a `demo:verify` run will execute, before any vendor opens.
 *
 * The plan is the spec's shape, not the corpus's current size: fast is ten
 * English scenarios at one repetition; nightly health is the English forty
 * plus each Locale core twelve at one; full certification repeats each three
 * times. A corpus smaller than that shape is a named gap, never a smaller run
 * that reports green. Only `local` has an evidence sink, so `staging` and
 * `production` are refused by name today rather than certifying a stack nobody
 * can read evidence from.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Targets, runs and cadence".
 */

import {
  ENGLISH_SCENARIOS as FULL_ENGLISH_SCENARIOS,
  LOCALE_CORE_SCENARIOS,
} from "@/lib/demo/verification/cadence";
import type { CertificateTarget } from "@/lib/demo/verification/certificate";
import {
  LOCALES,
  ScenarioError,
  fastRunPlan,
  type Corpus,
  type Locale,
} from "@/lib/demo/verification/scenarios";

import type { VerifyRequest } from "./args";
import { refuse } from "./errors";

/**
 * The spec's corpus sizes come from the cadence's one source. They are
 * re-exported here because the CLI's public surface names them; a second
 * literal would be a drift.
 */
export { FULL_ENGLISH_SCENARIOS, LOCALE_CORE_SCENARIOS };

/** One scenario a plan will attempt, with the Locale it speaks. */
export type PlannedScenario = {
  readonly name: string;
  readonly locale: Locale;
  readonly heldOut: boolean;
};

export type VerifyPlan = {
  readonly mode: VerifyRequest["mode"];
  readonly target: CertificateTarget;
  readonly locale: Locale | null;
  readonly scenario: string | null;
  /** Attempts every planned scenario owes. */
  readonly repetitions: number;
  /** Calls the plan owes, including the part the corpus cannot supply. */
  readonly calls: number;
  readonly scenarios: readonly PlannedScenario[];
  /** Named corpus gaps; a non-empty list refuses the run before the first call. */
  readonly gaps: readonly string[];
};

const LOCALE_TITLE: Readonly<Record<Locale, string>> = {
  en: "English",
  es: "Spanish (es)",
  fr: "French (fr)",
  de: "German (de)",
  pt: "Portuguese (pt)",
};

function requiredFor(locale: Locale): number {
  return locale === "en" ? FULL_ENGLISH_SCENARIOS : LOCALE_CORE_SCENARIOS;
}

function planned(scenario: Corpus["scenarios"][number]): PlannedScenario {
  return { name: scenario.name, locale: scenario.locale, heldOut: scenario.heldOut };
}

/**
 * Every target except local would certify a stack whose delivered audio, marks
 * and trace this machine cannot read: the app's capture sink is dev-only.
 */
function assertTargetCanRun(target: CertificateTarget): void {
  if (target === "local") return;
  refuse(
    "unsupported-target",
    `target "${target}" has no evidence sink: the delivered WAV, browser marks and per-call ` +
      "trace are written by the local dev capture path only. Certifying " +
      `"${target}" would need a sink that does not exist yet, so the run refuses rather than ` +
      "claiming a green it cannot prove",
  );
}

function diagnosePlan(request: VerifyRequest, corpus: Corpus): VerifyPlan {
  const name = request.scenario;
  if (name === undefined) {
    refuse("missing-scenario", "--diagnose needs --scenario <name>; a diagnosis is one scenario");
  }
  const scenario = corpus.scenarios.find((entry) => entry.name === name);
  if (scenario === undefined) {
    refuse(
      "missing-scenario",
      `scenario "${name}" is not in the corpus at version ${corpus.version}; it holds: ` +
        `${corpus.scenarios.map((entry) => entry.name).sort().join(", ")}`,
    );
  }
  if (request.locale !== undefined && request.locale !== scenario.locale) {
    refuse(
      "unknown-locale",
      `scenario "${scenario.name}" speaks Locale "${scenario.locale}" but --locale ` +
        `${request.locale} was given; a diagnosis may not relabel the corpus`,
    );
  }
  return {
    mode: "diagnose",
    target: request.target,
    locale: scenario.locale,
    scenario: scenario.name,
    repetitions: 1,
    calls: 1,
    scenarios: [planned(scenario)],
    gaps: [],
  };
}

function fastPlan(request: VerifyRequest, corpus: Corpus): VerifyPlan {
  try {
    const plan = fastRunPlan(corpus);
    const byName = new Map(corpus.scenarios.map((scenario) => [scenario.name, scenario]));
    const scenarios = plan.scenarios.map((name) => {
      const scenario = byName.get(name);
      if (scenario === undefined) {
        refuse(
          "missing-corpus",
          `the fast contract needs scenario "${name}", but the corpus does not hold it`,
        );
      }
      return planned(scenario);
    });
    return {
      mode: "fast",
      target: request.target,
      locale: "en",
      scenario: null,
      repetitions: plan.repetitions,
      calls: plan.calls,
      scenarios,
      gaps: [],
    };
  } catch (error) {
    if (error instanceof ScenarioError) {
      refuse("missing-corpus", error.message, [error.code]);
    }
    throw error;
  }
}

function certificationPlan(request: VerifyRequest, corpus: Corpus): VerifyPlan {
  const repetitions = request.mode === "full" ? 3 : 1;
  const locales: readonly Locale[] =
    request.locale === undefined ? LOCALES : [request.locale];

  const gaps: string[] = [];
  const scenarios: PlannedScenario[] = [];
  let calls = 0;

  for (const locale of locales) {
    const required = requiredFor(locale);
    const available = corpus.scenarios
      .filter((scenario) => scenario.locale === locale)
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const title = LOCALE_TITLE[locale];
    if (available.length < required) {
      gaps.push(
        `${title} corpus holds ${available.length} of the ${required} scenarios a ` +
          `${request.mode} run is defined over`,
      );
    } else if (available.length > required) {
      gaps.push(
        `${title} corpus holds ${available.length} scenarios, not the ${required} the ` +
          `${request.mode} run is defined over; a grown corpus needs a new plan, not a bigger claim`,
      );
    }
    scenarios.push(...available.slice(0, required).map(planned));
    calls += required * repetitions;
  }

  return {
    mode: request.mode,
    target: request.target,
    locale: request.locale ?? null,
    scenario: null,
    repetitions,
    calls,
    scenarios,
    gaps,
  };
}

/** Plan one request, or name what makes it impossible. */
export function planVerify(input: { readonly request: VerifyRequest; readonly corpus: Corpus }): VerifyPlan {
  assertTargetCanRun(input.request.target);
  switch (input.request.mode) {
    case "diagnose":
      return diagnosePlan(input.request, input.corpus);
    case "fast":
      return fastPlan(input.request, input.corpus);
    case "nightly":
    case "full":
      return certificationPlan(input.request, input.corpus);
  }
}

/** The run-ceiling kind a plan owes; diagnose is judged per call, not per run. */
export function runKindOf(mode: VerifyRequest["mode"]): "fast" | "nightly" | "full" | null {
  return mode === "diagnose" ? null : mode;
}
