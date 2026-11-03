/**
 * Comprehension and content evaluators for the verdict core.
 *
 * K1–K8 each read the one evidence source the contract gives them and compare
 * measured output to the scenario's authored caller words:
 *
 * - K1 reads the tool log's arguments and compares the delivered address to
 *   the last address the caller spelled (the corrected one).
 * - K2 reads the turn transcript and checks every number the caller gave is
 *   read back exactly.
 * - K3 reads the transcript and requires the caller's unusual name exactly
 *   once.
 * - K4 and K6 read the judge's per-property findings; a guess, a loop, or a
 *   reply that leaves the Locale fails.
 * - K5 scans the reply for marker words from another Locale.
 * - K7 counts the judge's invented facts and keeps the quoted line for the
 *   defect card.
 * - K8 compares the caller transcript to the known TTS take text: entities
 *   exact, word error measured but not judged because no frozen bar exists.
 *
 * The protocol adapter does not capture a transcript or tool arguments yet, so
 * every text property is `unmeasured` on a real run. That is intentional:
 * fail closed rather than stubbing evidence no adapter produces.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Comprehension and content".
 */

import type { Evaluation, EvaluatorModule, PropertyEvaluator } from "../types";
import {
  ComprehensionError,
  agentTurns,
  authoredText,
  callerTurns,
  emailArgument,
  localeOf,
  readFacts,
  readFindings,
  readToolCalls,
  readTranscript,
  type JudgeFinding,
  type ReadingTurn,
  type TakeFact,
} from "./comprehension/reading";
import {
  describeLocaleLeak,
  scanLocaleLeaks,
  type LocaleLeakSegment,
} from "./comprehension/locale";
import {
  canonicalEmails,
  canonicalNumbers,
  lastCanonicalEmail,
  spokenName,
  wordError,
} from "./comprehension/text";

export {
  COMPREHENSION_ERROR_CODES,
  ComprehensionError,
  type ComprehensionErrorCode,
} from "./comprehension/reading";

