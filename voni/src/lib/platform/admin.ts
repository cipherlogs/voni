import { secret } from "@/lib/env";
import { APIError } from "better-auth/api";

export function emailIsAllowlisted(email: string, allowlist: string | undefined) {
  if (!allowlist) return false;
  const normalized = email.trim().toLowerCase();
  return allowlist
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

export async function isPlatformAdmin(email: string) {
  const raw = await secret("VONI_ADMIN_EMAILS");
  return emailIsAllowlisted(email, raw);
}

export async function requirePlatformAdmin(email: string) {
  if (!(await isPlatformAdmin(email))) {
    throw new Error("Platform administrator access is required.");
  }
}

/**
 * Private beta gate: only allowlisted emails may sign up or sign in. Throws a
 * coded APIError so Better Auth's OAuth callback redirects to the auth page
 * with `?error=invite_only` (see auth-decision.tsx).
 */
export async function requireInvitedEmail(email: string) {
  if (!(await isPlatformAdmin(email))) {
    throw new APIError("FORBIDDEN", { code: "invite_only", message: "Voni is invite-only during the private beta." });
  }
}
