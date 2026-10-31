/**
 * Evaluator discovery, registry validation and the invocation seam.
 *
 * A family ticket adds one `*.evaluators.ts` module under `verdict/evaluators/`
 * and the loader picks it up; nothing lists the families by hand. The registry
 * refuses two evaluators for one property, an evaluator for a property the
 * contract does not know, a family mismatch and a bar that does not belong to
 * the property — each by name. Invocation turns an evaluator's answer into a
 * measurement; a missing evidence source or a thrown evaluator becomes a
 * named failure, never a skip.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FAMILIES,
  type Contract,
  type ContractPropertyEntry,
  type EvidenceSource,
  type FamilyId,
} from "../contract";
import { VerdictError } from "./errors";
import { COMPARISONS, STATISTICS } from "./statistics";
import type {
  BarBinding,
  EvaluateScenariosInput,
  EvaluatorModule,
  PropertyEvaluator,
  PropertyEvidence,
  PropertyMeasurement,
  ScenarioAttempt,
} from "./types";

/** Where a family's evaluator module lives. A new family is a new file here. */
export const EVALUATORS_DIR = new URL("./evaluators/", import.meta.url);

const EVALUATOR_FILE = /\.evaluators\.ts$/;

export type DiscoveredEvaluatorModule = {
  /** The file name, for a refusal that names where an evaluator came from. */
  readonly path: string;
  readonly module: EvaluatorModule;
};

/**
 * Import every `*.evaluators.ts` module in `dir`. A missing directory means no
 * family ticket has landed yet: the run then fails closed because every
 * property is unmeasured. An unreadable or malformed module is a named refusal.
 */
