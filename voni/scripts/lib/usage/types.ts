/**
 * `demo:usage` — the per-run vendor usage ledger.
 *
 * A run's cost evidence is already on disk: each call's `trace.jsonl` holds one
 * `cost.priced` row, priced by the pipeline with a named rate table. This
 * command reads those rows, groups their quantities and amounts by vendor and
 * scenario, and refuses to total a run whose legs are not all measured. It
 * never multiplies a unit by a rate of its own and never turns an absent
 * measurement into a zero.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Evidence artifacts".
 */

import type { PricedCost } from "@/lib/demo/verification/economics";

/** Bad input and missing evidence share exit 2, never one message. */
export const USAGE_REFUSAL_EXIT_CODE = 2 as const;

export const USAGE_ERROR_CODES = [
  "bad-input",
  "unknown-run",
  "incomplete-run",
  "missing-evidence",
  "torn-row",
  "missing-rate-table",
  "unknown-vendor",
  "run-journal-not-implemented",
] as const;

export type UsageErrorCode = (typeof USAGE_ERROR_CODES)[number];

export class UsageCliError extends Error {
  readonly code: UsageErrorCode;
  readonly exitCode = USAGE_REFUSAL_EXIT_CODE;

  constructor(code: UsageErrorCode, message: string) {
    super(message);
    this.name = "UsageCliError";
    this.code = code;
  }
}

export function refuse(code: UsageErrorCode, message: string): never {
  throw new UsageCliError(code, message);
}

/** The two billing vendors the cascade opens. */
export const VENDORS = ["meta", "assemblyai"] as const;

export type VendorId = (typeof VENDORS)[number];

/**
 * The one leg → vendor map. An unknown leg is refused rather than attributed
 * to a guess: a dollar with no vendor cannot be reconciled against a page.
 */
export const LEG_VENDOR: Readonly<Record<string, VendorId>> = {
  stt: "meta",
  llm: "meta",
  tts: "assemblyai",
};

export const VENDOR_LABEL: Readonly<Record<VendorId, string>> = {
  meta: "Meta",
  assemblyai: "AssemblyAI",
};

/** One billable line the dashboards report, and the leg that carries it. */
export type UnitLine = {
  readonly id: string;
  readonly leg: string;
  readonly vendor: VendorId;
  readonly unit: string;
  readonly label: string;
  /**
   * True only when the row's quantity is the one the rate multiplies. The LLM
   * parent lines are reported but netted before pricing, so a rate beside them
   * would invite arithmetic the row never charged.
   */
  readonly rateApplies: boolean;
  /** How to read a reported-but-not-billed quantity; null on a direct line. */
  readonly note: string | null;
};

export const UNIT_LINES: readonly UnitLine[] = [
  {
    id: "stt.audio_seconds",
    leg: "stt",
    vendor: "meta",
    unit: "audio_seconds",
    label: "audio seconds",
    rateApplies: true,
    note: null,
  },
  {
    id: "llm.prompt_tokens",
    leg: "llm",
    vendor: "meta",
    unit: "prompt_tokens",
    label: "prompt tokens",
    rateApplies: false,
    note: "reported, includes cached",
  },
  {
    id: "llm.completion_tokens",
    leg: "llm",
    vendor: "meta",
    unit: "completion_tokens",
    label: "completion tokens",
    rateApplies: false,
    note: "reported, includes reasoning",
  },
  {
    id: "llm.cached_tokens",
    leg: "llm",
    vendor: "meta",
    unit: "cached_tokens",
    label: "cached tokens",
    rateApplies: true,
    note: "billed at the cached rate, inside prompt tokens",
  },
  {
    id: "llm.reasoning_tokens",
    leg: "llm",
    vendor: "meta",
    unit: "reasoning_tokens",
    label: "reasoning tokens",
    rateApplies: false,
    note: "reported, inside completion tokens",
  },
  {
    id: "tts.characters",
    leg: "tts",
    vendor: "assemblyai",
    unit: "characters",
    label: "characters",
    rateApplies: true,
    note: null,
  },
  {
    id: "tts.audio_seconds",
    leg: "tts",
    vendor: "assemblyai",
    unit: "audio_seconds",
    label: "audio seconds",
    rateApplies: true,
    note: null,
  },
  {
    id: "tts.session_seconds",
    leg: "tts",
    vendor: "assemblyai",
    unit: "session_seconds",
    label: "session seconds",
    rateApplies: true,
    note: null,
  },
];

