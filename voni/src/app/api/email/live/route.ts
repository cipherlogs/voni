import { NextResponse, type NextRequest } from "next/server";
import { secret } from "@/lib/env";
import { readLiveSnapshot } from "@/lib/email/live";
import { PAGE_COOKIE, isPageUnlocked } from "@/lib/email/page-gate";

/**
 * The live panel's poll: one authorised GET, one snapshot, no cache.
 *
 * The gate is the page's own grant, read from the request cookie and compared
 * through `isPageUnlocked` — the same predicate that decides whether `/email`
 * renders, so a locked tab, an expired grant or a copied URL all get the same
 * 401 with no data. The cookie's path is `/email`, which is why this route
 * lives under it.
 *
 * A failed read is a fixed 502, never a partial body: the panel keeps its last
 * snapshot and marks it stale, which is only honest if a failure cannot arrive
 * looking like a snapshot with empty counts.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookie = request.cookies.get(PAGE_COOKIE)?.value;
  const unlocked = isPageUnlocked(
    cookie,
    await secret("EMAIL_PAGE_PASSWORD"),
  );

  if (!unlocked) {
    // One answer for missing, wrong and expired: nothing here tells a caller
    // which, and there is no data in it either way.
    return NextResponse.json(
      { ok: false, reason: "unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    const snapshot = await readLiveSnapshot();
    return NextResponse.json(snapshot, { headers: NO_STORE });
  } catch {
    // Fixed string, nothing from the read: a driver error can quote a row.
    console.error("email live snapshot read failed");
    return NextResponse.json(
      { ok: false, reason: "not_read" },
      { status: 502, headers: NO_STORE },
    );
  }
}
