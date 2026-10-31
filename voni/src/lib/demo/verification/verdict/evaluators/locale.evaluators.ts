/**
 * The Locale evaluators: K5 (zero English leaks) and K6 (code-switch understood,
 * reply stays in the Locale).
 *
 * They belong to the comprehension family — the contract files them there — but
 * ticket 16 owns their behaviour: K5 scans the trace and the delivered-audio
 * transcript and cites the offending segment, and K6 requires a judge finding
 * that names the same Locale and cites its turns. The implementations live in
 * `comprehension.evaluators.ts` beside the shared readers; this module is the
 * one discovered owner, so the registry never sees two evaluators for K5 or K6.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Comprehension and content" and
 * "Scenario corpus and Locale matrix"; RR-02 in
 * `docs/agents/demo-verification.md`.
 */

import type { EvaluatorModule } from "../types";
import { k5, k6 } from "./comprehension.evaluators";

const locale: EvaluatorModule = {
  family: "comprehension",
  evaluators: [k5, k6],
};

export default locale;
