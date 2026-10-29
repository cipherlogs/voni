import { NextResponse } from "next/server";

import { writeDeliveredCapture } from "@/lib/voice/delivered-capture-store";

/**
 * Dev-only sink for the delivered capture (`?delivercapture=1`).
 *
 * The browser posts the WAV the playout worklet rendered; this writes it to
 * the gitignored `voni/.captures/` working directory and returns the path so
 * a human can pair it with the platform and reference captures. A production
 * build has no business writing audio to disk: the route does not exist there.
 *
 * No `runtime` segment config: `cacheComponents` requires the Node.js runtime,
 * and Next 16 rejects an explicit `runtime` export on a route.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }
  const name = new URL(req.url).searchParams.get("name") ?? "";
  const bytes = new Uint8Array(await req.arrayBuffer());
  try {
    const path = await writeDeliveredCapture(name, bytes);
    return NextResponse.json({ path });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "capture failed" },
      { status: 400 },
    );
  }
}
