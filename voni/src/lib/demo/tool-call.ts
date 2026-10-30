import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { demoCalls } from "@/lib/db/schema";
import type { DemoCall } from "./call-token";

/**
 * The demo call a service tool request names, read from `demo_calls` only.
 *
 * The pipeline sends the demo call id in its tool context, so this is the one
 * lookup the shared-secret path may use. Tenant call ids live in `calls` and
 * have no row here, which is why a tenant id cannot resolve to a demo call.
 */
export async function demoCallById(callId: string): Promise<DemoCall | null> {
  const [row] = await db
    .select({
      callId: demoCalls.callId,
      tagId: demoCalls.tagId,
      createdAt: demoCalls.createdAt,
    })
    .from(demoCalls)
    .where(eq(demoCalls.callId, callId))
    .limit(1);
  if (!row) return null;
  return { callId: row.callId, startedAt: row.createdAt.getTime(), tagId: row.tagId ?? null };
}
