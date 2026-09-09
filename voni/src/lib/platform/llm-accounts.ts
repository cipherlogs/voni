import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { llmProviderAccounts } from "@/lib/db/schema";
import { decryptCredential, encryptCredential, encryptionKeyVersion } from "./encryption";
import { maskCredential } from "./credentials";
import type { LlmProviderId } from "./types";

/**
 * Several operator-owned accounts per free-tier LLM provider (e.g. five Groq
 * accounts), so a rate-limited or failing account is skipped in favor of the
 * next rather than falling through to a weaker provider prematurely.
 *
 * Rotation policy is sticky failover with cooldown: `usableAccounts` always
 * returns accounts in `priority` order, so the same account is preferred call
 * after call until it fails. A failure puts it on an exponential-backoff
 * cooldown (30s, 60s, 120s, ... capped at 30min) rather than disabling it
 * outright, so a transient rate limit clears on its own.
 */

export type LlmAccountStatus = "ok" | "cooldown" | "disabled";

export type LlmAccountSummary = {
  id: string;
  providerId: LlmProviderId;
  label: string;
  maskedPreview: string;
  enabled: boolean;
  priority: number;
  status: LlmAccountStatus;
  cooldownUntil: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastUsedAt: Date | null;
  updatedAt: Date;
};

export type UsableLlmAccount = {
  id: string;
  providerId: LlmProviderId;
  label: string;
  value: string;
};

const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 30 * 60_000;

/** Exported for tests: exponential backoff (30s, 60s, 120s, ...) capped at 30min. */
export function backoffMs(consecutiveFailures: number) {
  return Math.min(BASE_COOLDOWN_MS * 2 ** Math.max(0, consecutiveFailures - 1), MAX_COOLDOWN_MS);
}

function summarize(row: typeof llmProviderAccounts.$inferSelect, plaintext: string): LlmAccountSummary {
  const inCooldown = Boolean(row.cooldownUntil && row.cooldownUntil > new Date());
  return {
    id: row.id,
    providerId: row.providerId as LlmProviderId,
    label: row.label,
    maskedPreview: maskCredential(plaintext),
    enabled: row.enabled,
    priority: row.priority,
    status: !row.enabled ? "disabled" : inCooldown ? "cooldown" : "ok",
    cooldownUntil: row.cooldownUntil,
    consecutiveFailures: row.consecutiveFailures,
    lastError: row.lastError,
    lastUsedAt: row.lastUsedAt,
    updatedAt: row.updatedAt,
  };
}

export async function listAccounts(providerId: LlmProviderId): Promise<LlmAccountSummary[]> {
  const rows = await db
    .select()
    .from(llmProviderAccounts)
    .where(eq(llmProviderAccounts.providerId, providerId))
    .orderBy(asc(llmProviderAccounts.priority), asc(llmProviderAccounts.createdAt));
  return Promise.all(rows.map(async (row) => summarize(row, await decryptCredential(row.ciphertext, row.iv))));
}

/** Accounts eligible to try right now, in sticky-failover order. */
export async function usableAccounts(providerId: LlmProviderId): Promise<UsableLlmAccount[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(llmProviderAccounts)
    .where(
      and(
        eq(llmProviderAccounts.providerId, providerId),
        eq(llmProviderAccounts.enabled, true),
        or(isNull(llmProviderAccounts.cooldownUntil), lt(llmProviderAccounts.cooldownUntil, now)),
      ),
    )
    .orderBy(asc(llmProviderAccounts.priority), asc(llmProviderAccounts.createdAt));
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      providerId: row.providerId as LlmProviderId,
      label: row.label,
      value: await decryptCredential(row.ciphertext, row.iv),
    })),
  );
}

export async function addAccount(providerId: LlmProviderId, label: string, value: string, userId: string) {
  const trimmedLabel = label.trim();
  const trimmedValue = value.trim();
  if (!trimmedLabel) throw new Error("Give this account a label.");
  if (!trimmedValue) throw new Error("Paste the API key.");
  const encrypted = await encryptCredential(trimmedValue);
  const keyVersion = await encryptionKeyVersion();
  const existing = await db
    .select({ priority: llmProviderAccounts.priority })
    .from(llmProviderAccounts)
    .where(eq(llmProviderAccounts.providerId, providerId));
  const nextPriority = existing.reduce((max, row) => Math.max(max, row.priority), -1) + 1;
  await db.insert(llmProviderAccounts).values({
    providerId,
    label: trimmedLabel,
    ...encrypted,
    keyVersion,
    priority: nextPriority,
    updatedBy: userId,
  });
}

export async function removeAccount(id: string) {
  await db.delete(llmProviderAccounts).where(eq(llmProviderAccounts.id, id));
}

export async function setAccountEnabled(id: string, enabled: boolean, userId: string) {
  await db
    .update(llmProviderAccounts)
    .set({ enabled, updatedBy: userId, updatedAt: new Date() })
    .where(eq(llmProviderAccounts.id, id));
}

/** Replace one account's encrypted value without exposing it to the browser. */
export async function rotateAccountCredential(id: string, value: string, userId: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Credential input is empty.");
  const encrypted = await encryptCredential(trimmed);
  const keyVersion = await encryptionKeyVersion();
  const updated = await db
    .update(llmProviderAccounts)
    .set({
      ...encrypted,
      keyVersion,
      updatedBy: userId,
      updatedAt: new Date(),
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastError: null,
    })
    .where(eq(llmProviderAccounts.id, id))
    .returning({ id: llmProviderAccounts.id });
  if (!updated[0]) throw new Error("LLM account not found.");
}

export async function markAccountSuccess(id: string) {
  await db
    .update(llmProviderAccounts)
    .set({ consecutiveFailures: 0, cooldownUntil: null, lastError: null, lastUsedAt: new Date() })
    .where(eq(llmProviderAccounts.id, id));
}

export async function markAccountFailure(id: string, reason: string) {
  const [row] = await db
    .select({ consecutiveFailures: llmProviderAccounts.consecutiveFailures })
    .from(llmProviderAccounts)
    .where(eq(llmProviderAccounts.id, id))
    .limit(1);
  const consecutiveFailures = (row?.consecutiveFailures ?? 0) + 1;
  await db
    .update(llmProviderAccounts)
    .set({
      consecutiveFailures,
      cooldownUntil: new Date(Date.now() + backoffMs(consecutiveFailures)),
      lastError: reason.slice(0, 500),
      lastUsedAt: new Date(),
    })
    .where(eq(llmProviderAccounts.id, id));
}

/** Decrypts one account regardless of enabled/cooldown state, for the "Test" button. */
export async function getAccountValue(id: string) {
  const [row] = await db.select().from(llmProviderAccounts).where(eq(llmProviderAccounts.id, id)).limit(1);
  if (!row) return null;
  return { providerId: row.providerId as LlmProviderId, value: await decryptCredential(row.ciphertext, row.iv) };
}
