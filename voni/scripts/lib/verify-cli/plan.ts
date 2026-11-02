/**
 * What a `demo:verify` run will execute, before any vendor opens.
 *
 * The plan is the spec's shape, not the corpus's current size: fast is ten
 * English scenarios at one repetition; nightly health is the English
 * forty-three plus each Locale core twelve at one; full certification repeats
 * each three times. A corpus smaller than that shape is a named gap, never a smaller run
 * that reports green. Only `local` has an evidence sink, so `staging` and
 * `production` are refused by name today rather than certifying a stack nobody
 * can read evidence from.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Targets, runs and cadence".
 */

import {
  ENGLISH_SCENARIOS,
  FULL_REPETITIONS,
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
 * The spec's corpus sizes come from the cadence's one source. The Locale core
 * is re-exported because the CLI's public surface names it; a second literal
 * would be a drift.
 */
export { LOCALE_CORE_SCENARIOS };

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
  /**
   * The certificate's declared Locales. A full run defaults to its Locale
   * filter, else all five; every planned Locale must be inside it and every
   * declared Locale must be planned, or the run refuses before a call.
   */
  readonly scope: readonly Locale[];
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
  return locale === "en" ? ENGLISH_SCENARIOS : LOCALE_CORE_SCENARIOS;
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
    scope: [scenario.locale],
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
      scope: ["en"],
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

/** The scenarios the corpus holds for one Locale, in plan order. */
function availableFor(corpus: Corpus, locale: Locale): Corpus["scenarios"] {
  return corpus.scenarios
    .filter((scenario) => scenario.locale === locale)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * A per-Locale full run is the spec's cutover shape: every Locale's full set.
 * Only English has a full set; the other four hold the twelve-scenario core.
 * A locale-filtered full run therefore refuses by name instead of issuing a
 * certificate stamped full whose coverage is a core.
 */
function assertPerLocaleFull(request: VerifyRequest, corpus: Corpus): void {
  if (request.mode !== "full" || request.locale === undefined || request.locale === "en") return;
  const locale = request.locale;
  const available = availableFor(corpus, locale).length;
  refuse(
    "missing-locale-corpus",
    `the ${LOCALE_TITLE[locale]} per-Locale full corpus is missing: a full certification of ` +
      `"${locale}" runs all ${ENGLISH_SCENARIOS} scenarios in that Locale, and the corpus ` +
      `holds ${available} Locale-core scenario(s). Refusing rather than issuing a certificate ` +
      "that carries a Locale coverage gap; run English --full or the nightly Locale core",
  );
}

function certificationPlan(request: VerifyRequest, corpus: Corpus): VerifyPlan {
  const repetitions = request.mode === "full" ? FULL_REPETITIONS : 1;
  const locales: readonly Locale[] =
    request.locale === undefined ? LOCALES : [request.locale];
  // The declared claim is an input; the plan may not step outside it, and a
  // declared Locale the plan does not run would be an unmeasured claim.
  const scope: readonly Locale[] = request.scope ?? locales;
  const unplanned = scope.filter((locale) => !locales.includes(locale));
  if (unplanned.length > 0) {
    refuse(
      "scope-mismatch",
      `the declared scope includes Locale(s) ${unplanned.join(", ")}, which this ${request.mode} ` +
        `run does not plan; a certificate cannot claim a Locale it did not run`,
    );
  }
  const undeclared = locales.filter((locale) => !scope.includes(locale));
  if (undeclared.length > 0) {
    refuse(
      "scope-mismatch",
      `the ${request.mode} run plans Locale(s) ${undeclared.join(", ")}, which the declared scope ` +
        `(${scope.join(", ")}) excludes; a Locale that ran is measured, never out of scope. ` +
        "Widen the scope or narrow the run with --locale",
    );
  }

  assertPerLocaleFull(request, corpus);

  const gaps: string[] = [];
  const scenarios: PlannedScenario[] = [];
  let calls = 0;

  for (const locale of locales) {
    const required = requiredFor(locale);
    const available = availableFor(corpus, locale);
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
    scope,
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
