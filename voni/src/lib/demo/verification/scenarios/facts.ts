/**
 * The authored facts a run hands its evaluators: the caller's words, in the
 * order the script speaks them.
 *
 * These are not measurements and not a second copy of the scenario: they are
 * the scenario's own take text, resolved through its script. An evaluator that
 * compares a tool argument or a transcript to them is comparing measured
 * output to authored ground truth, which is the only way an exactness bar can
 * cite the caller's line.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Comprehension and content".
 */

import type { LoadedScenario } from "./types";

/** One spoken step's authored words. `null` when the take carries no text. */
export type ScenarioTakeFact = {
  readonly id: string;
  readonly text: string | null;
};

export type ScenarioFacts = {
  /** One entry per script step, in the order the caller speaks. */
  readonly takes: readonly ScenarioTakeFact[];
};

/** Resolve the scenario's script against its takes, without touching disk. */
export function scenarioFacts(scenario: LoadedScenario): ScenarioFacts {
  const byId = new Map(scenario.takes.map((take) => [take.id, take]));
  return {
    takes: scenario.script.map((step) => {
      const take = byId.get(step.take);
      return {
        id: step.take,
        text: take?.text === undefined ? null : take.text,
      };
    }),
  };
}
