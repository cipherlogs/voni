/**
 * Reading the comprehension evidence shapes without trusting them.
 *
 * A run's evidence is assembled by an adapter, so every field is `unknown`
 * here. The shapes are deliberately narrow: a transcript of call turns, the
 * tool calls with their arguments, and a judge's property findings. Missing or
 * malformed evidence is a named `ComprehensionError`, which the evaluator turns
 * into `unmeasured` — fail closed, never a skip.
 *
 * The protocol adapter does not yet capture a transcript or tool arguments, so
 * these readers refuse its bundles by name. That is the recorded gap this
 * ticket leaves open rather than stubbing: a real comprehension property is
 * unmeasured until an adapter supplies the text it must compare.
 */

import type { Locale } from "../../../scenarios";

export type ReadingTurn = {
  readonly id: string;
  readonly speaker: "caller" | "agent";
  readonly text: string;
};

export type ReadingTranscript = {
  readonly turns: readonly ReadingTurn[];
};

export type ToolCall = {
  readonly name: string;
  readonly toolCallId: string | null;
  readonly turn: string | null;
  readonly arguments: Readonly<Record<string, unknown>> | null;
};

export type JudgeFinding = {
  readonly propertyId: string;
  readonly passed: boolean;
  readonly citations: readonly string[];
  readonly clarificationCount?: number;
  readonly guessed?: boolean;
  readonly codeSwitched?: boolean;
  readonly stayedInLocale?: boolean;
  readonly invented?: readonly { readonly quoted: string; readonly turn?: string }[];
};

export type TakeFact = {
  readonly id: string;
  readonly text: string | null;
};

export const COMPREHENSION_ERROR_CODES = [
  "missing-evidence",
  "malformed-evidence",
] as const;

export type ComprehensionErrorCode = (typeof COMPREHENSION_ERROR_CODES)[number];

export class ComprehensionError extends Error {
  readonly code: ComprehensionErrorCode;

  constructor(code: ComprehensionErrorCode, message: string) {
    super(message);
    this.name = "ComprehensionError";
    this.code = code;
  }
}

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ComprehensionError(
      "malformed-evidence",
      `${what} must be an object, got ${Array.isArray(value) ? "array" : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function textOf(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ComprehensionError("malformed-evidence", `${what} must be a non-empty string`);
  }
  return value;
}

/**
 * A transcript is either the evidence's own `turns` or a `transcript` object
 * beside it. The trace, wav and judge sources all use the same shape so one
 * reader serves every property.
 */
export function readTranscript(source: unknown, what: string): ReadingTranscript {
  const outer = recordOf(source, what);
  const candidate =
    typeof outer.transcript === "object" && outer.transcript !== null
      ? recordOf(outer.transcript, `${what}.transcript`)
      : outer;
  if (!Array.isArray(candidate.turns) || candidate.turns.length === 0) {
    throw new ComprehensionError(
      "missing-evidence",
      `${what} carries no transcript turns; the call's words are not in the evidence, ` +
        "so no text property can be judged from them",
    );
  }
  const turns = candidate.turns.map((raw, index) => {
    const turn = recordOf(raw, `${what}.turns[${index}]`);
    const speaker = turn.speaker;
    if (speaker !== "caller" && speaker !== "agent") {
      throw new ComprehensionError(
        "malformed-evidence",
        `${what}.turns[${index}] names speaker ${JSON.stringify(speaker)}, not "caller" or "agent"`,
      );
    }
    return {
      id: textOf(turn.id, `${what}.turns[${index}].id`),
      speaker: speaker as "caller" | "agent",
      text: textOf(turn.text, `${what}.turns[${index}].text`),
    };
  });
  return { turns };
}

/** The tool calls the run observed, including arguments when they were logged. */
export function readToolCalls(source: unknown, what: string): ToolCall[] {
  const outer = recordOf(source, what);
  if (!Array.isArray(outer.calls)) {
    throw new ComprehensionError(
      "missing-evidence",
      `${what} carries no tool calls; there is no delivered argument to compare`,
    );
  }
  return outer.calls.map((raw, index) => {
    const call = recordOf(raw, `${what}.calls[${index}]`);
    const name = textOf(call.name, `${what}.calls[${index}].name`);
    const args = call.arguments;
    return {
      name,
      toolCallId: typeof call.toolCallId === "string" ? call.toolCallId : null,
      turn: typeof call.turn === "string" && call.turn.trim() !== "" ? call.turn : null,
      arguments:
        typeof args === "object" && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : null,
    };
  });
}