function reasonOf(error: unknown): string {
  if (error instanceof ComprehensionError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function unmeasured(error: unknown): Evaluation {
  return { kind: "unmeasured", reason: reasonOf(error), citations: [] };
}

function turnCitation(turn: string): string {
  return `turn:${turn}`;
}

function factsOf(context: { facts?: unknown }): TakeFact[] {
  return readFacts(context.facts, "the attempt's scenario facts");
}

function findingOf(findings: readonly JudgeFinding[], propertyId: string): JudgeFinding {
  const finding = findings.find((entry) => entry.propertyId === propertyId);
  if (finding === undefined) {
    throw new ComprehensionError(
      "missing-evidence",
      `the judge evidence carries no finding for ${propertyId}; a calibration record cannot judge a call`,
    );
  }
  return finding;
}

// ── K1: spelled emails, including corrections ───────────────────────────────

const k1: PropertyEvaluator = {
  propertyId: "K1",
  source: "verdict/evaluators/comprehension.evaluators.ts",
  bars: [{ key: "dvSpelledEmailMismatchMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const texts = authoredText(factsOf(context), "K1");
      const expected = texts.reduce<string | null>(
        (last, text) => lastCanonicalEmail(text) ?? last,
        null,
      );
      if (expected === null) {
        throw new ComprehensionError(
          "missing-evidence",
          "the authored caller words spell no email address",
        );
      }
      const calls = readToolCalls(context.source, "the tool evidence");
      const delivered = calls
        .map((call) => ({ call, address: emailArgument(call.arguments) }))
        .filter((entry): entry is { call: (typeof calls)[number]; address: string } => entry.address !== null);
      if (delivered.length === 0) {
        throw new ComprehensionError(
          "missing-evidence",
          "no tool call carries an email argument; the tool rows record names but not arguments, " +
            "so the spelled address cannot be compared",
        );
      }
      const withoutTurn = delivered.filter((entry) => entry.call.turn === null);
      if (withoutTurn.length > 0) {
        throw new ComprehensionError(
          "missing-evidence",
          `tool call "${withoutTurn[0].call.name}" carries an address but no turn, ` +
            "so a failure could not cite one",
        );
      }
      const samples = delivered.map(({ address }) =>
        address.toLowerCase() === expected ? 0 : 1,
      );
      const wrong = delivered.filter(({ address }) => address.toLowerCase() !== expected);
      const citations = delivered.map(({ call }) => turnCitation(call.turn as string));
      return {
        kind: "measured",
        samples,
        citations,
        detail:
          wrong.length === 0
            ? `the tool received "${expected}", the address the caller spelled last`
            : wrong
                .map(
                  ({ address }) =>
                    `the caller spelled "${expected}" but the tool received "${address}"`,
                )
                .join("; "),
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── K2: numbers read back correctly ─────────────────────────────────────────

function expectedNumbers(facts: readonly TakeFact[]): string[] {
  const seen = new Set<string>();
  for (const text of authoredText(facts, "K2")) {
    for (const number of canonicalNumbers(text)) seen.add(number);
  }
  return [...seen];
}

/** The agent turn that answers a caller turn, or the first agent turn. */
function readbackTurn(turns: readonly ReadingTurn[], callerTurnId: string | null): string | null {
  const agents = turns.filter((turn) => turn.speaker === "agent");
  if (agents.length === 0) return null;
  if (callerTurnId === null) return agents[0].id;
  const index = turns.findIndex((turn) => turn.id === callerTurnId);
  if (index < 0) return agents[0].id;
  const after = turns.slice(index + 1).find((turn) => turn.speaker === "agent");
  return (after ?? agents[0]).id;
}

const k2: PropertyEvaluator = {
  propertyId: "K2",
  source: "verdict/evaluators/comprehension.evaluators.ts",
  bars: [{ key: "dvNumberReadbackMismatchMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const expected = expectedNumbers(factsOf(context));
      if (expected.length === 0) {
        throw new ComprehensionError(
          "missing-evidence",
          "the authored caller words contain no number to read back",
        );
      }
      const transcript = readTranscript(context.source, "the trace evidence");
      const agents = agentTurns(transcript);
      if (agents.length === 0) {
        throw new ComprehensionError(
          "missing-evidence",
          "the transcript carries no agent turn, so no readback can be heard",
        );
      }
      const heard = new Set(agents.flatMap((turn) => canonicalNumbers(turn.text)));
      const callerTurnFor = new Map<string, string>();
      for (const turn of callerTurns(transcript)) {
        for (const number of canonicalNumbers(turn.text)) {
          if (!callerTurnFor.has(number)) callerTurnFor.set(number, turn.id);
        }
      }
      const citations = expected.map((number) =>
        turnCitation(readbackTurn(transcript.turns, callerTurnFor.get(number) ?? null) as string),
      );
      const missing = expected.filter((number) => !heard.has(number));
      return {
        kind: "measured",
        samples: expected.map((number) => (heard.has(number) ? 0 : 1)),
        citations,
        detail:
          missing.length === 0
            ? `every caller number (${expected.join(", ")}) was read back exactly`
            : `the agent did not read back ${missing.join(", ")} exactly; the caller gave ` +
              `${expected.join(", ")} and the reply carried ${[...heard].join(", ") || "no number"}`,
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── K3: unusual names, used exactly once ────────────────────────────────────

function expectedName(facts: readonly TakeFact[]): string {
  let name: string | null = null;
  for (const text of authoredText(facts, "K3")) {
    name = spokenName(text) ?? name;
  }
  if (name === null) {
    throw new ComprehensionError(
      "missing-evidence",
      "the authored caller words introduce no name (no \"my name is ...\")",
    );
  }
  return name;
}

function nameOccurrences(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`\\b${escaped}\\b`, "gi"))].length;
}

const k3: PropertyEvaluator = {
  propertyId: "K3",
  source: "verdict/evaluators/comprehension.evaluators.ts",
  bars: [],
  evaluate(context) {
    try {
      const name = expectedName(factsOf(context));
      const transcript = readTranscript(context.source, "the trace evidence");
      const agents = agentTurns(transcript);
      if (agents.length === 0) {
        throw new ComprehensionError(
          "missing-evidence",
          "the transcript carries no agent turn, so no use of the name can be heard",
        );
      }
      const uses = agents.map((turn) => ({
        turn,
        count: nameOccurrences(turn.text, name),
      }));
      const total = uses.reduce((sum, entry) => sum + entry.count, 0);
      const naming = uses.filter((entry) => entry.count > 0).map((entry) => turnCitation(entry.turn.id));
      return {
        kind: "measured",
        passed: total === 1,
        citations: naming.length === 0 ? [turnCitation(agents[0].id)] : naming,
        detail:
          `the caller gave the name "${name}"; the agent used it ${total} time${total === 1 ? "" : "s"}` +
          (total === 1 ? "" : " — the bar is exactly once"),
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── K4: one targeted question, no guess ─────────────────────────────────────

const k4: PropertyEvaluator = {
  propertyId: "K4",
  source: "verdict/evaluators/comprehension.evaluators.ts",
  bars: [{ key: "dvAmbiguityGuessMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const finding = findingOf(readFindings(context.source, "the judge evidence"), "K4");
      if (finding.guessed === undefined || finding.clarificationCount === undefined) {
        throw new ComprehensionError(
          "missing-evidence",
          "the K4 finding carries no clarification count and no guess flag",
        );
      }
      if (!Number.isInteger(finding.clarificationCount) || finding.clarificationCount < 0) {
        throw new ComprehensionError(
          "malformed-evidence",
          `the K4 finding counts ${String(finding.clarificationCount)} clarifications`,
        );
      }
      if (finding.clarificationCount !== 1) {
        throw new ComprehensionError(
          "missing-evidence",
          `the judge counted ${finding.clarificationCount} clarifications; K4's ` +
            "\"one targeted question\" half has no frozen number, so a loop fails closed",
        );
      }
      return {
        kind: "measured",
        samples: [finding.guessed ? 1 : 0],
        citations: finding.citations,
        detail: finding.guessed
          ? "the agent guessed instead of asking one targeted question"
          : "one targeted question, no guess",
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── K5: Locale-appropriate output ───────────────────────────────────────────

/** Exported for `locale.evaluators.ts`; one implementation, one owner file. */
export const k5: PropertyEvaluator = {
  propertyId: "K5",
  source: "verdict/evaluators/comprehension.evaluators.ts",
  bars: [{ key: "dvEnglishLeakMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const locale = localeOf(context.locale);
      const transcript = readTranscript(context.source, "the trace evidence");
      const agents = agentTurns(transcript);
      if (agents.length === 0) {
        throw new ComprehensionError(
          "missing-evidence",
          "the transcript carries no agent turn, so no Locale-appropriate reply can be judged",
        );
      }
      const traceLeaks = scanLocaleLeaks(transcript, locale, "trace");
      const samples = agents.map(
        (turn) => scanLocaleLeaks({ turns: [turn] }, locale, "trace").length,
      );

      // A non-English Locale must be checked on the audio the caller actually
      // heard, not only on the trace's transcript. RR-02 never turns a missing
      // delivered-audio read into a pass.
      let deliveredTurns: number | null = null;
      let deliveredLeaks: LocaleLeakSegment[] = [];
      if (locale !== "en") {
        const delivered = context.evidence.wav;
        if (delivered === undefined || delivered === null) {
          throw new ComprehensionError(
            "missing-evidence",
            `the attempt is Locale "${locale}" but carries no delivered audio (wav) transcript; ` +
              "English-leak detection scans both the trace and the delivered audio",
          );
        }
        const audio = readTranscript(delivered, "the delivered audio");
        const deliveredAgents = agentTurns(audio);
        if (deliveredAgents.length === 0) {
          throw new ComprehensionError(
            "missing-evidence",
            "the delivered-audio transcript carries no agent turn",
          );
        }
        deliveredTurns = deliveredAgents.length;
        deliveredLeaks = scanLocaleLeaks(audio, locale, "delivered-audio");
        samples.push(
          ...deliveredAgents.map(
            (turn) => scanLocaleLeaks({ turns: [turn] }, locale, "delivered-audio").length,
          ),
        );
      }

      const leaks = [...traceLeaks, ...deliveredLeaks];
      return {
        kind: "measured",
        samples,
        citations:
          leaks.length === 0
            ? [
                ...agents.map((turn) => turnCitation(turn.id)),
                ...(deliveredTurns === null ? [] : ["wav:transcript"]),
              ]
            : leaks.map((leak) => leak.citation),
        detail:
          leaks.length === 0
            ? `0 non-${locale} markers in ${agents.length} trace agent turn${
                agents.length === 1 ? "" : "s"
              }${deliveredTurns === null ? "" : ` and ${deliveredTurns} delivered segment${
                deliveredTurns === 1 ? "" : "s"
              }`}`
            : `the ${locale} reply leaked a marker from another Locale: ` +
              leaks.map(describeLocaleLeak).join("; "),
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── K6: code-switch understood, reply stays in Locale ───────────────────────

/** Exported for `locale.evaluators.ts`; one implementation, one owner file. */
export const k6: PropertyEvaluator = {
  propertyId: "K6",
  source: "verdict/evaluators/comprehension.evaluators.ts",
  bars: [],
  evaluate(context) {
    try {
      const locale = localeOf(context.locale);
      const finding = findingOf(readFindings(context.source, "the judge evidence"), "K6");
      if (finding.codeSwitched === undefined || finding.stayedInLocale === undefined) {
        throw new ComprehensionError(
          "missing-evidence",
          "the K6 finding carries no code-switch flag and no Locale flag",
        );
      }
      if (locale !== "en") {
        if (finding.locale === undefined) {
          throw new ComprehensionError(
            "missing-evidence",
            `the K6 finding names no Locale; a "${locale}" code-switch cannot be judged by a ` +
              "finding that does not say which Locale it heard",
          );
        }
        if (finding.locale !== locale) {
          throw new ComprehensionError(
            "missing-evidence",
            `the K6 finding judged Locale "${finding.locale}", but this attempt is "${locale}"`,
          );
        }
        if (finding.citations.length === 0) {
          throw new ComprehensionError(
            "missing-evidence",
            "the K6 finding cites no transcript turn; an uncited code-switch judgement is not evidence",
          );
        }
      }
      if (!finding.codeSwitched) {
        throw new ComprehensionError(
          "missing-evidence",
          "the judge heard no code-switch, so K6 has nothing to judge",
        );
      }
      return {
        kind: "measured",
        passed: finding.stayedInLocale,
        citations: finding.citations,
        detail: finding.stayedInLocale
          ? "the caller code-switched and the reply stayed in Locale"
          : "the caller code-switched and the reply followed them out of Locale",
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── K7: no invented facts ───────────────────────────────────────────────────

const k7: PropertyEvaluator = {
  propertyId: "K7",
  source: "verdict/evaluators/comprehension.evaluators.ts",
  bars: [{ key: "dvInventedFactMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const finding = findingOf(readFindings(context.source, "the judge evidence"), "K7");
      if (finding.invented === undefined) {
        throw new ComprehensionError(
          "missing-evidence",
          "the K7 finding carries no invented-fact list; a bare pass is not evidence",
        );
      }
      const invented = finding.invented;
      const citations = invented.flatMap((entry) =>
        entry.turn === undefined ? [] : [turnCitation(entry.turn)],
      );
      return {
        kind: "measured",
        samples: [invented.length],
        citations: citations.length === 0 ? ["judge:K7"] : citations,
        detail:
          invented.length === 0
            ? "the judge found no invented fact"
            : invented.map((entry) => `invented fact: "${entry.quoted}"`).join("; "),
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

// ── K8: transcript matches the known take text; entities exact ──────────────

function entityMismatches(expected: string, heard: string): {
  missing: string[];
  extra: string[];
} {
  const expectedEmails = new Set(canonicalEmails(expected));
  const heardEmails = new Set(canonicalEmails(heard));
  const expectedNumbers = new Set(canonicalNumbers(expected));
  const heardNumbers = new Set(canonicalNumbers(heard));
  return {
    missing: [
      ...[...expectedEmails].filter((email) => !heardEmails.has(email)),
      ...[...expectedNumbers].filter((number) => !heardNumbers.has(number)),
    ],
    extra: [
      ...[...heardEmails].filter((email) => !expectedEmails.has(email)),
      ...[...heardNumbers].filter((number) => !expectedNumbers.has(number)),
    ],
  };
}

const k8: PropertyEvaluator = {
  propertyId: "K8",
  source: "verdict/evaluators/comprehension.evaluators.ts",
  bars: [{ key: "dvTranscriptEntityMismatchMaxCount", statistic: "each", comparison: "at-most" }],
  evaluate(context) {
    try {
      const facts = factsOf(context);
      const takes = authoredText(facts, "K8");
      const transcript = readTranscript(context.source, "the wav evidence");
      const caller = callerTurns(transcript);
      if (caller.length === 0) {
        throw new ComprehensionError(
          "missing-evidence",
          "the transcript carries no caller turn, so there is nothing to compare to the take text",
        );
      }
      if (caller.length !== takes.length) {
        throw new ComprehensionError(
          "missing-evidence",
          `the transcript has ${caller.length} caller turn(s) for ${takes.length} authored ` +
            "take(s); the two cannot be aligned without guessing",
        );
      }
      const expectedText = takes.join(" ");
      const heardText = caller.map((turn) => turn.text).join(" ");
      const error = wordError(expectedText, heardText);
      const mismatches = takes.map((take, index) =>
        entityMismatches(take, (caller[index] as ReadingTurn).text),
      );
      const missing = mismatches.flatMap((entry) => entry.missing);
      const extra = mismatches.flatMap((entry) => entry.extra);
      return {
        kind: "measured",
        samples: [missing.length + extra.length],
        citations: caller.map((turn) => turnCitation(turn.id)),
        detail:
          `word error ${error.rate.toFixed(3)} (${error.errors}/${error.words}) against the known ` +
          `take text; ${missing.length + extra.length} entity mismatch${missing.length + extra.length === 1 ? "" : "es"}` +
          (missing.length === 0 ? "" : ` (missing ${missing.join(", ")})`) +
          (extra.length === 0 ? "" : ` (unexpected ${extra.join(", ")})`),
      };
    } catch (error) {
      return unmeasured(error);
    }
  },
};

const comprehension: EvaluatorModule = {
  family: "comprehension",
  // K5 and K6 are the Locale properties; they live in `locale.evaluators.ts`
  // so the Locale core has one owner without a second implementation.
  evaluators: [k1, k2, k3, k4, k7, k8],
};

export default comprehension;
