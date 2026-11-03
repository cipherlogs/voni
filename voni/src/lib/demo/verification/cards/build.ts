/**
 * Build one defect card per failed property from the verdicts and the call
 * evidence the runner assembled.
 *
 * The rules, in order, are the ticket's:
 *
 * 1. A failed property with no attribution is refused by name; a card is never
 *    produced without a session to start triage from.
 * 2. A turn-level property (`ledger`, `trace`, `wav`, `browser`, `tool`) must
 *    name a turn that exists in the call's ledger. A call-level property
 *    (`cost`, `panel`, `judge`, `pytest`) names the absence instead.
 * 3. Every card cites at least one evidence file, and every cited file must
 *    exist. A missing file is a refusal, never a card that points at nothing.
 * 4. Every audio excerpt resolves inside the caller take or delivered WAV it
 *    names, by that file's own header.
 * 5. Every card names modules by path; a line number or a pointer to nothing is
 *    refused because both drift.
 *
 * The replay command is parsed here as it is emitted, so a card that reaches a
 * reader is already accepted by the parser the runner must use.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Evidence artifacts".
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { EvidenceSource, ResolvedThreshold } from "../contract";
import { LOCALES, type Locale } from "../scenarios";
import type { PropertyVerdict, ScenarioVerdict } from "../verdict";

import { DefectCardError, type DefectCardErrorCode } from "./errors";
import { parseReplayCommand, replayCommand } from "./replay";
import { severityFor } from "./severity";
import {
  CARD_TARGETS,
  EXCERPT_MEDIA,
  type AudioExcerpt,
  type BuildDefectCardsInput,
  type CallEvidence,
  type DefectAttribution,
  type DefectCard,
  type ExcerptMedia,
  type TurnEvidence,
} from "./types";
import { wavDurationMs } from "./wav";

/**
 * Evidence that is measured per turn. A failure here must name the ledger's
 * turn; the rest is measured per call and names the session only.
 */
const TURN_LEVEL_SOURCES: ReadonlySet<EvidenceSource> = new Set([
  "ledger",
  "trace",
  "wav",
  "browser",
  "tool",
]);

/** Evidence measured per call: a failure cites the session, not a turn. */
const CALL_LEVEL_SOURCES: ReadonlySet<EvidenceSource> = new Set([
  "cost",
  "panel",
  "judge",
  "pytest",
]);

/**
 * Properties whose evidence source is nominally turn-level but whose fact is
 * measured before any turn exists: the connect, greeting and ending checks.
 * A greeting-only call may have zero turns, and a connect check always precedes
 * one; requiring a turn would suppress the card for the exact failures the
 * lifecycle family exists to report. Every other turn-level property still
 * needs a turn.
 */
export const CALL_LEVEL_PROPERTY_IDS: ReadonlySet<string> = new Set([
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
  "L8",
  "L9",
  "L10",
  "L11",
  "C1",
  "C2",
]);

