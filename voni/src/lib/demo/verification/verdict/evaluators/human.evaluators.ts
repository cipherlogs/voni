/**
 * Human-quality evaluators for the verdict core.
 *
 * H6 (judge agreement with gold labels) is owned by ticket 26's calibration
 * gate and stays registered here. H1-H5 and H7 are the panel gate: their bars
 * are ratios, per-Locale floors and a per-call minimum over the same 12-call
 * sample, which a per-scenario-attempt evaluator cannot express honestly (a
 * median over 0/1 samples is not a ratio, and one samples array cannot carry
 * both a detection ratio and its judgment count). They are computed by
 * `panel/verdict.ts` against the same contract entries and merged into the run
 * by `panel/run.ts`; the panel owns the property, not this discovery list.
 *
 * The module registers only what it owns, so a property without an evaluator
 * still fails closed.
 */

import { h6Evaluator } from "../../judges/h6";
import type { EvaluatorModule } from "../types";

const human: EvaluatorModule = {
  family: "human",
  evaluators: [h6Evaluator],
};

export default human;

export { judgePanel } from "../../panel/verdict";
export { applyPanelVerdict } from "../../panel/run";
