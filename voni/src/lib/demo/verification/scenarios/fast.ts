/**
 * The English fast contract: ten committed scenarios, one repetition, and a
 * scoped verdict that names every family it did not measure.
 *
 * This module owns the fast run's shape, not its audio and not its adapter. The
 * corpus is data (`corpus/`); the runner is ticket 11's protocol adapter or
 * ticket 17's browser adapter. What lives here is the contract between them:
 *
 * - exactly ten named English scenarios, none held out, one call each;
 * - the six call-path capabilities (greeting, turn, barge, filler, tool,
 *   goodbye) each covered by at least one selected scenario, derived from the
 *   scenario record rather than a second hand-kept list;
 * - a scope in which a property no selected scenario cites is `OUT-OF-SCOPE`,
 *   never `PASS`; a fast run can be `scoped-pass` and is never a certificate;
 * - the run cost ceiling read from the contract's frozen E3 record, and the
 *   wall-clock measurement reported without inventing a bound the spec lacks.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Scenario corpus and Locale
 * matrix", "Targets, runs and cadence" and "Economics" E3.
 */

import type { Contract, FamilyId } from "../contract";
import { ScenarioError } from "./errors";
import type { Corpus, LoadedScenario, TriggerType } from "./types";

/** The ten English scenarios the fast contract runs, in plan order. */
export const FAST_CONTRACT_SCENARIOS = [
  "golden-flow-hello",
  "golden-flow-substantive",
  "golden-flow-greeting-only",
  "turn-taking-barge",
  "turn-taking-filler",
  "soundscape-quiet-room",
  "connectivity-jitter",
  "tools-email-send",
  "ending-goodbye",
  "ending-caller-silence",
] as const;

export type FastScenarioName = (typeof FAST_CONTRACT_SCENARIOS)[number];

/** The fast contract runs one repetition, by the spec's cadence. */
export const FAST_CONTRACT_REPETITIONS = 1 as const;

/** The one Locale the fast contract speaks. */
export const FAST_CONTRACT_LOCALE = "en" as const;

/** The parts of the call path the fast set must exercise, in spec order. */
export const CALL_PATH_CAPABILITIES = [
  "greeting",
  "turn",
  "barge",
  "filler",
  "tool",
  "goodbye",
] as const;

export type CallPathCapability = (typeof CALL_PATH_CAPABILITIES)[number];

/**
 * What proves a capability. A trigger proves the caller did the thing; a cited
 * property proves the run expects to judge it. A scenario needs both: speaking
 * over the agent without expecting T3 measures nothing.
 */
type CapabilityRule = {
  readonly trigger: TriggerType | null;
  readonly properties: ReadonlySet<string>;
  readonly detail: string;
};

const LIFECYCLE_GREETING = new Set(["L3", "L4", "L7"]);
const TURN_START = new Set(["T1", "T2"]);
const BARGE = new Set(["T3", "T6", "T7"]);
const FILLER = new Set(["T4", "T5"]);
const GOODBYE = new Set(["C7", "C8", "L9", "L11"]);

const CAPABILITY_RULES: Record<CallPathCapability, CapabilityRule> = {
  greeting: {
    trigger: "call-open",
    properties: LIFECYCLE_GREETING,
    detail: "a caller take at call-open that expects a greeting property (L3, L4 or L7)",
  },
  turn: {
    trigger: "agent-turn-end",
    properties: TURN_START,
    detail: "a caller take at agent-turn-end that expects a turn property (T1 or T2)",
  },
  barge: {
    trigger: "agent-speech-start",
    properties: BARGE,
    detail: "a caller take at agent-speech-start that expects a barge property (T3, T6 or T7)",
  },
  filler: {
    trigger: "silence",
    properties: FILLER,
    detail: "a caller take at silence that expects a filler property (T4 or T5)",
  },
  tool: {
    trigger: null,
    properties: new Set(["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10"]),
    detail: "a scenario that expects a tool property (X1–X10)",
  },
  goodbye: {
    trigger: null,
    properties: GOODBYE,
    detail: "a scenario that expects a goodbye property (C7, C8, L9 or L11)",
  },
};

