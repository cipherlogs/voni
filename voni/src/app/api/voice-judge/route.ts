import { NextResponse, type NextRequest } from "next/server";
import { getCtx } from "@/lib/session";
import { secret } from "@/lib/env";
import { demoCallFromRequest } from "@/lib/demo/call-token";
import { bumpRateBucket } from "@/lib/demo/rate-limit";
import {
  decideVoiceJudge,
  parseVoiceJudgeRequest,
  resolveJudgeGatewayUrl,
  resolveJudgeModel,
  tryJevGateway,
} from "@/lib/voice/voice-judge";

/**
 * Jev fast-judge for the browser test call and the PSTN bridge.
 *
 * Auth is a signed-in session (browser), the bridge bearer secret
 * (`VONI_TOOL_SECRET`, same shape as `/api/internal/bridge-config`) — the
 * bridge holds no session cookie — or, for the signed-out landing demo, its
 * call token, which may only ask the off-track question. Judging is
 * org-agnostic, so unlike the internal routes there is deliberately no
 * workspace-selection gate here.
 *
 * The gateway key stays server-side; callers only send a small state blob
 * (`kind` + partial transcript / timing / tool name) and get back one
 * decision + probability. Any gateway failure falls back to the offline
 * heuristic with `source: "heuristic"` — the audio path never blocks on this.
 *
 * A demo call token may only ask the off-track question, and its Jev spend
 * is capped per call (Postgres bucket, Worker-safe like the token limits):
 * about one judgment per visitor turn fits comfortably, while a lifted token
 * cannot burn Jev indefinitely.
 */
const JUDGE_MAX_PER_CALL = 150;
const JUDGE_WINDOW_S = 15 * 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await getCtx();
  const demoOnly = !ctx && !(await hasBridgeBearer(req));
  const demoCall = demoOnly ? await demoCallFromRequest(req) : null;
  if (demoOnly && !demoCall)
    return NextResponse.json({ error: "signed-in, bridge, or demo call only" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseVoiceJudgeRequest(body);
  if (!parsed.ok || !parsed.kind || !parsed.state)
    return NextResponse.json({ error: "invalid judge request" }, { status: 400 });
  if (demoOnly && parsed.kind !== "off-track")
    return NextResponse.json({ error: "demo calls judge off-track only" }, { status: 403 });
  if (demoOnly && demoCall) {
    const budget = await bumpRateBucket(
      `judge:call:${demoCall.callId}`,
      JUDGE_MAX_PER_CALL,
      JUDGE_WINDOW_S,
    );
    if (!budget.ok) {
      return NextResponse.json(
        { error: "demo judge budget spent" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }
  }

  // secret() reads process.env first (tests, CI, plain Node) with the
  // Cloudflare context as fallback, so this works under `next dev` (where
  // next.config mirrors .dev.vars) and on the deployed Worker.
  const apiKey =
    (await secret("AI_GATEWAY_API_KEY")) ?? (await secret("VOICE_JUDGE_API_KEY"));
  try {
    const result = await tryJevGateway(parsed.kind, parsed.state, {
      apiKey,
      gatewayUrl:
        (await secret("VOICE_JUDGE_GATEWAY_URL")) ?? resolveJudgeGatewayUrl(),
      model: (await secret("VOICE_JUDGE_MODEL")) ?? resolveJudgeModel(),
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(decideVoiceJudge(parsed.kind, parsed.state));
  }
}

/** Bridge bearer check: same secret + shape as the internal bridge routes. */
async function hasBridgeBearer(req: NextRequest): Promise<boolean> {
  const expected = await secret("VONI_TOOL_SECRET");
  if (!expected) return false;
  return req.headers.get("authorization") === `Bearer ${expected}`;
}
