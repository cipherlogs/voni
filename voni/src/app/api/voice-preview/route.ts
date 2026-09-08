import { NextResponse, type NextRequest } from "next/server";
import { getCtx } from "@/lib/session";
import { secret } from "@/lib/env";
import {
  PREVIEW_CACHE_SECONDS,
  PREVIEW_RATE_WINDOW_SECONDS,
  previewLocale,
  previewRateLimitExceeded,
  voicePreviewSchema,
} from "@/lib/voice/preview";

/**
 * Voice preview grant for the agent-wizard Personality step.
 *
 * WHY A GRANT, NOT AUDIO BYTES: AssemblyAI offers no standalone text-to-speech
 * endpoint — TTS exists only inside the live Voice Agent pipeline (see
 * `/faq/do-you-offer-voice-to-voice-or-text-to-speech-tts`: "AssemblyAI does
 * not offer standalone text-to-speech as a separate service"). Hallucinating a
 * `POST /v1/tts` call would 404 at runtime, so this route validates + gates
 * and returns the sanitized sample text, and the client speaks it with the
 * browser's speech synthesis as an explicitly-labelled approximation. If a
 * real TTS provider is ever wired up, only this route's success branch needs
 * to change — the client contract (`voiceId`, `text`, `locale`) stays.
 *
 * What this route still enforces server-side:
 * - Zod shape (`voiceId` in our catalog, `text` ≤ 280 chars).
 * - Signed-in creator only (same gate as `/api/voice-token`).
 * - AssemblyAI key present — a missing key is a distinct 503, not a 500.
 * - Trivial creator-scoped rate limit → 429 + `Retry-After`, matching the
 *   `voice-call.tsx` countdown copy. Process-local on purpose: previews are
 *   cheap and non-billable, so cross-isolate precision (à la the demo
 *   token's Postgres counters) is not worth a query per tap.
 */

const hitsByUser = new Map<string, number[]>();

export async function POST(request: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const parsed = voicePreviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Say which voice to preview." }, { status: 400 });
  }

  const apiKey = await secret("ASSEMBLYAI_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      { error: "Voice preview needs an AssemblyAI key first." },
      { status: 503 },
    );
  }

  const now = Date.now();
  const hits = hitsByUser.get(ctx.userId) ?? [];
  const limit = previewRateLimitExceeded(hits, now);
  if (limit.exceeded) {
    return NextResponse.json(
      { error: "Too many previews right now." },
      { headers: { "Retry-After": String(limit.retryAfterSeconds) }, status: 429 },
    );
  }
  hitsByUser.set(ctx.userId, [...hits.filter((t) => t > now - PREVIEW_RATE_WINDOW_SECONDS * 1000), now]);
  // Process-local map only: prune the user list itself so abandoned ids do
  // not accumulate across the isolate's lifetime.
  if (hitsByUser.size > 5000) {
    for (const [id, times] of hitsByUser) {
      if (times.every((t) => t <= now - PREVIEW_RATE_WINDOW_SECONDS * 1000)) hitsByUser.delete(id);
      if (hitsByUser.size <= 5000) break;
    }
  }

  const { voiceId, text } = parsed.data;
  return NextResponse.json(
    { voiceId, text, locale: previewLocale(voiceId) },
    { headers: { "Cache-Control": `private, max-age=${PREVIEW_CACHE_SECONDS}` } },
  );
}