export type FastRunPlan = {
  readonly scenarios: readonly FastScenarioName[];
  readonly locale: typeof FAST_CONTRACT_LOCALE;
  readonly repetitions: typeof FAST_CONTRACT_REPETITIONS;
  readonly calls: number;
};

export type FastCoverageEntry = {
  readonly capability: CallPathCapability;
  readonly scenarios: readonly string[];
};

/** The selected scenarios, in plan order, or a refusal naming the gap. */
function selectFastScenarios(corpus: Corpus): LoadedScenario[] {
  const byName = new Map(corpus.scenarios.map((scenario) => [scenario.name, scenario]));
  return FAST_CONTRACT_SCENARIOS.map((name) => {
    const scenario = byName.get(name);
    if (scenario === undefined) {
      throw new ScenarioError(
        "missing-fast-scenario",
        `the fast contract needs scenario "${name}", but the corpus at version ${corpus.version} ` +
          `has: ${corpus.scenarios.map((entry) => entry.name).join(", ") || "(none)"}. ` +
          "Ten scenarios are the contract; nine is a refusal, never a smaller run.",
      );
    }
    if (scenario.heldOut) {
      throw new ScenarioError(
        "fast-scenario-mismatch",
        `scenario "${name}" is held out; a held-out scenario never joins the fast contract (RR-07)`,
      );
    }
    if (scenario.locale !== FAST_CONTRACT_LOCALE) {
      throw new ScenarioError(
        "fast-scenario-mismatch",
        `scenario "${name}" is Locale "${scenario.locale}", but the fast contract runs ` +
          `"${FAST_CONTRACT_LOCALE}"`,
      );
    }
    return scenario;
  });
}

/** Ten scenarios, one repetition each: the fast run's whole shape. */
export function fastRunPlan(corpus: Corpus): FastRunPlan {
  const scenarios = selectFastScenarios(corpus);
  // A plan without a capability is not a fast contract; refuse before a call.
  fastContractCoverage(corpus);
  return {
    scenarios: [...FAST_CONTRACT_SCENARIOS],
    locale: FAST_CONTRACT_LOCALE,
    repetitions: FAST_CONTRACT_REPETITIONS,
    calls: scenarios.length * FAST_CONTRACT_REPETITIONS,
  };
}

function covers(scenario: LoadedScenario, rule: CapabilityRule): boolean {
  if (!scenario.expectedProperties.some((property) => rule.properties.has(property))) {
    return false;
  }
  if (rule.trigger === null) return true;
  return scenario.script.some((step) => step.trigger.type === rule.trigger);
}

/**
 * The coverage the selected set actually has. A missing capability is refused
 * by name; it is never reported as an untested-but-fine row.
 */
export function fastContractCoverage(corpus: Corpus): readonly FastCoverageEntry[] {
  const scenarios = selectFastScenarios(corpus);
  const coverage = CALL_PATH_CAPABILITIES.map((capability) => {
    const rule = CAPABILITY_RULES[capability];
    return {
      capability,
      scenarios: scenarios
        .filter((scenario) => covers(scenario, rule))
        .map((scenario) => scenario.name),
    };
  });
  const missing = coverage.filter((entry) => entry.scenarios.length === 0);
  if (missing.length > 0) {
    throw new ScenarioError(
      "fast-coverage-gap",
      `the fast contract does not cover: ${missing
        .map((entry) => `${entry.capability} (needs ${CAPABILITY_RULES[entry.capability].detail})`)
        .join("; ")}. Selected scenarios: ${scenarios.map((scenario) => scenario.name).join(", ")}.`,
    );
  }
  return coverage;
}

export type FastOutOfScopeFamily = {
  readonly family: FamilyId;
  readonly title: string;
  readonly propertyIds: readonly string[];
  readonly reason: string;
};

