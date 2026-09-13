"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { agents, copilotVoicePrefs, organizationSettings } from "@/lib/db/schema";
import { user } from "@/lib/db/auth-schema";
import { DEV_BYPASS_USER, devBypassEnabled } from "@/lib/dev-bypass";
import { organization } from "@/lib/db/auth-schema";
import { requireCtx } from "@/lib/session";
import { requirePlatformAdmin } from "@/lib/platform/admin";
import { removeCredentialOverride, saveCredential } from "@/lib/platform/credentials";
import { savePlatformConfig } from "@/lib/platform/config";
import {
  addAccount,
  removeAccount,
  setAccountEnabled,
} from "@/lib/platform/llm-accounts";
import {
  isCredentialName,
  LLM_PROVIDER_IDS,
  type LlmProviderId,
} from "@/lib/platform/types";
import {
  coerceCopilotVoicePrefs,
  copilotVoicePrefsSchema,
  type CopilotVoicePrefs,
} from "@/lib/copilot/voice-prefs";

function requireLlmProviderId(value: FormDataEntryValue | null): LlmProviderId {
  const id = String(value ?? "");
  if (!(LLM_PROVIDER_IDS as readonly string[]).includes(id)) throw new Error("Unknown LLM provider.");
  return id as LlmProviderId;
}

export type SettingsActionState = {
  ok: boolean;
  message?: string;
  error?: string;
};

const workspaceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  // Editable from the named list in the workspace form — any non-empty
  // IANA zone, so a legacy stored value never blocks a save.
  timezone: z.string().trim().min(1, "Pick a timezone."),
  humanTransferNumber: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\+[1-9]\d{7,14}$/.test(value), {
      message: "Use an E.164 number such as +971501234567.",
    }),
});

export async function updateWorkspaceSettings(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const ctx = await requireCtx();
    if (ctx.role !== "owner") throw new Error("Only workspace owners can change these settings.");
    const values = workspaceSchema.parse({
      name: formData.get("name"),
      timezone: formData.get("timezone"),
      humanTransferNumber: formData.get("humanTransferNumber"),
    });
    const now = new Date();
    await db
      .update(organization)
      .set({ name: values.name })
      .where(eq(organization.id, ctx.organizationId));
    await db
      .insert(organizationSettings)
      .values({
        organizationId: ctx.organizationId,
        timezone: values.timezone,
        humanTransferNumber: values.humanTransferNumber || null,
        updatedBy: ctx.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: {
          timezone: values.timezone,
          humanTransferNumber: values.humanTransferNumber || null,
          updatedBy: ctx.userId,
          updatedAt: now,
        },
      });
    revalidatePath("/settings");
    return { ok: true, message: "Workspace settings saved." };
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues[0]?.message
      : error instanceof Error
        ? error.message
        : "Workspace settings could not be saved.";
    return { ok: false, error: message };
  }
}

export async function updatePlatformCredential(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const ctx = await requireCtx();
    await requirePlatformAdmin(ctx.email);
    const name = String(formData.get("credential") ?? "");
    const value = String(formData.get("value") ?? "");
    if (!isCredentialName(name)) throw new Error("Unknown credential.");
    if (!value.trim()) return { ok: true, message: "No change. The current credential was preserved." };
    await saveCredential(name, value, ctx.userId);
    revalidatePath("/operator");
    return { ok: true, message: "Credential saved." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Credential could not be saved." };
  }
}

export async function removePlatformCredential(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const ctx = await requireCtx();
    await requirePlatformAdmin(ctx.email);
    const name = String(formData.get("credential") ?? "");
    if (!isCredentialName(name)) throw new Error("Unknown credential.");
    // Explicit confirm gate: the browser (or any future UI trigger) must send
    // the credential name back verbatim. There is no undo for a removal — the
    // deployment value (or nothing) takes over immediately.
    const confirm = String(formData.get("confirm") ?? "");
    if (confirm !== name) {
      throw new Error("Type the credential name to confirm removal.");
    }
    const summary = await removeCredentialOverride(name);
    revalidatePath("/operator");
    return {
      ok: true,
      message:
        summary.source === "environment"
          ? "Database override removed. The deployment value is active."
          : "Credential removed.",
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Credential could not be removed." };
  }
}

const nullable = (formData: FormData, name: string) => {
  const value = String(formData.get(name) ?? "").trim();
  return value && value !== "none" ? value : null;
};

