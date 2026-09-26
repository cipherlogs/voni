import type { Transcript } from "@/lib/voice/session";
import type { VoiceErrorCode } from "@/lib/voice/mic-capture";

/**
 * Hold: the paused state of a demo call while the visitor is away from the
 * page (spec beat 3). Mic and talk clock pause; the wall-clock cap does not.
 * Hold lasts at most HOLD_CAP_S of wall time, then the call ends politely.
 *
 * Pure state + timestamps only: the component owns the visibility listener,
 * the mic, and the spoken lines. Reconnect tiers live in the session; the
 * carryover builder below is what a post-grace restart whispers so Voni
 * does not start from scratch.
 */

export const HOLD_CAP_S = 120;

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
 * transport is terminally gone (1008 refusal, exhausted attempts, failed
 * resume fetch). Mic/auth/config/rate-limit failures need the visitor to
 * act, so those still surface instead of looping a restart they can't hear.
 */
export function shouldRejoinAfterHold(
  returnPending: boolean,
  code?: VoiceErrorCode,
): boolean {
  if (!returnPending) return false;
  return code === "network" || code === "expired";
}

/**
 * Hidden resume cue for a post-grace restart (fresh server session, same
 * demo call in the visitor's eyes). Newest turns survive truncation; the
 * instruction forbids starting over or narrating the reconnection.
 */
export function buildHoldCarryover(turns: Transcript[], maxChars = 1200): string {
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
