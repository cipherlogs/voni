/**
 * The demo-verification contract's vocabulary.
 *
 * One property is one statement the demo must satisfy, its bar in words, the
 * one evidence source that can judge it, its sample plan and — where the bar is
 * numeric — the keys of the frozen threshold records that carry the numbers.
 * No family file holds a number: a bar that is numeric is a key, and the
 * loader resolves it from `scoreboard-budgets.json` or the cascade threshold
 * registry. A second copy cannot exist here.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "The contract" tables.
 */

/** Ten families, in the spec's order. A family is a file, discovered at load. */
export const FAMILIES = [
  "lifecycle",
  "turn-taking",
  "conduct",
  "comprehension",
  "tools",
  "audio",
  "resilience",
  "security",
  "economics",
  "human",
] as const;

export type FamilyId = (typeof FAMILIES)[number];

/**
 * The spec's nine evidence sources. Exactly one per property: a property with
 * two sources has no owner when they disagree, so the loader refuses it.
 */
export const EVIDENCE_SOURCES = [
  "ledger",
  "trace",
  "wav",
  "browser",
  "tool",
  "cost",
  "panel",
  "judge",
  "pytest",
] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * The two frozen threshold owners. The contract never grows a third record:
 * it names a key here, and the owner resolves it.
 */
export const THRESHOLD_SOURCES = ["budget-record", "cascade-thresholds"] as const;

export type ThresholdSource = (typeof THRESHOLD_SOURCES)[number];

/** A reference to one bar in a frozen record. */
export type ThresholdRef = {
  source: ThresholdSource;
  key: string;
};

/**
 * How often the property runs. The spec fixes the rule: timing and behaviour
 * properties get three repetitions, deterministic properties one. The count is
 * derived from the kind so it is not a second number that can drift.
 */
export const PROPERTY_KINDS = ["timing", "behaviour", "deterministic"] as const;

export type PropertyKind = (typeof PROPERTY_KINDS)[number];

export function repetitionsFor(kind: PropertyKind): 1 | 3 {
  return kind === "deterministic" ? 1 : 3;
}

/** A bar in words, plus whether the owner must resolve a numeric key for it. */
export type Bar = {
  text: string;
  numeric: boolean;
};

export type UnresolvedProperty = {
  /**
   * Why no verdict may be issued. The verdict engine treats an unresolved
   * property as a failure (`unverified`), never as a pass or a skip.
   */
  reason: string;
};

export type ContractProperty = {
  /** `L1`–`L11`, `T1`–`T10`, …; unique across the whole contract. */
  id: string;
  /** The property statement, verbatim from the spec. */
  statement: string;
  /** The bar, verbatim from the spec, and whether it is numeric. */
  bar: Bar;
  /** Exactly one evidence source. */
  evidence: EvidenceSource;
  /** Timing, behaviour or deterministic; drives the repetition count. */
  kind: PropertyKind;
  /** Frozen-record keys. Required for a numeric bar, forbidden otherwise. */
  thresholds: readonly ThresholdRef[];
  /** Present when no owning evaluator exists: fail closed, never pass. */
  unresolved?: UnresolvedProperty;
  /** Recorded gaps that weaken the property; they never count as a pass. */
  gaps?: readonly string[];
};

export type ContractFamily = {
  family: FamilyId;
  title: string;
  properties: readonly ContractProperty[];
};

/** A threshold ref whose number came from its owner's committed record. */
export type ResolvedThreshold = ThresholdRef & {
  value: number;
  unit: string;
};

/** A property after the loader resolved its keys. */
export type ContractPropertyEntry = Omit<ContractProperty, "thresholds"> & {
  family: FamilyId;
  repetitions: 1 | 3;
  thresholds: readonly ResolvedThreshold[];
};

export type ContractFamilySummary = {
  id: FamilyId;
  title: string;
  propertyCount: number;
};

/** The loaded contract: one flat, ordered list and its family summaries. */
export type Contract = {
  families: readonly ContractFamilySummary[];
  properties: readonly ContractPropertyEntry[];
};

/** A value as its owning record carries it. */
export type ThresholdValue = {
  value: number;
  unit: string;
};

/**
 * The committed threshold records, read once. `sources` carries the path and
 * digest that a bar record pins; `values` is what a ref resolves against.
 */
export type ThresholdTables = {
  sources: Record<ThresholdSource, { path: string; sha256: string }>;
  values: Record<ThresholdSource, Record<string, ThresholdValue>>;
};

/** One frozen source record's identity, pinned by the contract bar record. */
export type ContractBarSourcePin = {
  path: string;
  sha256: string;
};

/** The committed drift record: every property's resolved bars and source digests. */
export type ContractBarRecord = {
  version: 1;
  note: string;
  sources: Record<ThresholdSource, ContractBarSourcePin>;
  properties: Record<string, { unresolved: boolean; thresholds: ResolvedThreshold[] }>;
};
