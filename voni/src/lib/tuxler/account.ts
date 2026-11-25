/**
 * What the account reports about itself, parsed from the relay's own frames.
 *
 * `changesLimit` is whatever `LIMITS_INFO` said — the client sizes its ledger from
 * it and never assumes the free tier's ten. Frames carry the account identifier and
 * the password; neither is kept, so nothing here can leak into a log or a response.
 */
import type { Frame } from "./frames";

export type TuxlerTier = "free" | "premium" | "unknown";

export interface TuxlerAccountState {
  tier: TuxlerTier;
  premium: boolean | null;
  /** `currentIPLocationChanges`: changes spent since the last reset. */
  changesUsed: number | null;
  /** `ipLocationChangesLimit`; `-1` means the account is not metered. */
  changesLimit: number | null;
  /** `bandwidthLimit` in bytes; `-1` means unlimited. */
  bandwidthLimit: number | null;
  /** `IPPool` size limit, informational. */
  poolLimit: number | null;
  /** ISO instant at which the change meter resets, when the relay says so. */
  resetAt: string | null;
}

export function emptyAccountState(): TuxlerAccountState {
  return {
    tier: "unknown",
    premium: null,
    changesUsed: null,
    changesLimit: null,
    bandwidthLimit: null,
    poolLimit: null,
    resetAt: null,
  };
}

/** `null` when the meter is unlimited, unknown, or has no usage figure yet. */
export function changesRemaining(state: TuxlerAccountState): number | null {
  if (state.changesLimit === null || state.changesUsed === null) return null;
  if (state.changesLimit < 0) return null;
  return Math.max(0, state.changesLimit - state.changesUsed);
}

function readJson(details: string): Record<string, unknown> | null {
  if (details.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(details);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readInteger(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `passok:1;premium:0;email:…;password:…;` */
function readKeyValues(details: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of details.split(";")) {
    const at = part.indexOf(":");
    if (at === -1) continue;
    out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}

/**
 * Fold one control frame into the account state. Unknown tags and unparseable
 * payloads return the state unchanged — a broken frame is not a crash.
 */
export function applyAccountFrame(
  state: TuxlerAccountState,
  frame: Frame,
): TuxlerAccountState {
  switch (frame.tag) {
    case "RECEIVED_ACCOUNT_INFO": {
      const fields = readKeyValues(frame.details);
      const premium = fields.get("premium");
      if (premium === undefined) return state;
      const isPremium = premium === "1";
      return { ...state, premium: isPremium, tier: isPremium ? "premium" : "free" };
    }
    case "ACCOUNT_INFO": {
      const body = readJson(frame.details);
      if (body === null) return state;
      const used = readInteger(body, "currentIPLocationChanges");
      return used === null ? state : { ...state, changesUsed: used };
    }
    case "LIMITS_INFO": {
      const body = readJson(frame.details);
      if (body === null) return state;
      const limit = readInteger(body, "ipLocationChangesLimit");
      const bandwidth = readInteger(body, "bandwidthLimit");
      const pool = readInteger(body, "ipLocationPoolLimit");
      return {
        ...state,
        changesLimit: limit ?? state.changesLimit,
        bandwidthLimit: bandwidth ?? state.bandwidthLimit,
        poolLimit: pool ?? state.poolLimit,
      };
    }
    case "RESET_INFO": {
      const raw = frame.details.trim();
      if (raw === "") return state;
      const when = new Date(raw);
      const resetAt = Number.isNaN(when.getTime()) ? null : when.toISOString();
      return { ...state, resetAt };
    }
    default:
      return state;
  }
}