export type FastScope = {
  readonly scenarios: readonly string[];
  readonly repetitions: typeof FAST_CONTRACT_REPETITIONS;
  readonly measuredPropertyIds: readonly string[];
  readonly unmeasuredPropertyIds: readonly string[];
  readonly measuredFamilies: readonly FamilyId[];
  readonly outOfScopeFamilies: readonly FastOutOfScopeFamily[];
};

/**
 * The properties ten scenarios can measure, and every family they cannot.
 *
 * Scope is the union of `expectedProperties`, not "the whole family": a family
 * whose one cited property is judged still leaves its other properties out.
 */
export function fastContractScope(contract: Contract, corpus: Corpus): FastScope {
  const selected = selectFastScenarios(corpus);
  // A scope over a set missing a call-path capability is not a fast scope.
  fastContractCoverage(corpus);
  const cited = new Set(selected.flatMap((scenario) => scenario.expectedProperties));

  const measuredFamilies = contract.families
    .filter((family) =>
      contract.properties.some((property) => property.family === family.id && cited.has(property.id)),
    )
    .map((family) => family.id)
    .sort();

  const outOfScopeFamilies = contract.families
    .filter((family) => !measuredFamilies.includes(family.id))
    .map((family) => {
      const propertyIds = contract.properties
        .filter((property) => property.family === family.id)
        .map((property) => property.id);
      return {
        family: family.id,
        title: family.title,
        propertyIds,
        reason:
          `not measured by the fast contract: no one of the ten English scenarios cites a ` +
          `${family.id} property. This family is out of scope, never passed.`,
      };
    });

  const measuredPropertyIds = [...cited].sort();
  const unmeasuredPropertyIds = contract.properties
    .filter((property) => !cited.has(property.id))
    .map((property) => property.id);

  return {
    scenarios: [...FAST_CONTRACT_SCENARIOS],
    repetitions: FAST_CONTRACT_REPETITIONS,
    measuredPropertyIds,
    unmeasuredPropertyIds,
    measuredFamilies,
    outOfScopeFamilies,
  };
}

export type FastScopeProperty = {
  readonly propertyId: string;
  readonly family: FamilyId;
  readonly status: "PASS" | "FAIL" | "OUT-OF-SCOPE";
  readonly reason: string;
  readonly detail: string;
};

export type FastScopeVerdictValue = "scoped-pass" | "not-demo-ready" | "ineligible";

export type FastScopedVerdict = {
  readonly scope: "fast";
  readonly verdict: FastScopeVerdictValue;
  /** Always false: only the browser adapter's certification can be a pass. */
  readonly certifiable: false;
  readonly scopeNote: string;
  readonly scenarios: readonly string[];
  readonly repetitions: typeof FAST_CONTRACT_REPETITIONS;
  readonly properties: readonly FastScopeProperty[];
  readonly measuredPropertyIds: readonly string[];
  readonly unmeasuredPropertyIds: readonly string[];
  readonly failedPropertyIds: readonly string[];
  readonly ineligibilityReasons: readonly string[];
  readonly measuredFamilies: readonly FamilyId[];
  readonly outOfScopeFamilies: readonly FastOutOfScopeFamily[];
};

/**
 * Fold the contract's full verdict into the fast scope. An uncited property is
 * out of scope even if an evaluator happened to measure it; a fast run may not
 * borrow a family it did not exercise. A `scoped-pass` is not a certificate.
 */
