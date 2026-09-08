import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { resolveCredential } from "@/lib/platform/credentials";
import { bumpRateBucket } from "@/lib/demo/rate-limit";

/**
 * Mint a short-lived Voice Agent token for the global copilot.
 *
 * Same shape as /api/voice-token with a longer session cap: the copilot
 * holds natural multi-turn conversations, and the 60s idle rule plus
 * explicit Stop end sessions long before 15 minutes. Limits are enforced by
 * AssemblyAI (single-use token, server-side duration cap), so a tampered
 * client cannot raise them.
 *
 * Creator-scoped mint limit (6/min, DB-backed like the demo limiter because
 * Cloudflare isolates share no memory) covers reconnects too: every resume
 * needs a fresh token, and a reconnect storm must not become a spend storm.
 */

const TOKEN_TTL_SECONDS = 120;
const MAX_SESSION_SECONDS = 900;
const MAX_MINTS_PER_MINUTE = 6;

export async function GET() {
  const ctx = await getCtx();
  if (!ctx) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const minute = new Date().toISOString().slice(0, 16);
  const gate = await bumpRateBucket(
    `copilot:user:${ctx.userId}:${minute}`,
    MAX_MINTS_PER_MINUTE,
    60,
  );
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Voice copilot is starting too often. Wait a moment and try again." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const { value: apiKey } = await resolveCredential("assemblyai_api_key");
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Voice copilot isn't configured. Add an AssemblyAI key in Settings, or keep using mouse and keyboard.",
      },
      { status: 503 },
    );
  }

  const url = new URL("https://agents.assemblyai.com/v1/token");
  url.searchParams.set("expires_in_seconds", String(TOKEN_TTL_SECONDS));
  url.searchParams.set("max_session_duration_seconds", String(MAX_SESSION_SECONDS));

  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[copilot-token] AssemblyAI ${res.status}: ${body.slice(0, 300)}`);
    return NextResponse.json(
      {
        error:
          res.status === 401
            ? "Voice copilot failed. The saved AssemblyAI key looks invalid — check Settings."
            : "Could not start the voice copilot right now.",
      },
      { status: 502 },
    );
  }

  const { token } = (await res.json()) as { token: string };
  return NextResponse.json(
    { token, maxSessionSeconds: MAX_SESSION_SECONDS },
    { headers: { "Cache-Control": "no-store" } },
  );
}
