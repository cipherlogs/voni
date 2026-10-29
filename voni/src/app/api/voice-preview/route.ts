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
 * WHY A GRANT, NOT AUDIO BYTES HERE: AssemblyAI does offer standalone streaming
 * TTS (`wss://tts.us.assemblyai.com/v1/ws`), and Voni renders its cascade
 * previews from that endpoint at native level — the committed, hash-pinned
 * clips in `voni/evidence/cascade-clips` (`voice-pipeline/cascade/clips.py`),
 * checked by the clip test. This route is deliberately not a second renderer:
 * synthesizing per tap would open a vendor socket inside a request, produce
 * audio no committed gate has checked, and bypass the native-level promise
 * (the cascade carries no gain stage). So the route validates, rate-limits and
 * returns the sample text and the voice's Locale; the client speaks it with the
 * browser's speech synthesis as an explicitly-labelled approximation until the
 * picker plays the committed native clip from `CASCADE_PREVIEW_PREFIX`. If the
 * preview path is wired to those clips, only this route's success branch needs
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
