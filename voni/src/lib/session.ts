import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, organization } from "@/lib/db/auth-schema";
import { safeNextPath } from "@/lib/auth-redirect";
import { devBypassEnabled, DEV_BYPASS_USER } from "@/lib/dev-bypass";

/**
 * Resolve the signed-in user and the organization their data belongs to.
 *
 * Plan Section N: "auto-create an Organization on first login with that user as
 * owner". Better Auth's organization plugin creates the *tables* but not the
 * row — a brand-new Google sign-in has a user, a session, and no org, which
 * would leave every `organization_id` column with nothing to put in it.
 *
 * The rows are written directly rather than through the plugin's API because
 * these are our tables and the ids are ours to mint; going through the plugin
 * would add a slug-uniqueness dance for no benefit at first-login scale.
 */

export type Ctx = {
  userId: string;
  organizationId: string;
  email: string;
  name: string;
  image: string | null;
  role: string;
};

/**
 * The signed-out case has two callers with opposite needs, so it gets two
 * entry points rather than one that guesses:
 *
 * - Pages need a redirect. The dashboard layout already gates on session, but
 *   layouts and pages render *concurrently* in the App Router — so a page's
 *   data fetch runs before the layout's redirect resolves, and a plain throw
 *   there surfaces as a logged error on every signed-out request.
 * - Mutating server actions need a value they can catch and turn into a
 *   message, because `redirect()` throws NEXT_REDIRECT and a try/catch around
 *   it would swallow the navigation.
 *
 * `getCtx` is the shared core; the two wrappers below pick the failure mode.
 */
export async function getCtx(): Promise<Ctx | null> {
  if (devBypassEnabled()) {
    return {
      userId: DEV_BYPASS_USER.id,
      organizationId: "dev-bypass-org",
      email: DEV_BYPASS_USER.email,
      name: DEV_BYPASS_USER.name,
      image: DEV_BYPASS_USER.image,
      role: "owner",
    };
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const userId = session.user.id;

  // The session carries the active org once one is set; trust it when present
  // so the common path is zero extra queries.
  const active = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  if (active) {
    const [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, active)))
      .limit(1);
    if (membership) {
      return {
        userId,
        organizationId: active,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? null,
        role: membership.role,
      };
    }
  }

  const existing = await db
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    return {
      userId,
      organizationId: existing[0].organizationId,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image ?? null,
      role: existing[0].role,
    };
  }

  // First sign-in: mint the org and make this user its owner.
  const orgId = crypto.randomUUID();
  // Slug has a unique index, so derive from the id rather than the name —
  // two users called "Acme" signing up must not collide.
  const slug = `org-${orgId.slice(0, 8)}`;
  const orgName = session.user.name
    ? `${session.user.name}'s workspace`
    : "My workspace";

  await db.insert(organization).values({
    id: orgId,
    name: orgName,
    slug,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });

  return {
    userId,
    organizationId: orgId,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image ?? null,
    role: "owner",
  };
}

/** For server actions: throws so the caller can render an inline message. */
export async function requireCtx(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) throw new Error("Not signed in");
  return ctx;
}

/** For pages and page-level reads: sends the visitor to the landing page. */
export async function requireCtxOrRedirect(nextPath = "/dashboard"): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) redirect(`/login?next=${encodeURIComponent(safeNextPath(nextPath))}`);
  return ctx;
}
