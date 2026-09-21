import { NextResponse, type NextRequest } from "next/server";
import { getCtx } from "@/lib/session";
import {
  decideVoiceJudge,
  parseVoiceJudgeRequest,
  tryJevGateway,
} from "@/lib/voice/voice-judge";

/**
 * Jev fast-judge for the browser test call (and later the PSTN path).
 *
 * The gateway key stays server-side here; the browser only sends a small
 * state blob (`kind` + partial transcript / timing / tool name) and gets back
 * one decision + probability. Any gateway failure falls back to the offline
 * heuristic with `source: "heuristic"` — the audio path never blocks on this.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "signed-in only" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseVoiceJudgeRequest(body);
  if (!parsed.ok || !parsed.kind || !parsed.state)
    return NextResponse.json({ error: "invalid judge request" }, { status: 400 });

  try {
    const result = await tryJevGateway(parsed.kind, parsed.state);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(decideVoiceJudge(parsed.kind, parsed.state));
  }
}
