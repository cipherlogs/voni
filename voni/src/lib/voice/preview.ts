import { z } from "zod";
import { VOICE_IDS, getVoice } from "@/lib/agents/voices";
import { isCascadeSubjectVoice } from "@/lib/demo/subject";
import { DEMO_VOICE_IDS } from "@/lib/demo/voni-agent";

/**
 * Committed native previews, one per demo cascade voice (ticket 132).
 *
 * The preview *is* the clip: the same asset the synthesis endpoint rendered at
 * native level, recorded in `voni/evidence/cascade-clips/clips.json` and checked
 * by the clip test. Only the demo roster has a cascade plan (`clip_plan` in
 * `voice-pipeline/cascade/clips.py`); a catalog voice outside it has the managed
 * `/voices/<id>.mp3` only. A cascade preview is a new native render, never a
 * silent swap.
 */
export const CASCADE_PREVIEW_PREFIX = "/voices/cascade";

/**
 * The URL the picker plays a demo cascade voice's native preview from, or
 * `null` when the voice has no binding, is not on the demo roster, or is a
 * historical unbound row. A voice with no committed preview is a named
 * clip-test blocker, not a URL that falls back to another voice.
 */
export function cascadePreviewUrl(voiceId: string): string | null {
  if (!(DEMO_VOICE_IDS as readonly string[]).includes(voiceId)) return null;
  if (!isCascadeSubjectVoice(voiceId)) return null;
  return `${CASCADE_PREVIEW_PREFIX}/${voiceId}.wav`;
}

/** The repo-relative file a cascade preview URL serves from, or null for no URL. */
export function cascadePreviewAsset(voiceId: string): string | null {
  const url = cascadePreviewUrl(voiceId);
  return url === null ? null : `public${url}`;
}

/** A preview URL whose asset is not committed: a named gap, not a playable URL. */
export type CascadePreviewGap = {
  voiceId: string;
  url: string;
  asset: string;
  message: string;
};

/**
 * Why a bound cascade voice's preview cannot be served yet, or null when its
 * committed asset exists. Five cascade clips are still named blockers in
 * `evidence/cascade-clips/clips.json` (the full render was not run); a caller
 * that plays a preview should report this gap instead of emitting a URL that
 * 404s. The caller supplies the committed assets so this module stays pure.
 */
export function cascadePreviewGap(
  voiceId: string,
  committedAssets: readonly string[],
): CascadePreviewGap | null {
  const url = cascadePreviewUrl(voiceId);
  const asset = cascadePreviewAsset(voiceId);
  if (url === null || asset === null) return null;
  if (committedAssets.includes(asset)) return null;
  return {
    voiceId,
    url,
    asset,
    message: `${voiceId}: ${url} is not a playable preview: ${asset} is not committed`,
  };
}

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