export const UNIT_LINE_IDS = UNIT_LINES.map((line) => line.id);

/** One call's evidence, as read from its run directory. */
export type UsageCall = {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: string | null;
  readonly priced: PricedCost;
  /** leg → unit → the quantity the row recorded; absent units stay absent. */
  readonly units: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly tracePath: string;
};

/** The evidence set one run id resolves to. */
export type UsageRun = {
  readonly runId: string;
  readonly kind: "directory" | "certificate" | "journal";
  readonly calls: readonly UsageCall[];
  /** The plan's calls: the certificate's required repetitions, or one adapter call. */
  readonly expectedCalls: number | null;
  /** Human-readable path(s) the run was read from. */
  readonly source: string;
};

/** Why a leg or unit is in the unmeasured section. */
export type UnmeasuredKind = "price" | "usage";

export type UnmeasuredLeg = {
  readonly callId: string;
  readonly scenario: string;
  readonly leg: string;
  readonly vendor: VendorId | null;
  /** The unit line the row lacks, for a usage gap; null for a whole leg. */
  readonly lineId: string | null;
  readonly kind: UnmeasuredKind;
  readonly reason: string;
};

export type UsageLineTotal = {
  readonly id: string;
  readonly leg: string;
  readonly vendor: VendorId;
  readonly unit: string;
  readonly label: string;
  readonly note: string | null;
  readonly rateApplies: boolean;
  readonly quantity: number | null;
  /** Calls that recorded this unit; zero is a measured value, not absence. */
  readonly measuredCalls: number;
  /** Calls whose leg was priced but whose row did not carry this unit. */
  readonly missingCalls: number;
  /** Calls whose whole leg is unmeasured; their units are unknown, not zero. */
  readonly unmeasuredCalls: number;
  readonly rateUsdPerUnit: number | null;
  readonly rateVersions: readonly string[];
};

export type LegTotal = {
  readonly leg: string;
  readonly vendor: VendorId;
  /** Sum of the row's own measured amounts; never a quantity × rate here. */
  readonly usd: number;
  readonly pricedCalls: number;
  readonly unmeasuredCalls: number;
  readonly rateVersions: readonly string[];
};

export type VendorTotal = {
  readonly vendor: VendorId;
  readonly usd: number;
  readonly legs: readonly LegTotal[];
  readonly pricedCalls: number;
  readonly unmeasuredCalls: number;
  readonly complete: boolean;
};

export type ScenarioTotal = {
  readonly scenario: string;
  readonly locale: string | null;
  readonly calls: number;
  readonly usd: number;
  readonly metaUsd: number;
  readonly assemblyaiUsd: number;
  readonly unmeasuredCalls: number;
  readonly metaComplete: boolean;
  readonly assemblyaiComplete: boolean;
};

export type UsageLedger = {
  readonly runId: string;
  readonly source: string;
  readonly calls: readonly UsageCall[];
  readonly vendors: readonly VendorTotal[];
  readonly legs: readonly LegTotal[];
  readonly lines: readonly UsageLineTotal[];
  readonly scenarios: readonly ScenarioTotal[];
  readonly unmeasured: readonly UnmeasuredLeg[];
  /** True only when every leg and every unit is measured. */
  readonly complete: boolean;
  /** The measured subset; a complete run's total. */
  readonly totalUsd: number;
  /** The plan's calls; null only when the evidence records no plan. */
  readonly expectedCalls: number | null;
  /** Why measured calls fall short of the plan; null when the plan is met. */
  readonly planGap: string | null;
  readonly rateVersions: readonly string[];
  /** Calls that opened no session and are measured zeros. */
  readonly zeroCalls: number;
};
