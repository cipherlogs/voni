import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { demoTestTags } from "@/lib/db/schema";
import { pickTag, TAG_TTL_S } from "./test-tag";

/**
 * The server registry of live Test tags (test-tag.ts): issue one unique
 * among live tags, load it back from the browser's token, and record the
 * email that carried it.
 */

export type TestTagRow = typeof demoTestTags.$inferSelect;

/** A tag is never reissued until its last holder's day plus another day has passed. */
export const TAG_REUSE_AFTER_S = 2 * TAG_TTL_S;

/**
 * ponytail: unique by read-then-insert, not a constraint. Two issues racing
 * in the same millisecond could draw the same tag (odds ~1 in 3,600 per pair);
 * add a partial unique index on live tags if call volume grows.
 */
export async function issueTestTag(language: string, now = new Date()): Promise<TestTagRow> {
  // Not only live tags: one freed in the last day may still get its holder's
  // late email, which must never reach a new holder (their name and address).
  const recent = await db
    .select({ tag: demoTestTags.tag })
    .from(demoTestTags)
    .where(gt(demoTestTags.issuedAt, new Date(now.getTime() - TAG_REUSE_AFTER_S * 1000)));
  const tag = pickTag(language, new Set(recent.map((r) => r.tag.toLowerCase())));
  const [row] = await db
    .insert(demoTestTags)
    .values({ tag, language, issuedAt: now, expiresAt: new Date(now.getTime() + TAG_TTL_S * 1000) })
    .returning();
  return row;
}

export async function loadLiveTestTag(id: string, now = new Date()): Promise<TestTagRow | null> {
  const [row] = await db
    .select()
    .from(demoTestTags)
    .where(and(eq(demoTestTags.id, id), gt(demoTestTags.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/**
 * Record the email that carried the tag (once), linking it to an earlier tag
 * the same sender matched: that visitor is returning (on another device).
 */
export async function recordTagMatch(
  row: TestTagRow,
  match: { from: string; messageId: string; threadId: string },
  now = new Date(),
): Promise<{ returning: boolean }> {
  if (row.matchedMessageId) return { returning: row.linkedTagId !== null };
  const [earlier] = await db
    .select({ id: demoTestTags.id })
    .from(demoTestTags)
    .where(and(eq(demoTestTags.matchedFrom, match.from), ne(demoTestTags.id, row.id)))
    .orderBy(asc(demoTestTags.matchedAt))
    .limit(1);
  await db
    .update(demoTestTags)
    .set({
      matchedFrom: match.from,
      matchedMessageId: match.messageId,
      matchedThreadId: match.threadId,
      matchedAt: now,
      linkedTagId: earlier?.id ?? null,
    })
    .where(and(eq(demoTestTags.id, row.id), isNull(demoTestTags.matchedMessageId)));
  return { returning: Boolean(earlier) };
}

/**
 * The token route's tag: the browser's own tag while it lives (a callback
 * finds the email sent after a late call), else a fresh one. A tag whose
 * email was already matched belongs to its call: only a rejoin of that call
 * (`continuing`) keeps it, or the next call would reply at the greeting.
 */
export async function tagForMint(
  held: { id: string; continuing?: boolean } | null,
  language: string,
  deps: { load: typeof loadLiveTestTag; issue: typeof issueTestTag } = { load: loadLiveTestTag, issue: issueTestTag },
): Promise<{ tag: TestTagRow; carried: boolean }> {
  const carried = held ? await deps.load(held.id) : null;
  if (carried && (!carried.matchedMessageId || held?.continuing)) return { tag: carried, carried: true };
  return { tag: await deps.issue(language), carried: false };
}
