import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { secret } from "@/lib/env";

/**
 * Mint a short-lived Voice Agent token so the browser never sees our API key.
 *
 * The two limits below are enforced by AssemblyAI, not by our JavaScript, which
 * is what makes them worth anything: a tampered client cannot raise them.
 *
 *   expires_in_seconds          how long the token may be redeemed (1-600)
 *   max_session_duration_seconds  how long the session may then run (60-10800)
 *
 * Tokens are also single-use — one token starts exactly one session — so a
 * leaked token is worth at most one capped call.
 *
 * Billing reality that sets these numbers: a session costs $0.075/min against
 * the $50 of credit, i.e. roughly 11 hours in total. A 3-minute cap makes one
 * demo cost $0.225 and puts a floor of ~220 demos on what the credit buys.
 *
 * ⚠️ This route is currently SIGNED-IN ONLY, and that is doing real work.
 * Sessions can be configured *inline* (system_prompt sent from the browser),
 * so an anonymous token is effectively free LLM access on our account to anyone
 * who finds the endpoint. Before this is exposed on the public landing page it
 * needs BOTH: (a) the client bound to a stored `agent_id` rather than an inline
 * prompt, so the caller cannot choose what the model does, and (b) per-IP and
 * per-day rate limiting. Do not relax the auth check without doing both.
 */

const MAX_SESSION_SECONDS = 180;
const TOKEN_TTL_SECONDS = 60;

export async function GET() {
  const ctx = await getCtx();
  if (!ctx) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const apiKey = await secret("ASSEMBLYAI_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      { error: "ASSEMBLYAI_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  const url = new URL("https://agents.assemblyai.com/v1/token");
  url.searchParams.set("expires_in_seconds", String(TOKEN_TTL_SECONDS));
  url.searchParams.set(
    "max_session_duration_seconds",
    String(MAX_SESSION_SECONDS),
  );

  // GET, not POST — confirmed in HANDOFF and the API spec. A raw key, not
  // `Bearer <key>`: the Bearer prefix is the LLM Gateway trap from (1x), and
  // while this product accepts both, the raw header is the documented form.
  const res = await fetch(url, { headers: { Authorization: apiKey } });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[voice-token] AssemblyAI ${res.status}: ${body.slice(0, 300)}`);
    return NextResponse.json(
      { error: "Could not start a call right now." },
      { status: 502 },
    );
  }

  const { token } = (await res.json()) as { token: string };
  return NextResponse.json(
    { token, maxSessionSeconds: MAX_SESSION_SECONDS },
    // Never let a CDN or the browser reuse a single-use token.
    { headers: { "Cache-Control": "no-store" } },
  );
}