function refuse(code: DefectCardErrorCode, message: string): never {
  throw new DefectCardError(code, message);
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function existingFile(file: string, repoRoot: string, what: string): void {
  if (file.trim() === "") {
    refuse("missing-evidence-file", `${what} cites an empty evidence path`);
  }
  const full = isAbsolute(file) ? file : resolve(repoRoot, file);
  if (!existsSync(full) || !statSync(full).isFile()) {
    refuse("missing-evidence-file", `${what} cites "${file}", which does not exist`);
  }
}

/**
 * A pooled bar can fail while every scenario's own tail passes. That is a real
 * failure over the scenarios that fed the pool, so any one of them is a valid
 * replay target — but the attribution must say which when there is more than
 * one, because the card may not guess.
 */
function pooledFailure(property: PropertyVerdict): boolean {
  return property.checks.some((check) => check.scenario === null && !check.passed);
}

/** Pick the one failed scenario the attribution points at. */
function selectScenario(
  property: PropertyVerdict,
  attribution: DefectAttribution,
): ScenarioVerdict {
  const failed = property.scenarios.filter((scenario) => scenario.status === "FAIL");
  if (attribution.scenario !== undefined) {
    const named = property.scenarios.find(
      (scenario) => scenario.scenario === attribution.scenario,
    );
    if (named === undefined) {
      refuse(
        "no-failed-scenario",
        `${property.propertyId}: attribution names scenario "${attribution.scenario}", which the verdict does not carry`,
      );
    }
    if (named.status !== "FAIL" && !pooledFailure(property)) {
      refuse(
        "scenario-mismatch",
        `${property.propertyId}: attribution names scenario "${attribution.scenario}", but that scenario passed; ` +
          "a card is never built for a passing scenario",
      );
    }
    return named;
  }
  if (failed.length === 1) return failed[0];
  if (failed.length > 1) {
    refuse(
      "ambiguous-scenario",
      `${property.propertyId}: failed in ${failed.map((scenario) => `"${scenario.scenario}"`).join(", ")}; ` +
        "the attribution must name the scenario the card replays",
    );
  }
  if (property.scenarios.length === 0) {
    refuse(
      "no-failed-scenario",
      `${property.propertyId}: the property failed with no scenario; there is no call to cite`,
    );
  }
  if (property.scenarios.length === 1) {
    // A pooled failure can leave every scenario tail green; the one scenario is
    // still the run the card replays.
    return property.scenarios[0];
  }
  refuse(
    "ambiguous-scenario",
    `${property.propertyId}: the pooled bar failed across ` +
      `${property.scenarios.map((scenario) => `"${scenario.scenario}"`).join(", ")}; ` +
      "the attribution must name the scenario the card replays",
  );
}

function selectCall(
  input: BuildDefectCardsInput,
  attribution: DefectAttribution,
  property: PropertyVerdict,
): CallEvidence {
  const matches = input.calls.filter((call) => call.callId === attribution.callId);
  if (matches.length === 0) {
    refuse(
      "unknown-session",
      `${property.propertyId}: attribution names session "${attribution.callId}", which the run evidence does not carry`,
    );
  }
  if (matches.length > 1) {
    refuse(
      "duplicate-session",
      `${property.propertyId}: session "${attribution.callId}" appears ${matches.length} times; one session has one record`,
    );
  }
  return matches[0];
}

function selectTurn(
  property: PropertyVerdict,
  call: CallEvidence,
  attribution: DefectAttribution,
): { turn: TurnEvidence | null; absence: string | null } {
  const callLevelProperty = CALL_LEVEL_PROPERTY_IDS.has(property.propertyId);
  const turnLevel = TURN_LEVEL_SOURCES.has(property.evidence) && !callLevelProperty;
  if (!turnLevel && !CALL_LEVEL_SOURCES.has(property.evidence) && !callLevelProperty) {
    refuse(
      "unknown-evidence",
      `${property.propertyId}: evidence source "${String(property.evidence)}" is neither turn-level nor call-level; ` +
        "a card may not guess where to look",
    );
  }
  if (attribution.turn === undefined) {
    if (turnLevel) {
      refuse(
        "turn-required",
        `${property.propertyId} is judged from ${property.evidence} evidence at turn level; ` +
          `session "${call.callId}" has no attributed turn`,
      );
    }
    return {
      turn: null,
      absence:
        `${property.propertyId} is judged from ${property.evidence} evidence at call level; ` +
        `session "${call.callId}" has no turn to cite`,
    };
  }
  const turnId = attribution.turn.trim();
  if (turnId === "") {
    refuse(
      "turn-required",
      `${property.propertyId}: attribution names an empty turn for session "${call.callId}"`,
    );
  }
  const matches = call.turns.filter((turn) => turn.turn === turnId);
  if (matches.length === 0) {
    refuse(
      "unknown-turn",
      `${property.propertyId}: session "${call.callId}" has no turn "${turnId}"; the ledger does not name it`,
    );
  }
  if (matches.length > 1) {
    refuse(
      "unknown-turn",
      `${property.propertyId}: session "${call.callId}" names turn "${turnId}" ${matches.length} times; ` +
        "a duplicated turn is not a pointer",
    );
  }
  return { turn: matches[0], absence: null };
}

function validateExcerpts(
  raw: readonly AudioExcerpt[],
  media: { callerTake?: string; deliveredWav?: string },
  scope: string,
): AudioExcerpt[] {
  const seen = new Set<ExcerptMedia>();
  return raw.map((excerpt) => {
    if (!(EXCERPT_MEDIA as readonly string[]).includes(excerpt.media)) {
      refuse(
        "invalid-excerpt",
        `${scope}: excerpt media "${String(excerpt.media)}" is not one of ${EXCERPT_MEDIA.join(", ")}`,
      );
    }
    if (seen.has(excerpt.media)) {
      refuse("invalid-excerpt", `${scope}: ${excerpt.media} has more than one excerpt`);
    }
    seen.add(excerpt.media);

    const declared = excerpt.media === "caller-take" ? media.callerTake : media.deliveredWav;
    if (declared === undefined || declared === "") {
      refuse(
        "audio-media-mismatch",
        `${scope}: excerpt names a ${excerpt.media}, but the evidence carries none`,
      );
    }
    if (resolve(declared) !== resolve(excerpt.file)) {
      refuse(
        "audio-media-mismatch",
        `${scope}: excerpt names "${excerpt.file}", but the ${excerpt.media} is "${declared}"`,
      );
    }

    if (
      !Number.isFinite(excerpt.startMs) ||
      !Number.isFinite(excerpt.endMs) ||
      excerpt.startMs < 0 ||
      excerpt.endMs <= excerpt.startMs
    ) {
      refuse(
        "invalid-excerpt",
        `${scope}: excerpt [${String(excerpt.startMs)}, ${String(excerpt.endMs)}] ms is not a forward span`,
      );
    }

    const duration = wavDurationMs(excerpt.file);
    if (excerpt.endMs > duration) {
      refuse(
        "excerpt-out-of-bounds",
        `${scope}: excerpt ends at ${excerpt.endMs} ms, past the ${duration} ms in "${excerpt.file}"`,
      );
    }

    return {
      media: excerpt.media,
      file: excerpt.file,
      startMs: excerpt.startMs,
      endMs: excerpt.endMs,
    };
  });
}

/**
 * The frozen numbers the verdict actually judged, in check order. A property
 * that failed before a check existed (no evaluator, missing evidence) carries
 * none: the card shows the bar in words rather than inventing a number.
 */
function resolvedThresholds(property: PropertyVerdict): ResolvedThreshold[] {
  const byKey = new Map<string, ResolvedThreshold>();
  for (const check of property.checks) {
    if (byKey.has(check.key)) continue;
    byKey.set(check.key, {
      source: check.source,
      key: check.key,
      value: check.budget,
      unit: check.unit,
    });
  }
  return [...byKey.values()];
}

function validateModules(
  property: PropertyVerdict,
  input: BuildDefectCardsInput,
): string[] {
  const pointers = input.modules[property.propertyId] ?? [];
  if (pointers.length === 0) {
    refuse(
      "missing-modules",
      `${property.propertyId}: no module pointer; a card must say where to look`,
    );
  }
  for (const pointer of pointers) {
    if (typeof pointer !== "string" || pointer.trim() === "") {
      refuse("module-pointer", `${property.propertyId}: a module pointer is empty`);
    }
    if (/:\d+|#L\d+|#\d+/.test(pointer)) {
      refuse(
        "module-pointer",
        `${property.propertyId}: module pointer "${pointer}" embeds a line number, which drifts; name the file only`,
      );
    }
    if (isAbsolute(pointer) || pointer.split(/[\\/]/).includes("..")) {
      refuse(
        "module-pointer",
        `${property.propertyId}: module pointer "${pointer}" must be a repo-relative path inside the repository`,
      );
    }
    const full = join(input.repoRoot, pointer);
    if (!existsSync(full) || !statSync(full).isFile()) {
      refuse(
        "missing-module-file",
        `${property.propertyId}: module pointer "${pointer}" resolves to no file under "${input.repoRoot}"`,
      );
    }
  }
  return [...pointers];
}

function buildCard(
  property: PropertyVerdict,
  input: BuildDefectCardsInput,
  attribution: DefectAttribution,
): DefectCard {
  const scenario = selectScenario(property, attribution);
  const call = selectCall(input, attribution, property);

  if (call.scenario !== scenario.scenario) {
    refuse(
      "scenario-mismatch",
      `${property.propertyId}: session "${call.callId}" ran scenario "${call.scenario}", ` +
        `but the card replays "${scenario.scenario}"`,
    );
  }
  const locale = scenario.locale ?? call.locale;
  if (scenario.locale !== undefined && call.locale !== scenario.locale) {
    refuse(
      "locale-mismatch",
      `${property.propertyId}: session "${call.callId}" ran Locale "${call.locale}", ` +
        `but the failing scenario is "${scenario.locale}"`,
    );
  }
  if (!(LOCALES as readonly string[]).includes(locale)) {
    refuse(
      "locale-mismatch",
      `${property.propertyId}: scenario "${scenario.scenario}" names Locale "${locale}", ` +
        `which is not one of ${LOCALES.join(", ")}`,
    );
  }
  const cardLocale = locale as Locale;
  if (call.target !== input.target) {
    refuse(
      "target-mismatch",
      `${property.propertyId}: session "${call.callId}" ran target "${call.target}", ` +
        `but the card replays "${input.target}"`,
    );
  }

  const { turn, absence } = selectTurn(property, call, attribution);

  const turnFiles = turn?.evidenceFiles ?? [];
  const callFiles = call.evidenceFiles ?? [];
  if (turn !== null && turnFiles.length === 0) {
    refuse(
      "missing-evidence",
      `${property.propertyId}: turn "${turn.turn}" of session "${call.callId}" cites no evidence file`,
    );
  }
  if (turn === null && callFiles.length === 0) {
    refuse(
      "missing-evidence",
      `${property.propertyId}: session "${call.callId}" cites no evidence file`,
    );
  }
  const evidenceFiles = unique([...turnFiles, ...callFiles]);
  for (const file of evidenceFiles) {
    existingFile(file, input.repoRoot, `session "${call.callId}"`);
  }

  const rawExcerpts = turn !== null ? (turn.excerpts ?? []) : (call.excerpts ?? []);
  if (rawExcerpts.length === 0) {
    refuse(
      "missing-audio",
      turn !== null
        ? `${property.propertyId}: turn "${turn.turn}" of session "${call.callId}" cites no audio excerpt`
        : `${property.propertyId}: session "${call.callId}" cites no call-level audio excerpt`,
    );
  }
  const audioExcerpts = validateExcerpts(
    rawExcerpts,
    turn !== null
      ? { callerTake: turn.callerTake, deliveredWav: turn.deliveredWav }
      : { deliveredWav: call.deliveredWav },
    turn !== null ? `turn "${turn.turn}"` : `session "${call.callId}"`,
  );

  const modules = validateModules(property, input);

  const failingChecks = property.checks.filter((check) => !check.passed);
  const firstFailing = failingChecks[0];
  const command = replayCommand({
    scenario: scenario.scenario,
    target: input.target,
    locale: cardLocale,
  });
  // A card that reaches a reader is already accepted by the runner's parser.
  parseReplayCommand(command);

  return {
    id: `${input.verdict.runId}/${property.propertyId}`,
    propertyId: property.propertyId,
    property: property.statement,
    family: property.family,
    scenario: scenario.scenario,
    locale: cardLocale,
    target: input.target,
    expectedBar: {
      text: property.bar,
      numeric: property.barNumeric,
      thresholds: resolvedThresholds(property),
    },
    observed: {
      value: firstFailing?.observed ?? null,
      unit: firstFailing?.unit ?? "",
      statistic: firstFailing?.statistic ?? null,
      detail: property.detail,
      checks: failingChecks,
    },
    severity: severityFor(property.family),
    citation: {
      session: call.callId,
      scenario: scenario.scenario,
      locale: cardLocale,
      target: input.target,
      turn: turn?.turn ?? null,
      turnAbsence: absence,
      audioExcerpts,
      evidenceFiles,
    },
    modules,
    replayCommand: command,
    detail: property.detail,
    verdictReason: property.reason,
    gaps: [...property.gaps],
  };
}

/**
 * One card per failed property. A passing property may not be attributed; a
 * failed property without an attribution is refused by name.
 */
export function buildDefectCards(input: BuildDefectCardsInput): DefectCard[] {
  const runId = input.verdict.runId.trim();
  if (runId === "") {
    refuse("invalid-run", "the verdict carries no run id; a card id would not be unique");
  }
  if (!(CARD_TARGETS as readonly string[]).includes(input.target)) {
    refuse("invalid-run", `run target "${input.target}" is not one of ${CARD_TARGETS.join(", ")}`);
  }

  const byProperty = new Map<string, PropertyVerdict>();
  for (const property of input.verdict.properties) {
    if (byProperty.has(property.propertyId)) {
      refuse(
        "invalid-run",
        `the verdict carries property "${property.propertyId}" more than once; one property has one verdict`,
      );
    }
    byProperty.set(property.propertyId, property);
  }

  const attributions = new Map<string, DefectAttribution>();
  for (const attribution of input.attributions) {
    if (attributions.has(attribution.propertyId)) {
      refuse(
        "duplicate-attribution",
        `property "${attribution.propertyId}" has two attributions; one failure has one session and turn`,
      );
    }
    const property = byProperty.get(attribution.propertyId);
    if (property === undefined) {
      refuse(
        "unknown-property",
        `attribution names property "${attribution.propertyId}", which the verdict does not carry`,
      );
    }
    if (property.status !== "FAIL") {
      refuse(
        "card-for-pass",
        `attribution names property "${attribution.propertyId}", which passed; a defect card is never built for a pass`,
      );
    }
    attributions.set(attribution.propertyId, attribution);
  }

  const failed = input.verdict.properties.filter((property) => property.status === "FAIL");
  for (const property of failed) {
    if (!attributions.has(property.propertyId)) {
      refuse(
        "missing-attribution",
        `${property.propertyId} failed with no session and turn; triage may not start from a card without a pointer`,
      );
    }
  }

  return failed.map((property) =>
    buildCard(property, input, attributions.get(property.propertyId) as DefectAttribution),
  );
}
