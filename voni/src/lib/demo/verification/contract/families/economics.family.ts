import type { ContractFamily } from "../types";

/**
 * Economics. Spec table "Economics", E1–E4. Cost is read from the call's own
 * priced row; the run ceilings are the contract's own, not the pipeline's hard
 * per-call ceiling.
 */
const economics: ContractFamily = {
  family: "economics",
  title: "Economics",
  properties: [
    {
      id: "E1",
      statement: "Cost measured every call",
      bar: { text: "unmeasured fails", numeric: false },
      evidence: "cost",
      kind: "deterministic",
      thresholds: [],
    },
    {
      id: "E2",
      statement: "Cost per demo call",
      bar: { text: "<= $0.15", numeric: true },
      evidence: "cost",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvCostPerCallMaxUsd" }],
    },
    {
      id: "E3",
      statement: "Run ceilings",
      bar: { text: "fast <= $2; nightly <= $15; full <= $45", numeric: true },
      evidence: "cost",
      kind: "deterministic",
      thresholds: [
        { source: "budget-record", key: "dvCostFastRunMaxUsd" },
        { source: "budget-record", key: "dvCostNightlyRunMaxUsd" },
        { source: "budget-record", key: "dvCostFullRunMaxUsd" },
      ],
    },
    {
      id: "E4",
      statement: "No budget stop on the golden path",
      bar: { text: "0", numeric: true },
      evidence: "ledger",
      kind: "deterministic",
      thresholds: [{ source: "budget-record", key: "dvBudgetStopMaxCount" }],
    },
  ],
};

export default economics;
