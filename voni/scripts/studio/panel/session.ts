/**
 * Panel session assembly: the twelve-call blind sample the owner rates.
 *
 * A panel session is a Studio rating session with a fixed shape: twelve calls,
 * every failing call mandatory, and a clean base drawn from the certificate's
 * declared scope. A multi-Locale scope keeps two calls per Locale; a one-Locale
 * scope draws one clean call per scenario class in the certificate's recorded
 * scenario set (nine in the current English corpus, of ten declared; not two per
 * class, which would exceed twelve) and fills the remaining slots with the worst
 * clean calls. A Locale inside the scope with no call, a call from a Locale the
 * scope excludes, more classes than the sample can hold, a failing call whose
 * evidence is missing, or a run with fewer than twelve eligible calls refuses
 * the session by name.
 *
 * This module lives under `scripts/studio/` because the Studio is a local-only
 * script process; `voni/src/` holds the pure panel vocabulary and verdict.
 */

import type { Certificate } from "../../../src/lib/demo/verification/certificate/types";
import { LOCALES } from "../../../src/lib/demo/verification/scenarios/types";
import {
  PANEL_CALLS_PER_CLASS,
  PANEL_CALLS_PER_LOCALE,
  PANEL_SAMPLE_SIZE,
} from "../../../src/lib/demo/verification/panel/types";
import { PanelError } from "../../../src/lib/demo/verification/panel/errors";
import {
  blindSession,
  buildRatingSession,
  certificateFailingScenarios,
  RatingError,
  type BlindSession,
  type RatingCallInput,
  type RatingSession,
} from "../rate";

export type BuildPanelSessionInput = {
  readonly certificate: Certificate;
  readonly calls: readonly RatingCallInput[];
  readonly reviewer: string;
  readonly seed: number;
  readonly createdAt: string;
};

export type PanelSession = {
  readonly session: RatingSession;
  readonly blind: BlindSession;
};

function certificateCall(scenario: string, certificate: Certificate): string[] {
  const calls: string[] = [];
  for (const row of certificate.coverage.rows) {
    if (row.scenario !== scenario) continue;
    for (const callId of row.calls) calls.push(callId);
  }
  return calls;
}

/**
 * Build the one blind session a panel rates. The session id, queue order and
 * A/B answer keys are the rating store's; this function enforces the panel's
 * confirmed sample composition — twelve calls total, two per Locale as the
 * base, the two worst remaining failing calls in the extra slots and every
 * failing call mandatory (so a run with more failures grows past twelve) — and
 * names every shortfall.
 */
