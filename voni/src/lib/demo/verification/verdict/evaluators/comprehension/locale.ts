/**
 * Locale leak scanning: the same reply is checked in the trace and in the
 * delivered-audio transcript, and a leak names the segment it was heard in.
 *
 * The lexicon is the comprehension text layer's, not a language detector: a
 * paraphrase outside it yields no leak, which is a recorded limitation rather
 * than a claim that the reply is clean (K5's evidence is the transcript and the
 * delivered WAV; RR-02 covers understanding, not vocabulary coverage).
 *
 * A delivered-audio turn may carry `startMs`/`endMs`; when it does, the citation
 * is the segment, so a defect card can point at the audible line rather than
 * the whole call. A turn without offsets is still cited by its id, never
 * silently dropped.
 */

import type { Locale } from "../../../scenarios";
import { languageLeaks } from "./text";
import type { ReadingTranscript } from "./reading";

export const LOCALE_LEAK_SOURCES = ["trace", "delivered-audio"] as const;

export type LocaleLeakSource = (typeof LOCALE_LEAK_SOURCES)[number];

export type LocaleLeakSegment = {
  /** Where the words were observed. */
  readonly source: LocaleLeakSource;
  readonly turn: string;
  readonly tokens: readonly string[];
  /** `turn:<id>` for the trace, `wav:<id>@<start>-<end>ms` for the delivered audio. */
  readonly citation: string;
  readonly startMs?: number;
  readonly endMs?: number;
};

/** Every agent turn that carries a marker from the wrong Locale. */
export function scanLocaleLeaks(
  transcript: ReadingTranscript,
  locale: Locale,
  source: LocaleLeakSource,
): LocaleLeakSegment[] {
  const leaks: LocaleLeakSegment[] = [];
  for (const turn of transcript.turns) {
    if (turn.speaker !== "agent") continue;
    const tokens = languageLeaks(turn.text, locale);
    if (tokens.length === 0) continue;
    const hasWindow = turn.startMs !== undefined && turn.endMs !== undefined;
    leaks.push({
      source,
      turn: turn.id,
      tokens,
      citation:
        source === "delivered-audio"
          ? hasWindow
            ? `wav:${turn.id}@${turn.startMs}-${turn.endMs}ms`
            : `wav:${turn.id}`
          : `turn:${turn.id}`,
      ...(turn.startMs === undefined ? {} : { startMs: turn.startMs }),
      ...(turn.endMs === undefined ? {} : { endMs: turn.endMs }),
    });
  }
  return leaks;
}

/** One human-readable line per leak, for the property's detail. */
export function describeLocaleLeak(leak: LocaleLeakSegment): string {
  const where =
    leak.source === "delivered-audio"
      ? `delivered audio ${leak.citation}`
      : `trace turn ${leak.citation}`;
  return `${where} leaked ${leak.tokens.join(", ")}`;
}
