import { NextResponse } from "next/server";

import {
  CALL_MARKS_PRODUCTION_REFUSAL,
  isCallMarksArtifact,
} from "@/lib/voice/call-marks";
import { writeCallMarks } from "@/lib/voice/call-marks-store";

/**
 * Dev-only sink for the browser call marks (`?delivercapture=1`).
 *
 * The landing page posts one artifact per call; this writes it beside the
 * delivered WAV in the gitignored `voni/.captures/` working directory and
 * returns the path. A production build has no business writing a visitor's
 * call evidence to disk: the route refuses it by name.
 *
 * No `runtime` segment config: `cacheComponents` requires the Node.js runtime,
 * and Next 16 rejects an explicit `runtime` export on a route.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(CALL_MARKS_PRODUCTION_REFUSAL, { status: 404 });
  }
  const callId = new URL(req.url).searchParams.get("callId") ?? "";
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid call marks JSON" }, { status: 400 });
  }
  if (!isCallMarksArtifact(body)) {
    return NextResponse.json({ error: "invalid call marks artifact" }, { status: 400 });
  }
  try {
    const path = await writeCallMarks(callId, body);
    return NextResponse.json({ path });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "call marks write failed" },
      { status: 400 },
    );
  }
}
