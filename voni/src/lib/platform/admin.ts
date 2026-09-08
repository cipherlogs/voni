import { secret } from "@/lib/env";

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