/** The judge's property findings, never its calibration record. */
export function readFindings(source: unknown, what: string): JudgeFinding[] {
  const outer = recordOf(source, what);
  if (!Array.isArray(outer.findings)) {
    throw new ComprehensionError(
      "missing-evidence",
      `${what} carries no property findings; a judge calibration record cannot judge a call`,
    );
  }
  return outer.findings.map((raw, index) => {
    const finding = recordOf(raw, `${what}.findings[${index}]`);
    const propertyId = textOf(finding.propertyId, `${what}.findings[${index}].propertyId`);
    if (typeof finding.passed !== "boolean") {
      throw new ComprehensionError(
        "malformed-evidence",
        `${what}.findings[${index}] carries no boolean passed`,
      );
    }
    const citations = Array.isArray(finding.citations)
      ? finding.citations.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      propertyId,
      passed: finding.passed,
      citations,
      ...(typeof finding.clarificationCount === "number"
        ? { clarificationCount: finding.clarificationCount }
        : {}),
      ...(typeof finding.guessed === "boolean" ? { guessed: finding.guessed } : {}),
      ...(typeof finding.codeSwitched === "boolean" ? { codeSwitched: finding.codeSwitched } : {}),
      ...(typeof finding.stayedInLocale === "boolean"
        ? { stayedInLocale: finding.stayedInLocale }
        : {}),
      ...(Array.isArray(finding.invented)
        ? {
            invented: finding.invented.flatMap((entry) => {
              if (typeof entry !== "object" || entry === null) return [];
              const invented = entry as Record<string, unknown>;
              if (typeof invented.quoted !== "string" || invented.quoted.trim() === "") return [];
              return [
                {
                  quoted: invented.quoted,
                  ...(typeof invented.turn === "string" ? { turn: invented.turn } : {}),
                },
              ];
            }),
          }
        : {}),
    };
  });
}

/** The scenario's authored caller words; absent facts are never inferred from audio. */
export function readFacts(facts: unknown, what: string): TakeFact[] {
  const outer = recordOf(facts, what);
  if (!Array.isArray(outer.takes) || outer.takes.length === 0) {
    throw new ComprehensionError(
      "missing-evidence",
      `${what} carries no authored caller words; the adapter supplied no scenario facts, ` +
        "so an exactness bar has nothing to compare against",
    );
  }
  return outer.takes.map((raw, index) => {
    const take = recordOf(raw, `${what}.takes[${index}]`);
    return {
      id: textOf(take.id, `${what}.takes[${index}].id`),
      text: typeof take.text === "string" ? take.text : null,
    };
  });
}

/** The caller's words in order, refusing to treat an unwritten take as empty. */
export function authoredText(facts: readonly TakeFact[], what: string): string[] {
  const missing = facts.filter((take) => take.text === null).map((take) => take.id);
  if (missing.length > 0) {
    throw new ComprehensionError(
      "missing-evidence",
      `${what} has no authored text for take(s): ${missing.join(", ")}`,
    );
  }
  return facts.map((take) => take.text as string);
}

/** The first address-ish argument a tool received, in the call's own spelling. */
export function emailArgument(argumentsOf: Readonly<Record<string, unknown>> | null): string | null {
  if (argumentsOf === null) return null;
  for (const key of ["address", "email", "to", "recipient"]) {
    const value = argumentsOf[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

export function agentTurns(transcript: ReadingTranscript): ReadingTurn[] {
  return transcript.turns.filter((turn) => turn.speaker === "agent");
}

export function callerTurns(transcript: ReadingTranscript): ReadingTurn[] {
  return transcript.turns.filter((turn) => turn.speaker === "caller");
}

/** The Locale a transcript-level property judges; an absent Locale is a refusal. */
export function localeOf(locale: string | undefined): Locale {
  if (locale === "en" || locale === "es" || locale === "fr" || locale === "de" || locale === "pt") {
    return locale;
  }
  throw new ComprehensionError(
    "missing-evidence",
    `the attempt names Locale ${JSON.stringify(locale)}; a Locale-appropriate reply needs one of en, es, fr, de, pt`,
  );
}
