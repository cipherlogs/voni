import { NextResponse } from "next/server";
import { getCtx } from "@/lib/session";
import { listCalls } from "@/lib/copilot/detail-data";

/**
 * Recent activity for the sidebar bell: the newest calls, display-safe
 * columns only (caller name, direction, times — the rows link to the
 * detail route for the rest). Jobs already stream client-side through the
 * jobs provider, so they are not duplicated here.
 */
export async function GET() {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { rows } = await listCalls(1, 5);
  return NextResponse.json({
    calls: rows.map((call) => ({
      id: call.id,
      name: call.name,
      direction: call.direction,
      startedAt: call.startedAt ? new Date(call.startedAt).toISOString() : null,
      endedAt: call.endedAt ? new Date(call.endedAt).toISOString() : null,
    })),
  });
}