export function scopeFastVerdict(input: {
  readonly contract: Contract;
  readonly corpus: Corpus;
  readonly verdict: {
    readonly verdict: string;
    readonly eligible: boolean;
    readonly eligibility: { readonly reasons: readonly string[] };
    readonly properties: readonly {
      readonly propertyId: string;
      readonly status: "PASS" | "FAIL";
      readonly reason: string;
      readonly detail: string;
    }[];
  };
}): FastScopedVerdict {
  const scope = fastContractScope(input.contract, input.corpus);
  const measured = new Set(scope.measuredPropertyIds);
  const byId = new Map(input.verdict.properties.map((property) => [property.propertyId, property]));
  const missing = scope.measuredPropertyIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new ScenarioError(
      "fast-verdict-incomplete",
      `the verdict has no entry for in-scope properties: ${missing.join(", ")}. ` +
        "A missing judgement is a refusal, not an out-of-scope claim.",
    );
  }

  const failed: string[] = [];
  const properties = input.contract.properties.map((property) => {
    if (!measured.has(property.id)) {
      return {
        propertyId: property.id,
        family: property.family,
        status: "OUT-OF-SCOPE" as const,
        reason: "not-measured",
        detail:
          `no fast-contract scenario cites ${property.id}; ` +
          `${property.family} is reported out of scope`,
      };
    }
    const entry = byId.get(property.id);
    if (entry === undefined) {
      throw new ScenarioError(
        "fast-verdict-incomplete",
        `the verdict has no entry for in-scope property ${property.id}`,
      );
    }
    if (entry.status === "FAIL") failed.push(property.id);
    return {
      propertyId: property.id,
      family: property.family,
      status: entry.status,
      reason: entry.reason,
      detail: entry.detail,
    };
  });

  const verdict: FastScopeVerdictValue = !input.verdict.eligible
    ? "ineligible"
    : failed.length > 0
      ? "not-demo-ready"
      : "scoped-pass";

  return {
    scope: "fast",
    verdict,
    certifiable: false,
    scopeNote:
      `the fast contract measured ${scope.measuredPropertyIds.length} of ` +
      `${input.contract.properties.length} properties across ${scope.scenarios.length} English ` +
      `scenarios; ${scope.outOfScopeFamilies.length} families were not measured and are out of ` +
      "scope. A scoped-pass is not a certificate.",
    scenarios: scope.scenarios,
    repetitions: scope.repetitions,
    properties,
    measuredPropertyIds: scope.measuredPropertyIds,
    unmeasuredPropertyIds: scope.unmeasuredPropertyIds,
    failedPropertyIds: failed,
    ineligibilityReasons: input.verdict.eligibility.reasons,
    measuredFamilies: scope.measuredFamilies,
    outOfScopeFamilies: scope.outOfScopeFamilies,
  };
}

/** The E3 fast run ceiling, resolved from the frozen record the contract cites. */
export function fastRunCeilingUsd(contract: Contract): number {
  const e3 = contract.properties.find((property) => property.id === "E3");
  const threshold = e3?.thresholds.find((entry) => entry.key === "dvCostFastRunMaxUsd");
  if (threshold === undefined) {
    throw new ScenarioError(
      "fast-ceiling-unset",
      "the fast run ceiling is unset: contract property E3 does not resolve " +
        "dvCostFastRunMaxUsd from the frozen budget record. A fast run cannot claim a ceiling " +
        "it cannot read.",
    );
  }
  return threshold.value;
}

export type FastCallCost = {
  readonly scenario: string;
  readonly costUsd: number;
};

export type FastRunEconomy = {
  readonly ceilingUsd: number;
  readonly measuredUsd: number | null;
  readonly withinCeiling: boolean;
  readonly detail: string;
};

export type FastRunTiming = {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly elapsedMs: number;
  readonly plannedCalls: number;
  readonly measuredCalls: number;
  readonly fitsPlan: boolean;
};

export type FastRunReport = FastScopedVerdict & {
  readonly calls: number;
  readonly economy: FastRunEconomy;
  readonly timing: FastRunTiming;
  readonly gaps: readonly string[];
};

function parseTime(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ScenarioError(
      "fast-run-incomplete",
      `the fast run's ${name} "${value}" is not an ISO timestamp`,
    );
  }
  return parsed;
}

/**
 * The fast run's operational ceiling and timing, over the same ten calls.
 *
 * `calls` is one priced observation per selected scenario; a missing, extra or
 * duplicate call is refused by name. Cost is copied from the call's own priced
 * row. The wall-clock time is measured, and its missing numeric ceiling is a
 * named gap: the spec has no number here and this module does not invent one.
 */
