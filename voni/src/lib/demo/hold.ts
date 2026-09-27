import type { Transcript } from "@/lib/voice/session";
import type { VoiceErrorCode } from "@/lib/voice/mic-capture";
import type { EmailTestState } from "./email-test";

/**
 * Hold: the paused state of a demo call after the browser stops the page
 * (`freeze`) or the connection drops while the visitor is away. A hidden
 * page that stays live is a flap, never a hold: the call keeps talking and
 * the talk clock keeps running (Android Chrome, desktop tabs). Hold lasts at
 * most HOLD_CAP_S of wall time, then the call ends politely.
 *
 * Pure state + decisions only: the component owns the listeners, the mic,
 * and the spoken lines. Within the server's resume grace the same session is
 * resumed (real memory); past it, a fresh session gets the call memory.
 */

export const HOLD_CAP_S = 120;

/** AssemblyAI keeps a dropped session resumable this long. */
export const RESUME_GRACE_MS = 30_000;

/** A tab switch (flap) at least this long gets a welcome-back line; a quicker one gets nothing. */
export const FLAP_WELCOME_MS = 5000;

/** Where the session stands when the visitor comes back from a hold. */
export type HoldSessionStatus = "live" | "reconnecting" | "parked" | "gone";

/**
 * What a return from hold does:
 * - `endCapped`: away past the cap, end politely.
 * - `unhold`: the connection survived (frozen page), welcome back now.
 * - `await`: an auto-resume is in flight, welcome back when it lands.
 * - `resume`: the socket dropped inside the grace, resume the same session.
 * - `rejoin`: the session is gone, a fresh one gets the call memory.
 */
export type HoldReturn = "endCapped" | "unhold" | "await" | "resume" | "rejoin";

/** Pure: the return path from the away time and the session's state. */
export function decideHoldReturn(opts: {
  heldMs: number;
  status: HoldSessionStatus;
  /** Ms since the socket dropped (parked only). */
  droppedMs?: number;
}): HoldReturn {
  if (opts.heldMs >= HOLD_CAP_S * 1000) return "endCapped";
  switch (opts.status) {
    case "live":
      return "unhold";
    case "reconnecting":
      return "await";
    case "parked":
      return (opts.droppedMs ?? 0) < RESUME_GRACE_MS ? "resume" : "rejoin";
    case "gone":
      return "rejoin";
  }
}

/**
 * A dropped socket parks (no resume attempts) only while the page is hidden
 * in a demo call: a background page may not reach the network, so attempts
 * burned there would end the call before the visitor is back. Visible drops
 * auto-resume at once as before.
 */
export function shouldParkOnDrop(demo: boolean, hidden: boolean): boolean {
  return demo && hidden;
}

export class HoldState {
  private holdStartedAt: number | null = null;

  get holding(): boolean {
    return this.holdStartedAt !== null;
  }

  /** True when this call newly entered hold. */
  enter(now: number): boolean {
    if (this.holdStartedAt !== null) return false;
    this.holdStartedAt = now;
    return true;
  }

  /** Ms spent on hold, or null when idle. */
  exit(now: number): number | null {
    if (this.holdStartedAt === null) return null;
    const heldMs = now - this.holdStartedAt;
    this.holdStartedAt = null;
    return heldMs;
  }

  holdSeconds(now: number): number {
    if (this.holdStartedAt === null) return 0;
    return Math.floor((now - this.holdStartedAt) / 1000);
  }

  isExpired(now: number): boolean {
    return this.holdSeconds(now) >= HOLD_CAP_S;
  }
}

/**
 * A resume that died after a hold return: rejoin silently only when the old
 * transport is terminally gone (1008 refusal, grace over, exhausted
 * attempts, failed resume fetch). Mic/auth/config/rate-limit failures need
 * the visitor to act, so those still surface instead of looping a restart
 * they can't hear. One silent retry per return: a second terminal failure
 * surfaces (`alreadyRejoining`).
 */
export function shouldRejoinAfterHold(
  returnPending: boolean,
  code?: VoiceErrorCode,
  alreadyRejoining = false,
): boolean {
  if (!returnPending || alreadyRejoining) return false;
  return code === "network" || code === "expired";
}

/**
 * Call memory for a post-grace restart (fresh server session, same demo
 * call in the visitor's eyes). A fallback only: inside the grace the same
 * session resumes with its real memory. The full transcript fits a demo
 * call; newest turns survive truncation, and the instruction forbids
 * starting over or narrating the reconnection.
 */
export function buildHoldCarryover(turns: Transcript[], maxChars = 8000): string {
  const lines = turns.map((t) => `${t.role === "user" ? "Visitor" : "Voni"}: ${t.text}`);
  let kept = lines;
  while (kept.join("\n").length > maxChars && kept.length > 0) {
    kept = kept.slice(1);
  }
  const history = kept.length > 0 ? ` What was said so far (oldest first):\n${kept.join("\n")}` : "";
  return (
    "The call paused while the visitor was away from the page and has now " +
    `resumed on a new connection.${history} ` +
    "Keep going naturally from where you left off; do not start over, " +
    "do not re-introduce yourself, and do not mention any reconnection."
  );
}

/**
 * Call memory in `sessionStorage`, so a reload or a discarded background tab
 * comes back to the same call within the hold cap. Per tab by design (a
 * second tab is a second visitor action). Every access is guarded: storage
 * can throw in private modes, and the call must work without it.
 */
export const CALL_MEMORY_KEY = "voni:demo-call";

export type CallMemorySnapshot = {
  savedAt: number;
  voiceId: string;
  turns: Transcript[];
  talkSeconds: number;
  strikes: number;
  /** The email test's progress (optional: snapshots saved before ticket 03 lack it). */
  emailTest?: EmailTestState;
  /** The call's scope token, so a reload continues the same call (inbox window, budgets). */
  callToken?: string | null;
  /** Server session to resume inside the grace; null once it is gone. */
  sessionId: string | null;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function saveCallMemory(snapshot: CallMemorySnapshot, store = storage()): void {
  try {
    store?.setItem(CALL_MEMORY_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota or privacy mode: the call goes on without a reload safety net.
  }
}

export function clearCallMemory(store = storage()): void {
  try {
    store?.removeItem(CALL_MEMORY_KEY);
  } catch {
    // Same as above.
  }
}

/** The saved call, if it is still inside the hold cap; stale or bad entries are cleared. */
export function loadCallMemory(now: number, store = storage()): CallMemorySnapshot | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(CALL_MEMORY_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw) as CallMemorySnapshot;
    const fresh =
      typeof snap.savedAt === "number" &&
      now - snap.savedAt >= 0 &&
      now - snap.savedAt < HOLD_CAP_S * 1000 &&
      typeof snap.voiceId === "string" &&
      Array.isArray(snap.turns);
    if (fresh) return snap;
  } catch {
    // Corrupt entry: fall through and clear it.
  }
  clearCallMemory(store);
  return null;
}