export function buildPanelSession(input: BuildPanelSessionInput): PanelSession {
  if (typeof input.reviewer !== "string" || input.reviewer.trim() === "") {
    throw new PanelError(
      "missing-reviewer",
      "a panel session needs a named reviewer; the owner signs the certificate and is never anonymous",
    );
  }
  if (!Array.isArray(input.calls) || input.calls.length === 0) {
    throw new PanelError("empty-panel", "a panel session needs call evidence; nothing was supplied");
  }

  const scope = input.certificate.scope?.locales ?? LOCALES;
  for (const call of input.calls) {
    if (!scope.includes(call.locale)) {
      throw new PanelError(
        "out-of-scope-call",
        `call "${call.callId}" speaks Locale "${call.locale}", which the certificate's declared ` +
          `scope (${scope.join(", ")}) excludes; an excluded Locale is neutral and never sampled`,
      );
    }
  }

  const supplied = new Set(input.calls.map((call) => call.callId));
  const failing = certificateFailingScenarios(input.certificate);
  for (const scenario of failing) {
    const calls = certificateCall(scenario, input.certificate);
    if (calls.length === 0) {
      throw new PanelError(
        "missing-failing-call",
        `the certificate fails scenario "${scenario}" but names no call for it; every failing call ` +
          "is mandatory in the panel",
      );
    }
    const missing = calls.filter((callId) => !supplied.has(callId));
    if (missing.length > 0) {
      throw new PanelError(
        "missing-failing-call",
        `the certificate fails scenario "${scenario}" but the panel has no evidence for ` +
          `${missing.join(", ")}; every failing call is mandatory`,
      );
    }
  }

  for (const locale of scope) {
    const calls = input.calls.filter((call) => call.locale === locale);
    if (calls.length === 0) {
      throw new PanelError(
        "missing-locale",
        `the panel has no call for Locale "${locale}", which the certificate's scope declares; ` +
          `every in-scope Locale needs calls (out of scope: ${LOCALES.filter((entry) => !scope.includes(entry)).join(", ") || "none"})`,
      );
    }
    if (calls.length < PANEL_CALLS_PER_LOCALE) {
      throw new PanelError(
        "locale-shortfall",
        `Locale "${locale}" has ${calls.length} call(s); the panel requires ` +
          `${PANEL_CALLS_PER_LOCALE} per in-scope Locale`,
      );
    }
  }

  // A one-Locale scope groups the clean sample by scenario class so the twelve
  // still cover the corpus's behaviours; a multi-Locale scope keeps Locale.
  const oneLocale = scope.length === 1;
  let cleanGroupOf: Record<string, string> | undefined;
  if (oneLocale) {
    const classOf = new Map(
      input.certificate.coverage.rows
        .filter((row) => row.locale === scope[0])
        .map((row) => [row.scenario, row.class]),
    );
    const groups: Record<string, string> = {};
    for (const call of input.calls) {
      const scenarioClass = classOf.get(call.scenario);
      if (scenarioClass === null || scenarioClass === undefined) {
        throw new PanelError(
          "missing-scenario-class",
          `call "${call.callId}" names scenario "${call.scenario}" with no recorded class; a ` +
            "one-Locale panel samples across classes and cannot group an unclassed scenario",
        );
      }
      groups[call.callId] = scenarioClass;
    }
    cleanGroupOf = groups;
    const cleanClasses = new Set(
      input.calls
        .filter((entry) => !failing.has(entry.scenario))
        .map((entry) => groups[entry.callId]),
    );
    if (cleanClasses.size > PANEL_SAMPLE_SIZE) {
      throw new PanelError(
        "class-shortfall",
        `a one-Locale scope samples one clean call per scenario class, but this run holds ` +
          `${cleanClasses.size} classes and the panel samples ${PANEL_SAMPLE_SIZE}; a grouping ` +
          "with more classes than slots refuses rather than queueing more labels than claimed",
      );
    }
  }

  if (input.calls.length < PANEL_SAMPLE_SIZE) {
    throw new PanelError(
      "panel-shortfall",
      `the panel has ${input.calls.length} eligible calls; it samples ${PANEL_SAMPLE_SIZE}. ` +
        "An under-sampled run is refused, never certified on fewer calls",
    );
  }

  let session: RatingSession;
  let blind: BlindSession;
  try {
    session = buildRatingSession({
      certificate: input.certificate,
      calls: input.calls,
      reviewer: input.reviewer,
      seed: input.seed,
      createdAt: input.createdAt,
      cleanPerLocale: PANEL_CALLS_PER_LOCALE,
      cleanPerGroup: oneLocale ? PANEL_CALLS_PER_CLASS : PANEL_CALLS_PER_LOCALE,
      ...(cleanGroupOf === undefined ? {} : { cleanGroupOf }),
      sampleSize: PANEL_SAMPLE_SIZE,
    });
    blind = blindSession(session);
  } catch (error) {
    if (error instanceof PanelError) throw error;
    if (error instanceof RatingError && error.code === "duplicate-call") {
      throw new PanelError("duplicate-call", error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new PanelError(
      "invalid-session",
      `the panel session could not be built: ${message}`,
    );
  }

  const byLocale = scope.map((locale) => ({
    locale,
    count: session.queue.filter((item) => item.locale === locale).length,
  }));
  for (const entry of byLocale) {
    if (entry.count < PANEL_CALLS_PER_LOCALE) {
      throw new PanelError(
        "locale-shortfall",
        `the built session has ${entry.count} call(s) for Locale "${entry.locale}", not ` +
          `${PANEL_CALLS_PER_LOCALE}`,
      );
    }
  }

  return { session, blind };
}
