import type { ContractFamily } from "../types";

/**
 * Human qualities. Spec table "Human qualities", H1–H7.
 *
 * H6 is owned here by ticket 26: `verdict/evaluators/human.evaluators.ts`
 * calibrates the judges against the panel's gold labels and fails closed when
 * the calibration is absent, below the 0.65 bar or scored against another
 * rubric. H1–H5 and H7 are added by the panel ticket.
 */
const human: ContractFamily = {
  family: "human",
  title: "Human qualities",
  properties: [
    {
      id: "H1",
      statement: '"Would you stay on this call?"',
      bar: { text: ">= 80% yes; no Locale < 70%", numeric: true },
      evidence: "panel",
      kind: "behaviour",
      thresholds: [
        { source: "budget-record", key: "dvStayOnCallYesMinRatio" },
        { source: "budget-record", key: "dvStayOnCallLocaleMinRatio" },
      ],
    },
    {
      id: "H2",
      statement: "Blind A/B human detection",
      bar: { text: "40-60% per Locale, >= 40 judgments", numeric: true },
      evidence: "panel",
      kind: "behaviour",
      thresholds: [
        { source: "budget-record", key: "dvHumanDetectionMinRatio" },
        { source: "budget-record", key: "dvHumanDetectionMaxRatio" },
        { source: "budget-record", key: "dvHumanDetectionMinJudgments" },
      ],
    },
    {
      id: "H3",
      statement: "Sounds human",
      bar: { text: "median >= 4; no call < 3", numeric: true },
      evidence: "panel",
      kind: "behaviour",
      thresholds: [
        { source: "budget-record", key: "dvSoundsHumanMedianMin" },
        { source: "budget-record", key: "dvSoundsHumanCallMin" },
      ],
    },
    {
      id: "H4",
      statement: "Turn-taking feels natural",
      bar: { text: "median >= 4", numeric: true },
      evidence: "panel",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvTurnTakingMedianMin" }],
    },
    {
      id: "H5",
      statement: "Preference against the human baseline",
      bar: { text: "agent not preferred < 40%", numeric: true },
      evidence: "panel",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvAgentNotPreferredMaxRatio" }],
    },
    {
      id: "H6",
      statement: "Judge agreement with gold labels",
      bar: { text: "weighted kappa >= 0.65, else unverified", numeric: true },
      evidence: "judge",
      kind: "behaviour",
      thresholds: [{ source: "budget-record", key: "dvJudgeKappaMin" }],
    },
    {
      id: "H7",
      statement: "Panel signature",
      bar: { text: "present, named, dated", numeric: false },
      evidence: "panel",
      kind: "deterministic",
      thresholds: [],
    },
  ],
};

export default human;
