import type { ContractFamily } from "../types";

/**
 * Human qualities. Spec table "Human qualities", H1–H7.
 *
 * H6 is deliberately unresolved. The panel ticket computes H1–H5 and H7, the
 * judge ticket owns the kappa arithmetic, and no ticket owns the property that
 * joins them. It is wired to the judge evidence source and marked unresolved so
 * the verdict engine fails closed instead of passing it silently.
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
      unresolved: {
        reason:
          "No owning evaluator ticket: ticket 27 computes H1-H5 and H7 and ticket 26 owns the kappa arithmetic, but no ticket joins them. Wired to the judge evidence source so the verdict engine reports it unresolved and the run fails closed; ticket 27 or 26 must claim it.",
      },
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
