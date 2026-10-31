/**
 * Human-quality evaluators for the verdict core.
 *
 * H6 (judge agreement with gold labels) is owned by ticket 26's calibration
 * gate; H1-H5 and H7 are added by the panel ticket. The module registers only
 * what it owns, so a property without an evaluator still fails closed.
 */

import { h6Evaluator } from "../../judges/h6";
import type { EvaluatorModule } from "../types";

const human: EvaluatorModule = {
  family: "human",
  evaluators: [h6Evaluator],
};

export default human;