export async function updatePlatformConfiguration(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const ctx = await requireCtx();
    await requirePlatformAdmin(ctx.email);
    const order = String(formData.get("llmProviderOrder") ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item): item is LlmProviderId => (LLM_PROVIDER_IDS as readonly string[]).includes(item));
    if (order.length !== LLM_PROVIDER_IDS.length || new Set(order).size !== LLM_PROVIDER_IDS.length) {
      throw new Error("Fallback order must contain each LLM provider exactly once.");
    }
    const bridgeOrganizationId = nullable(formData, "bridgeOrganizationId");
    const bridgeAgentId = nullable(formData, "bridgeAgentId");
    if (bridgeAgentId) {
      if (!bridgeOrganizationId) throw new Error("Select a bridge workspace before its agent.");
      const [agent] = await db
        .select({ id: agents.id, assemblyaiAgentId: agents.assemblyaiAgentId })
        .from(agents)
        .where(and(eq(agents.id, bridgeAgentId), eq(agents.organizationId, bridgeOrganizationId)))
        .limit(1);
      if (!agent?.assemblyaiAgentId) {
        throw new Error("The bridge agent must belong to the selected workspace and be deployed to AssemblyAI.");
      }
    }
    const requiredModel = (name: string) => {
      const value = String(formData.get(name) ?? "").trim();
      if (!value) throw new Error("LLM model names cannot be blank.");
      return value;
    };
    await savePlatformConfig(
      {
        groqModel: requiredModel("groqModel"),
        cerebrasModel: requiredModel("cerebrasModel"),
        geminiModel: requiredModel("geminiModel"),
        openrouterModel: requiredModel("openrouterModel"),
        llmProviderOrder: order,
        telnyxConnectionId: nullable(formData, "telnyxConnectionId"),
        telnyxCallerNumber: nullable(formData, "telnyxCallerNumber"),
        cartesiaVoiceId: nullable(formData, "cartesiaVoiceId"),
        bridgeOrganizationId,
        bridgeAgentId,
      },
      ctx.userId,
    );
    revalidatePath("/operator");
    return { ok: true, message: "Platform defaults saved." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Platform settings could not be saved." };
  }
}

export async function addLlmAccount(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const ctx = await requireCtx();
    await requirePlatformAdmin(ctx.email);
    const providerId = requireLlmProviderId(formData.get("providerId"));
    const label = String(formData.get("label") ?? "");
    const value = String(formData.get("value") ?? "");
    await addAccount(providerId, label, value, ctx.userId);
    revalidatePath("/operator");
    return { ok: true, message: "Account added." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Account could not be added." };
  }
}

export async function removeLlmAccount(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const ctx = await requireCtx();
    await requirePlatformAdmin(ctx.email);
    const id = String(formData.get("accountId") ?? "");
    if (!id) throw new Error("Unknown account.");
    // Explicit confirm gate, same shape as removePlatformCredential: the
    // account id must be sent back verbatim. Provider keys are rotated through
    // the operator CLI; this gate covers any future UI trigger too.
    const confirm = String(formData.get("confirm") ?? "");
    if (confirm !== id) {
      throw new Error("Type the account id to confirm removal.");
    }
    await removeAccount(id);
    revalidatePath("/operator");
    return { ok: true, message: "Account removed." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Account could not be removed." };
  }
}

export async function setLlmAccountEnabled(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const ctx = await requireCtx();
    await requirePlatformAdmin(ctx.email);
    const id = String(formData.get("accountId") ?? "");
    const enabled = String(formData.get("enabled") ?? "") === "true";
    if (!id) throw new Error("Unknown account.");
    await setAccountEnabled(id, enabled, ctx.userId);
    revalidatePath("/operator");
    return { ok: true, message: enabled ? "Account enabled." : "Account disabled." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Account could not be updated." };
  }
}



/**
 * The dev-bypass stub has no `user` row, and prefs FK to it. Materialize the
 * stub row on save — dev-only (double-gated), zero cost in production, so
 * local UI verification exercises the real FK path instead of skipping it.
 */
async function ensurePrefsOwner(userId: string): Promise<void> {
  if (!devBypassEnabled() || userId !== DEV_BYPASS_USER.id) return;
  await db
    .insert(user)
    .values({ id: DEV_BYPASS_USER.id, name: DEV_BYPASS_USER.name, email: DEV_BYPASS_USER.email })
    .onConflictDoNothing();
}

export async function getCopilotVoicePrefs(): Promise<CopilotVoicePrefs> {  const ctx = await requireCtx();
  const [row] = await db
    .select({ voiceId: copilotVoicePrefs.voiceId, language: copilotVoicePrefs.language })
    .from(copilotVoicePrefs)
    .where(eq(copilotVoicePrefs.userId, ctx.userId))
    .limit(1);
  return coerceCopilotVoicePrefs(row ?? null);
}

export async function updateCopilotVoicePrefs(
  _previous: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const parsed = copilotVoicePrefsSchema.safeParse({
    voiceId: formData.get("voiceId"),
    language: formData.get("language"),
  });
  if (!parsed.success) {
    return { ok: false, error: "Pick a voice and a language from the lists." };
  }
  try {
    const ctx = await requireCtx();
    await ensurePrefsOwner(ctx.userId);
    const values = parsed.data;
    const now = new Date();
    await db
      .insert(copilotVoicePrefs)
      .values({ userId: ctx.userId, ...values, updatedAt: now })
      .onConflictDoUpdate({
        target: copilotVoicePrefs.userId,
        set: { ...values, updatedAt: now },
      });
    revalidatePath("/settings");
    return { ok: true, message: "Voice copilot updated. It applies to your next conversation." };
  } catch (error) {
    console.error("[voice-prefs] save failed", error);
    return { ok: false, error: "Could not save your voice settings. Check your connection and try again." };
  }
}
