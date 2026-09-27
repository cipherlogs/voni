import { NextResponse, type NextRequest } from "next/server";
import { checkDemoLimits } from "@/lib/demo/rate-limit";
import { getOrCreateDemoAgent } from "@/lib/demo/stored-agents";
import { carryDemoCall, demoCallKey, signTagToken, verifyTagToken } from "@/lib/demo/call-token";
import { tagForMint } from "@/lib/demo/test-tag-registry";
import { getVoice } from "@/lib/agents/voices";
import { WALL_CAP_S } from "@/lib/demo/talk-clock";
import { secret } from "@/lib/env";

/**
 * Public demo token — no sign-in required, so every control here is load-bearing.
 *
 * Four layers, and each stops something the others don't:
 *
 * 1. **Stored agent, never an inline prompt.** The response carries an
 *    `agent_id`, and the browser can send nothing but that binding. Without
 *    this, an anonymous token is free LLM access on our account to anyone who
 *    opens the network tab — the whole reason this route did not exist before.
 * 2. **Rate limits, per-IP and global.** Per-IP stops one person hammering it;
 *    the global daily cap is what actually bounds the bill against a crowd or
 *    a botnet, which per-IP alone cannot.
 * 3. **Server-enforced session caps.** `max_session_duration_seconds` and
 *    `expires_in_seconds` are enforced by AssemblyAI, not by our JavaScript,
 *    so a tampered client cannot raise them. Tokens are single-use.
 * 4. **Validated inputs.** the voice is checked against the demo picker
 *    before anything is created (see stored-agents.ts).
 *
 * The session cap is the talk clock's wall-clock cap: the talk clock itself
 * (2 min of unmuted talk) runs client-side and pauses on mute, so the server
 * bounds the worst case instead. Worst case per token: one 12-minute call,
 * about $0.90. The talk clock cannot move server-side: only the browser
 * knows about mute, and AssemblyAI has no call to end a live session
 * (`DELETE /v1/sessions/{id}` only soft-deletes a finished one). The one
 * server lever is this cap; lowering WALL_CAP_S trades away mute allowance.
 *
 * Each response also carries a `callToken` (call-token.ts): the bearer that
 * scopes the demo's tool and judge routes to this one call, and names the
 * visitor's Test tag (`testTag` + the browser's `tagToken`, test-tag.ts).
 */

const MAX_SESSION_SECONDS = WALL_CAP_S;
const TOKEN_TTL_SECONDS = 60;

export async function POST(request: NextRequest) {
  const limit = await checkDemoLimits(request.headers);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: limit.reason },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  let body: { voiceId?: unknown; resume?: unknown; callToken?: unknown; tagToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const voiceId = typeof body.voiceId === "string" ? body.voiceId : "";
  // Hold rejoin only: bind the fresh transport to the greeting-less resume
  // variant so the welcome-back is the single first utterance. Strict
  // `=== true` — anything else mints the regular intro agent.
  const resume = body.resume === true;

  const agent = await getOrCreateDemoAgent(voiceId, { resume });
  if (!agent.ok) {
    return NextResponse.json({ error: agent.error }, { status: 400 });
  }

  const apiKey = await secret("ASSEMBLYAI_API_KEY");
  const callKey = await demoCallKey();
  if (!apiKey || !callKey) {
    return NextResponse.json(
      { error: "The live demo is not available right now." },
      { status: 503 },
    );
  }

  const url = new URL("https://agents.assemblyai.com/v1/token");
  url.searchParams.set("expires_in_seconds", String(TOKEN_TTL_SECONDS));
  url.searchParams.set(
    "max_session_duration_seconds",
    String(MAX_SESSION_SECONDS),
  );

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[demo-token] AssemblyAI ${res.status}: ${text.slice(0, 300)}`);
    return NextResponse.json(
      { error: "Could not start a call right now." },
      { status: 502 },
    );
  }

  const { token } = (await res.json()) as { token: string };

  // The visitor's Test tag (docs/adr/0004): the browser's token re-issues the
  // same tag for a day (a callback finds the email sent after a late call);
  // otherwise a fresh one in the call's language.
  const held = typeof body.tagToken === "string" ? verifyTagToken(callKey, body.tagToken) : null;
  const { tag, carried } = await tagForMint(held, getVoice(voiceId)?.languageCode ?? "en");
  return NextResponse.json(
    {
      token,
      agentId: agent.agentId,
      callToken: carryDemoCall(callKey, body.callToken, Date.now(), tag.id),
      testTag: tag.tag,
      // A carried tag keeps its token (same id and issue time).
      tagToken: signTagToken(callKey, tag.id, tag.issuedAt.getTime()),
      /** Carried from an earlier call: its email may already be in (Q15). */
      tagCarried: carried,
      maxSessionSeconds: MAX_SESSION_SECONDS,
    },
    // A single-use token must never be cached by a CDN or the browser.
    { headers: { "Cache-Control": "no-store" } },
  );
}
