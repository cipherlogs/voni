import { z } from "zod";
import { VOICE_IDS, getVoice } from "@/lib/agents/voices";

/** Sample text cap: a greeting-length utterance, never a paragraph. */
export const MAX_PREVIEW_CHARS = 280;

/** Shipped to the client as `Cache-Control: private, max-age=…`. */
export const PREVIEW_CACHE_SECONDS = 15;

/** Trivial creator-scoped ceiling: 10 previews per minute per user. */
export const PREVIEW_RATE_LIMIT = 10;
export const PREVIEW_RATE_WINDOW_SECONDS = 60;

export const voicePreviewSchema = z.object({
  voiceId: z
    .string()
    .trim()
    .min(1)
    .refine((id) => VOICE_IDS.includes(id), { message: "Unknown voice." }),
  text: z.string().trim().min(1).max(MAX_PREVIEW_CHARS),
});

export type VoicePreviewInput = z.infer<typeof voicePreviewSchema>;

/**
 * The greeting-length sample the Play button reads. Same line as the shipped
 * real-estate template greeting so the preview matches the first thing a
 * caller hears; truncated to the route cap, never thrown over it.
 */
export function buildPreviewText(agentName: string): string {
  const name = agentName.trim() || "Voni";
  return `Hi, this is ${name}. Can you hear me okay?`.slice(0, MAX_PREVIEW_CHARS);
}

/**
 * Preferred browser-speech locale for a catalog voice, so the client-side
 * approximation at least speaks the right language/accent family. The browser
 * can only approximate — the final voice renders server-side on the call.
 */
export function previewLocale(voiceId: string): string {
  const accent = getVoice(voiceId)?.accent;
  switch (accent) {
    case "UK":
      return "en-GB";
    case "IT":
      return "it-IT";
    case "ES":
      return "es-ES";
    case "DE":
      return "de-DE";
    case "PT":
      return "pt-PT";
    case "FR":
      return "fr-FR";
    default:
      return "en-US";
  }
}

/**
 * Sliding-window check over an array of epoch-ms hits. Pure over the
 * caller-owned array (the route keeps one per user) so tests can drive time.
 */
export function previewRateLimitExceeded(
  hits: number[],
  now: number,
  max = PREVIEW_RATE_LIMIT,
  windowSeconds = PREVIEW_RATE_WINDOW_SECONDS,
): { exceeded: boolean; retryAfterSeconds: number } {
  const cutoff = now - windowSeconds * 1000;
  const recent = hits.filter((t) => t > cutoff);
  if (recent.length < max) {
    return { exceeded: false, retryAfterSeconds: 0 };
  }
  const oldest = Math.min(...recent);
  return {
    exceeded: true,
    retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - now) / 1000)),
  };
}
