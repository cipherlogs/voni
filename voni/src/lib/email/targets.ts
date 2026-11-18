/**
 * The live target list: what the check, the one-off click and the next burst
 * may visit.
 *
 * `src/lib/email/targets.json` is the seed, not the list. The first read of an
 * empty table writes the seed once; from then on `/email` owns the list, and a
 * deploy does not overwrite an operator's pause or removal. The file stays
 * because it is the only list a generator run without a database has, and
 * because a seed that is reviewable in git is what makes the first page load
 * predictable.
 *
 * Two reads exist on purpose:
 *   - `activeTargetUrls` — enabled rows, what a producer draws from.
 *   - `allTargetUrls` — every row, paused included. This is the *host* allow
 *     list for a redirect chain: pausing the tracker would otherwise stop every
 *     sibling target's chain at its first hop.
 *
 * Nothing here authorises. The panel's actions gate with the control cookie
 * before calling in, because every exported action is a public endpoint.
 */

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { affiliateTargets } from "@/lib/db/schema";
import TARGETS_JSON from "./targets.json";
import { assertEmailTargets } from "./pool";
import type { TargetView } from "./target-state";
import { targetUrlProblem } from "./target-url";

/** The list a database-less process (CI, tests) falls back to. */
export const SEED_TARGETS: readonly string[] = assertEmailTargets(TARGETS_JSON);

/**
 * Write the seed once, into an empty table.
 *
 * `onConflictDoNothing` makes two concurrent first renders converge instead of
 * one failing on the unique index: whichever insert wins, the other is a no-op
 * and the re-read below sees one list.
 */
async function seedIfEmpty(): Promise<void> {
  const existing = await db
    .select({ id: affiliateTargets.id })
    .from(affiliateTargets)
    .limit(1);
  if (existing.length > 0) return;

  await db
    .insert(affiliateTargets)
    .values(SEED_TARGETS.map((url) => ({ url })))
    .onConflictDoNothing();
}

export async function listAffiliateTargets(): Promise<TargetView[]> {
  await seedIfEmpty();
  const rows = await db
    .select({
      id: affiliateTargets.id,
      url: affiliateTargets.url,
      enabled: affiliateTargets.enabled,
    })
    .from(affiliateTargets)
    .orderBy(asc(affiliateTargets.createdAt), asc(affiliateTargets.url));
  return rows;
}

/** What a click producer may draw from: enabled targets only. */
export async function activeTargetUrls(): Promise<string[]> {
  const targets = await listAffiliateTargets();
  return targets.filter((target) => target.enabled).map((target) => target.url);
}

/** Every row, paused included — the redirect chain's host allow list. */
export async function allTargetUrls(): Promise<string[]> {
  const targets = await listAffiliateTargets();
  return targets.map((target) => target.url);
}

export type AddTargetResult =
  | { ok: true; url: string; added: boolean }
  | { ok: false; error: string };

/**
 * Add one URL. The validation here is the panel's own rule
 * (`targetUrlProblem`), applied again because a server action is a public
 * endpoint: the form's `type="url"` is a convenience, not a check.
 */
export async function addAffiliateTarget(raw: string): Promise<AddTargetResult> {
  const url = raw.trim();
  const problem = targetUrlProblem(url);
  if (problem !== null) {
    return { ok: false, error: `That URL cannot be a target: ${problem}` };
  }

  const inserted = await db
    .insert(affiliateTargets)
    .values({ url })
    .onConflictDoNothing()
    .returning({ id: affiliateTargets.id });

  return { ok: true, url, added: inserted.length > 0 };
}

export type TargetMutationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export async function setAffiliateTargetEnabled(
  id: string,
  enabled: boolean,
): Promise<TargetMutationResult> {
  const rows = await db
    .update(affiliateTargets)
    .set({ enabled })
    .where(eq(affiliateTargets.id, id))
    .returning({ url: affiliateTargets.url });

  const row = rows[0];
  if (!row) return { ok: false, error: "That target is no longer in the list." };
  return { ok: true, url: row.url };
}

/**
 * Remove one target. The last row is refused rather than deleted: a producer
 * with an empty list fails its own guard, and a page that can reach that state
 * turns a misclick into a check that clicks nothing while looking healthy.
 */
export async function removeAffiliateTarget(
  id: string,
): Promise<TargetMutationResult> {
  const targets = await listAffiliateTargets();
  if (targets.length <= 1) {
    return {
      ok: false,
      error: "This is the last target. Add another one before removing it.",
    };
  }

  const rows = await db
    .delete(affiliateTargets)
    .where(eq(affiliateTargets.id, id))
    .returning({ url: affiliateTargets.url });

  const row = rows[0];
  if (!row) return { ok: false, error: "That target is no longer in the list." };
  return { ok: true, url: row.url };
}