export function judgeFastRun(input: {
  readonly contract: Contract;
  readonly corpus: Corpus;
  readonly verdict: Parameters<typeof scopeFastVerdict>[0]["verdict"];
  readonly calls: readonly FastCallCost[];
  readonly startedAt: string;
  readonly endedAt: string;
}): FastRunReport {
  const plan = fastRunPlan(input.corpus);
  const scoped = scopeFastVerdict({
    contract: input.contract,
    corpus: input.corpus,
    verdict: input.verdict,
  });

  const seen = new Map<string, FastCallCost>();
  for (const call of input.calls) {
    if (!FAST_CONTRACT_SCENARIOS.includes(call.scenario as FastScenarioName)) {
      throw new ScenarioError(
        "fast-run-incomplete",
        `the fast run observed call "${call.scenario}", which is not one of the ten scenarios`,
      );
    }
    if (seen.has(call.scenario)) {
      throw new ScenarioError(
        "fast-run-incomplete",
        `the fast run observed scenario "${call.scenario}" twice; the fast contract runs one ` +
          "repetition and never retries",
      );
    }
    seen.set(call.scenario, call);
  }
  const missing = plan.scenarios.filter((scenario) => !seen.has(scenario));
  if (missing.length > 0) {
    throw new ScenarioError(
      "fast-run-incomplete",
      `the fast run is missing calls for: ${missing.join(", ")}. Ten scenarios are the ` +
        "contract; a partial run is a refusal, not a scoped pass.",
    );
  }

  const unmeasured = plan.scenarios.filter((scenario) => {
    const call = seen.get(scenario);
    return call === undefined || !Number.isFinite(call.costUsd) || call.costUsd < 0;
  });

  const ceilingUsd = fastRunCeilingUsd(input.contract);
  const measuredUsd =
    unmeasured.length === 0
      ? // Millions of a dollar: far finer than a vendor's priced row, and it
        // keeps ten additions from turning $3.00 into $2.9999999999999996.
        Math.round(
          plan.scenarios.reduce((sum, scenario) => sum + (seen.get(scenario)?.costUsd ?? 0), 0) *
            1_000_000,
        ) / 1_000_000
      : null;
  const withinCeiling = measuredUsd !== null && measuredUsd <= ceilingUsd;
  const economy: FastRunEconomy = {
    ceilingUsd,
    measuredUsd,
    withinCeiling,
    detail:
      measuredUsd === null
        ? `the fast run cannot claim its ceiling: ${unmeasured.join(", ")} has no measured ` +
          "priced row. An unmeasured cost fails closed."
        : `the ten calls cost $${measuredUsd} against the fast ceiling $${ceilingUsd}`,
  };

  const startedMs = parseTime(input.startedAt, "startedAt");
  const endedMs = parseTime(input.endedAt, "endedAt");
  const elapsedMs = endedMs - startedMs;
  if (elapsedMs < 0) {
    throw new ScenarioError(
      "fast-run-incomplete",
      `the fast run ends (${input.endedAt}) before it starts (${input.startedAt})`,
    );
  }
  const timing: FastRunTiming = {
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    elapsedMs,
    plannedCalls: plan.calls,
    measuredCalls: input.calls.length,
    fitsPlan:
      input.calls.length === plan.calls &&
      plan.repetitions === FAST_CONTRACT_REPETITIONS &&
      plan.scenarios.length === FAST_CONTRACT_SCENARIOS.length,
  };

  const gaps = [
    "the fast contract's wall-clock ceiling is unset in the frozen record; elapsed time is " +
      "measured and reported, never compared to an invented bound",
  ];
  if (measuredUsd === null) gaps.push(economy.detail);

  const verdict: FastScopeVerdictValue =
    scoped.verdict === "ineligible"
      ? "ineligible"
      : scoped.verdict === "not-demo-ready" || !withinCeiling
        ? "not-demo-ready"
        : "scoped-pass";

  return {
    ...scoped,
    verdict,
    calls: plan.calls,
    economy,
    timing,
    gaps,
  };
}
