"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, phoneNumbers } from "@/lib/db/schema";
import { requireCtx, requireCtxOrRedirect } from "@/lib/session";
import { normalizePhoneE164 } from "@/lib/leads/csv";

/**
 * Inbound number binding (plan Day 7-8).
 *
 * A number belongs to one workspace and answers with one agent. Numbers are
 * registered by hand rather than synced from Telnyx: the Telnyx account is
 * platform-level and shared, so listing it here would show every workspace the
 * whole estate.
 */

export type NumberResult = { ok: true } | { ok: false; message: string };

export async function addPhoneNumberAction(
  rawNumber: string,
  label: string,
  agentId: string | null,
): Promise<NumberResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to add a number." };
  }

  // Same normaliser as the CSV importer, so a number typed here and the same
  // number imported in a list resolve to one string. Without that they would
  // never match and the binding would silently never fire.
  const e164 = normalizePhoneE164(rawNumber, "971");
  if (!e164) return { ok: false, message: `"${rawNumber}" is not a usable phone number.` };

  if (agentId) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.organizationId, ctx.organizationId)))
      .limit(1);
    if (!agent) return { ok: false, message: "That agent is not in this workspace." };
  }

  try {
    await db.insert(phoneNumbers).values({
      organizationId: ctx.organizationId,
      e164,
      label: label.trim() || null,
      agentId,
    });
  } catch {
    // `phone_numbers.e164` is globally unique — a real number exists once in the
    // world — so a conflict means someone already claimed it, possibly in
    // another workspace. Neither fact is safe to disclose beyond this.
    return { ok: false, message: `${e164} is already registered.` };
  }

  revalidatePath("/numbers");
  return { ok: true };
}

export async function bindPhoneNumberAction(
  id: string,
  agentId: string | null,
): Promise<NumberResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to change this number." };
  }

  if (agentId) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.organizationId, ctx.organizationId)))
      .limit(1);
    if (!agent) return { ok: false, message: "That agent is not in this workspace." };
  }

  const updated = await db
    .update(phoneNumbers)
    .set({ agentId, updatedAt: new Date() })
    .where(
      and(eq(phoneNumbers.id, id), eq(phoneNumbers.organizationId, ctx.organizationId)),
    )
    .returning({ id: phoneNumbers.id });
  if (updated.length === 0) return { ok: false, message: "Number not found." };

  revalidatePath("/numbers");
  return { ok: true };
}

export async function removePhoneNumberAction(id: string): Promise<NumberResult> {
  let ctx;
  try {
    ctx = await requireCtx();
  } catch {
    return { ok: false, message: "Sign in again to remove this number." };
  }
  await db
    .delete(phoneNumbers)
    .where(
      and(eq(phoneNumbers.id, id), eq(phoneNumbers.organizationId, ctx.organizationId)),
    );
  revalidatePath("/numbers");
  return { ok: true };
}

export async function listPhoneNumbers() {
  const ctx = await requireCtxOrRedirect("/numbers");
  return db
    .select({
      id: phoneNumbers.id,
      e164: phoneNumbers.e164,
      label: phoneNumbers.label,
      inboundEnabled: phoneNumbers.inboundEnabled,
      agentId: phoneNumbers.agentId,
      agentName: agents.name,
      agentDeployed: agents.assemblyaiAgentId,
    })
    .from(phoneNumbers)
    .leftJoin(agents, eq(agents.id, phoneNumbers.agentId))
    .where(eq(phoneNumbers.organizationId, ctx.organizationId))
    .orderBy(desc(phoneNumbers.createdAt));
}