export async function loadEvaluatorModules(
  dir: URL | string = EVALUATORS_DIR,
): Promise<DiscoveredEvaluatorModule[]> {
  const path = dir instanceof URL ? fileURLToPath(dir) : dir;
  let entries: string[];
  try {
    entries = (await readdir(path)).filter((name) => EVALUATOR_FILE.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new VerdictError(
      "unreadable-evaluators",
      `cannot read the evaluator directory at ${path}: ${String(error)}`,
    );
  }

  return Promise.all(
    entries.map(async (name) => {
      try {
        const imported = (await import(pathToFileURL(join(path, name)).href)) as {
          default?: unknown;
        };
        const familyModule = imported.default;
        if (typeof familyModule !== "object" || familyModule === null) {
          throw new VerdictError(
            "malformed-evaluator-module",
            `evaluator module ${name} has no default evaluator module export`,
          );
        }
        return { path: name, module: familyModule as EvaluatorModule };
      } catch (error) {
        if (error instanceof VerdictError) throw error;
        throw new VerdictError(
          "malformed-evaluator-module",
          `evaluator module ${name} could not be imported: ${String(error)}`,
        );
      }
    }),
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type Candidate = {
  readonly evaluator: PropertyEvaluator;
  readonly source: string;
  /** Set when the candidate came from a family module. */
  readonly moduleFamily?: FamilyId;
};

function validateBars(
  property: ContractPropertyEntry,
  evaluator: PropertyEvaluator,
  source: string,
): void {
  const bars: readonly BarBinding[] = Array.isArray(evaluator.bars) ? evaluator.bars : [];
  if (!property.bar.numeric) {
    if (bars.length > 0) {
      throw new VerdictError(
        "bars-on-categorical-property",
        `evaluator for "${property.id}" (${source}) binds a numeric bar, but ${property.id} ` +
          "has a categorical bar with no threshold",
      );
    }
    return;
  }

  const keys = new Set(property.thresholds.map((threshold) => threshold.key));
  const bound = new Set<string>();
  for (const bar of bars) {
    const key = text(bar?.key);
    if (key === "") {
      throw new VerdictError(
        "invalid-bar-binding",
        `evaluator for "${property.id}" (${source}) has a bar binding with no key`,
      );
    }
    if (bound.has(key)) {
      throw new VerdictError(
        "duplicate-bar-binding",
        `evaluator for "${property.id}" (${source}) binds "${key}" twice; one key per bar`,
      );
    }
    if (!keys.has(key)) {
      throw new VerdictError(
        "unknown-bar",
        `evaluator for "${property.id}" (${source}) binds "${key}", ` +
          `which is not a threshold of ${property.id}`,
      );
    }
    if (!(STATISTICS as readonly string[]).includes(bar.statistic)) {
      throw new VerdictError(
        "invalid-bar-binding",
        `evaluator for "${property.id}" (${source}) binds "${key}" to unknown statistic ` +
          `"${String(bar.statistic)}"; known: ${STATISTICS.join(", ")}`,
      );
    }
    if (!(COMPARISONS as readonly string[]).includes(bar.comparison)) {
      throw new VerdictError(
        "invalid-bar-binding",
        `evaluator for "${property.id}" (${source}) binds "${key}" to unknown comparison ` +
          `"${String(bar.comparison)}"; known: ${COMPARISONS.join(", ")}`,
      );
    }
    if (bar.comparison === "exact" && bar.statistic !== "each") {
      throw new VerdictError(
        "invalid-bar-binding",
        `evaluator for "${property.id}" (${source}) binds exact bar "${key}" to ` +
          `statistic "${bar.statistic}"; an exact bar judges every sample`,
      );
    }
    bound.add(key);
  }

  for (const threshold of property.thresholds) {
    if (!bound.has(threshold.key)) {
      throw new VerdictError(
        "missing-bar-binding",
        `evaluator for "${property.id}" (${source}) leaves threshold ` +
          `"${threshold.key}" unjudged; every numeric bar needs a binding`,
      );
    }
  }
}

/** Validate one set of evaluators against the contract, in contract order. */
function registerCandidates(
  candidates: readonly Candidate[],
  contract: Contract,
): PropertyEvaluator[] {
  const known = new Map(contract.properties.map((property) => [property.id, property]));
  const seen = new Map<string, string>();
  const registered = new Map<string, PropertyEvaluator>();

  for (const candidate of candidates) {
    const evaluator = candidate.evaluator;
    const source = text(evaluator?.source) || candidate.source;
    const propertyId = text(evaluator?.propertyId);
    if (propertyId === "") {
      throw new VerdictError(
        "invalid-evaluator",
        `an evaluator in ${source} names no property id`,
      );
    }
    if (typeof evaluator.evaluate !== "function") {
      throw new VerdictError(
        "invalid-evaluator",
        `evaluator for "${propertyId}" (${source}) has no evaluate function`,
      );
    }
    const property = known.get(propertyId);
    if (property === undefined) {
      throw new VerdictError(
        "unknown-property",
        `evaluator (${source}) judges unknown property "${propertyId}"; the contract does not ` +
          "know it, so it can never be a pass",
      );
    }
    if (candidate.moduleFamily !== undefined && candidate.moduleFamily !== property.family) {
      throw new VerdictError(
        "family-mismatch",
        `evaluator for "${propertyId}" (${source}) is filed under family ` +
          `"${candidate.moduleFamily}", but ${propertyId} belongs to "${property.family}"`,
      );
    }
    const previous = seen.get(propertyId);
    if (previous !== undefined) {
      throw new VerdictError(
        "duplicate-evaluator",
        `property "${propertyId}" has two evaluators: ${previous} and ${source}; ` +
          "one property has one owner",
      );
    }
    validateBars(property, evaluator, source);
    seen.set(propertyId, source);
    registered.set(propertyId, {
      ...evaluator,
      propertyId,
      source,
      // The discovered module file is the one pointer a card can resolve. An
      // evaluator's own `source` is a human label (and sometimes a path that
      // does not exist), so it is never used as the card pointer.
      ...(candidate.moduleFamily === undefined
        ? {}
        : { modulePath: candidate.source }),
    });
  }

  return contract.properties.flatMap((property) => {
    const evaluator = registered.get(property.id);
    return evaluator === undefined ? [] : [evaluator];
  });
}

/**
 * Validate discovered modules and return the evaluators in contract order.
 * Two evaluators for one id, an unknown property, an unknown bar or a wrong
 * family is a named refusal.
 */
export function buildEvaluatorRegistry(
  modules: readonly DiscoveredEvaluatorModule[],
  contract: Contract,
): PropertyEvaluator[] {
  const candidates: Candidate[] = [];
  for (const { path, module: familyModule } of modules) {
    const family = text(familyModule?.family);
    if (!(FAMILIES as readonly string[]).includes(family)) {
      throw new VerdictError(
        "unknown-family",
        `evaluator module ${path} declares unknown family "${String(familyModule?.family)}"; ` +
          `known families: ${FAMILIES.join(", ")}`,
      );
    }
    const evaluators = familyModule.evaluators;
    if (!Array.isArray(evaluators) || evaluators.length === 0) {
      throw new VerdictError(
        "empty-evaluator-module",
        `evaluator module ${path} declares no evaluators for family "${family}"`,
      );
    }
    for (const evaluator of evaluators) {
      candidates.push({ evaluator, source: path, moduleFamily: family as FamilyId });
    }
  }
  return registerCandidates(candidates, contract);
}

/** Discovery plus registry validation; the production entry point. */
export async function loadEvaluators(
  contract: Contract,
  dir: URL | string = EVALUATORS_DIR,
): Promise<PropertyEvaluator[]> {
  return buildEvaluatorRegistry(await loadEvaluatorModules(dir), contract);
}

function validateAttempts(attempts: readonly ScenarioAttempt[]): ScenarioAttempt[] {
  const seen = new Set<string>();
  const validated: ScenarioAttempt[] = [];
  for (const attempt of attempts) {
    const scenario = text(attempt?.scenario);
    if (scenario === "") {
      throw new VerdictError("invalid-attempt", "a scenario attempt has no scenario name");
    }
    if (!Number.isInteger(attempt.repetition) || attempt.repetition < 1) {
      throw new VerdictError(
        "invalid-attempt",
        `scenario "${scenario}" has repetition "${String(attempt.repetition)}"; ` +
          "repetitions are 1-based integers",
      );
    }
    const key = `${scenario}#${attempt.repetition}`;
    if (seen.has(key)) {
      throw new VerdictError(
        "duplicate-attempt",
        `scenario "${scenario}" repetition ${attempt.repetition} is recorded twice; ` +
          "a retry cannot replace a failure",
      );
    }
    seen.add(key);
    validated.push({ ...attempt, scenario });
  }
  return validated;
}

function citationsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
}

function measurementFrom(
  property: ContractPropertyEntry,
  attempt: ScenarioAttempt,
  evaluation: unknown,
): PropertyMeasurement {
  const base = {
    propertyId: property.id,
    scenario: attempt.scenario,
    repetition: attempt.repetition,
    ...(attempt.locale === undefined ? {} : { locale: attempt.locale }),
  };
  if (typeof evaluation !== "object" || evaluation === null) {
    return {
      ...base,
      outcome: "error",
      samples: [],
      reason: "evaluator returned no evaluation",
      citations: [],
    };
  }
  const record = evaluation as Record<string, unknown>;
  const citations = citationsOf(record.citations);
  const kind = record.kind;
  if (kind === "unmeasured" || kind === "skipped" || kind === "error") {
    return {
      ...base,
      outcome: kind,
      samples: [],
      reason: text(record.reason) || `${String(kind)} without a reason`,
      citations,
    };
  }
  if (kind !== "measured") {
    return {
      ...base,
      outcome: "error",
      samples: [],
      reason: `evaluator returned unknown outcome "${String(kind)}"`,
      citations,
    };
  }

  const rawSamples = record.samples ?? [];
  if (!Array.isArray(rawSamples)) {
    return {
      ...base,
      outcome: "error",
      samples: [],
      reason: "evaluator returned samples that are not a list",
      citations,
    };
  }
  if (rawSamples.some((sample) => typeof sample !== "number")) {
    return {
      ...base,
      outcome: "error",
      samples: [],
      reason: "evaluator returned a non-numeric sample",
      citations,
    };
  }
  return {
    ...base,
    outcome: "measured",
    samples: rawSamples as number[],
    ...(typeof record.passed === "boolean" ? { passed: record.passed } : {}),
    ...(text(record.detail) === "" ? {} : { detail: text(record.detail) }),
    citations,
  };
}

/**
 * Run each evaluator over the scenario attempts it needs: every declared
 * repetition for timing and behaviour, the first repetition only for a
 * deterministic property. Attempts beyond a property's declared repetitions
 * belong to another property's plan and are not judged here.
 */
export async function evaluateScenarios(
  input: EvaluateScenariosInput,
): Promise<PropertyEvidence[]> {
  const attempts = validateAttempts(input.attempts);
  const evaluators = registerCandidates(
    input.evaluators.map((evaluator) => ({
      evaluator,
      source: text(evaluator.source) || "inline evaluator",
    })),
    input.contract,
  );

  const byScenario = new Map<string, ScenarioAttempt[]>();
  for (const attempt of attempts) {
    const list = byScenario.get(attempt.scenario);
    if (list === undefined) byScenario.set(attempt.scenario, [attempt]);
    else list.push(attempt);
  }

  const evidence: PropertyEvidence[] = [];
  for (const evaluator of evaluators) {
    const property = input.contract.properties.find(
      (entry) => entry.id === evaluator.propertyId,
    );
    if (property === undefined) continue;
    const measurements: PropertyMeasurement[] = [];
    for (const [scenario, scenarioAttempts] of byScenario) {
      const planned = scenarioAttempts.filter(
        (attempt) => attempt.repetition <= property.repetitions,
      );
      for (const attempt of planned) {
        const source = attempt.evidence[property.evidence as EvidenceSource];
        if (source === undefined || source === null) {
          measurements.push({
            propertyId: property.id,
            scenario,
            repetition: attempt.repetition,
            ...(attempt.locale === undefined ? {} : { locale: attempt.locale }),
            outcome: "missing-evidence",
            samples: [],
            reason:
              `evidence source "${property.evidence}" is missing for scenario "${scenario}" ` +
              `repetition ${attempt.repetition}`,
            citations: [],
          });
          continue;
        }
        try {
          const evaluation = await evaluator.evaluate({
            property,
            scenario,
            ...(attempt.locale === undefined ? {} : { locale: attempt.locale }),
            ...(attempt.target === undefined ? {} : { target: attempt.target }),
            repetition: attempt.repetition,
            source,
            evidence: attempt.evidence,
            ...(attempt.facts === undefined ? {} : { facts: attempt.facts }),
          });
          measurements.push(measurementFrom(property, attempt, evaluation));
        } catch (error) {
          measurements.push({
            propertyId: property.id,
            scenario,
            repetition: attempt.repetition,
            ...(attempt.locale === undefined ? {} : { locale: attempt.locale }),
            outcome: "error",
            samples: [],
            reason: error instanceof Error ? error.message : String(error),
            citations: [],
          });
        }
      }
    }
    evidence.push({ propertyId: property.id, bars: evaluator.bars, measurements });
  }
  return evidence;
}
