import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { platformCredentials } from "@/lib/db/schema";
import { secret } from "@/lib/env";
import { decryptCredential, encryptCredential, encryptionKeyVersion } from "./encryption";
import {
  CREDENTIAL_ENV,
  type CredentialName,
  type CredentialSummary,
  type ResolvedCredential,
} from "./types";

export function maskCredential(value: string) {
  const visible = value.slice(-4);
  return `${"•".repeat(Math.max(4, Math.min(8, value.length - visible.length)))}${visible}`;
}

export async function resolveCredential(name: CredentialName): Promise<ResolvedCredential> {
  const [stored] = await db
    .select()
    .from(platformCredentials)
    .where(eq(platformCredentials.name, name))
    .limit(1);
  if (stored) {
    return {
      value: await decryptCredential(stored.ciphertext, stored.iv),
      source: "database",
      keyVersion: stored.keyVersion,
      updatedBy: stored.updatedBy,
      updatedAt: stored.updatedAt,
    };
  }
  const environmentValue = await secret(CREDENTIAL_ENV[name]);
  return environmentValue
    ? { value: environmentValue, source: "environment" }
    : { source: "missing" };
}

export async function credentialSummary(name: CredentialName): Promise<CredentialSummary> {
  const resolved = await resolveCredential(name);
  return {
    configured: Boolean(resolved.value),
    source: resolved.source,
    maskedPreview: resolved.value ? maskCredential(resolved.value) : undefined,
    keyVersion: resolved.keyVersion,
    updatedBy: resolved.updatedBy,
    updatedAt: resolved.updatedAt,
  };
}

export async function saveCredential(name: CredentialName, value: string, userId: string) {
  const trimmed = value.trim();
  if (!trimmed) return credentialSummary(name);
  const encrypted = await encryptCredential(trimmed);
  const keyVersion = await encryptionKeyVersion();
  const now = new Date();
  await db
    .insert(platformCredentials)
    .values({ name, ...encrypted, keyVersion, updatedBy: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: platformCredentials.name,
      set: { ...encrypted, keyVersion, updatedBy: userId, updatedAt: now },
    });
  return credentialSummary(name);
}

export async function removeCredentialOverride(name: CredentialName) {
  await db.delete(platformCredentials).where(eq(platformCredentials.name, name));
  return credentialSummary(name);
}
