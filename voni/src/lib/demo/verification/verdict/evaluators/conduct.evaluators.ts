/**
 * Conduct evaluators currently landed: C1 (no unilateral end) and C2 (a
 * greeting-only call stays open).
 *
 * Ticket 18 owns the two reported-bug proofs. The contract files a
 * greeting-only call's ending under conduct, so the two checks the ticket
 * requires live here; ticket 19 extends this module with C3–C10. The checks
 * read the visitor's marks and the service's turn rows, never the client's
 * internal state: an `end_call` with no caller request, clock, budget or
 * unrecoverable failure is a unilateral end, and a greeting-only call that
 * drops before the 30 s bar fails C2.
 *
 * Spec: `.scratch/demo-verification/spec.md`, C1 and C2.
 */

import type { Evaluation, EvaluatorModule, PropertyEvaluator } from "../types";
import { greetingOnlyFacts } from "../lifecycle/analysis";
import { readEnd, readMarks, readTrace, reasonOf } from "../lifecycle/evidence";

function unmeasured(error: unknown): Evaluation {
  return { kind: "unmeasured", reason: reasonOf(error), citations: [] };
}

const c1: PropertyEvaluator = {
  propertyId: "C1",
  source: "conduct.evaluators.ts",
  bars: [{ key: "dvUnilateralEndMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const facts = greetingOnlyFacts(
        readMarks(context.evidence),
        readTrace(context.evidence),
        readEnd(context.evidence),
        context.facts,
        context.scenario,
      );
      return {
        kind: "measured",
        samples: [facts.unilateral ? 1 : 0],
        citations: facts.unilateral ? ["trace:turn.hangup", "browser:end_received"] : ["trace:turn.hangup"],
        detail: facts.detail,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const c2: PropertyEvaluator = {
  propertyId: "C2",
  source: "conduct.evaluators.ts",
  bars: [{ key: "dvGreetingOnlyOpenMinS", statistic: "each", comparison: "at-least" }],
  evaluate(context) {
    try {
      const facts = greetingOnlyFacts(
        readMarks(context.evidence),
        readTrace(context.evidence),
        readEnd(context.evidence),
        context.facts,
        context.scenario,
      );
      if (!facts.greetingOnly) {
        return {
          kind: "unmeasured",
          reason:
            "the scenario is not a greeting-only call; C2 is not exercised and is never " +
            "borrowed from a different call",
          citations: [],
        };
      }
      if (facts.openSeconds === null) {
        return {
          kind: "unmeasured",
          reason: "the greeting-only call has no admission or ending mark; its open duration is unrecorded",
          citations: [],
        };
      }
      return {
        kind: "measured",
        samples: [facts.openSeconds],
        citations: ["browser:admitted", "browser:end_received"],
        detail: facts.detail,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const conduct: EvaluatorModule = {
  family: "conduct",
  evaluators: [c1, c2],
};

export default conduct;
