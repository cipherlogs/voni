/**
 * The certification scopes an owner may declare, and the dated decision behind
 * each. The scope is an input to the certificate, never inferred from the
 * Locales that happened to run: the CLI picks one of these declared sets, the
 * builder records it, and a run outside it refuses.
 *
 * The owner decided on 2026-11-02 that Voni ships English only. That makes
 * `en` the declared scope of the English-only certificate; es, fr, de and pt
 * are out of scope by that decision, not gaps and not failures. The full
 * five-Locale run remains possible and declares all five, so no Locale is ever
 * silently dropped from a claim.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Evidence artifacts" and
 * "Scenario corpus and Locale matrix"; docs/agents/demo-verification.md,
 * "Certification scope".
 */

import { LOCALES, type Locale } from "../scenarios";
import type { CertificationScope, ScopeDecision } from "./types";

/** The owner's binding decision; every declared scope carries these fields. */
export const SCOPE_DECISION: ScopeDecision = {
  decidedBy: "owner",
  decidedOn: "2026-11-02",
  reason:
    "English-only launch: Voni ships English; es, fr, de and pt are untested by owner decision",
};

/** The English-only scope the owner declared on 2026-11-02. */
export const ENGLISH_ONLY_SCOPE: CertificationScope = {
  locales: ["en"],
  ...SCOPE_DECISION,
};

/** The full five-Locale scope: every demo Locale is a required claim. */
export const FULL_SCOPE: CertificationScope = {
  locales: [...LOCALES],
  ...SCOPE_DECISION,
  reason: "full five-Locale certification: every demo Locale is in scope",
};

/** The Locales a declared scope leaves out, in demo order. */
export function outOfScopeLocales(scope: readonly Locale[]): Locale[] {
  return LOCALES.filter((locale) => !scope.includes(locale));
}

/**
 * The declared scopes the CLI may issue. A narrower multi-Locale set would be a
 * fresh owner decision, so the command refuses it rather than inventing one.
 */
export function declaredScopeFor(locales: readonly Locale[]): CertificationScope | null {
  if (locales.length === 1 && locales[0] === "en") return ENGLISH_ONLY_SCOPE;
  if (locales.length === LOCALES.length && LOCALES.every((locale) => locales.includes(locale))) {
    return FULL_SCOPE;
  }
  return null;
}
