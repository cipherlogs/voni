/**
 * The demo call's talk clock: time counts only while the visitor can talk.
 *
 * Mute pauses it (hold will too), so a visitor who steps away is not billed
 * minutes of their demo. Credits are protected separately by the wall-clock
 * cap, which never pauses: the server enforces WALL_CAP_S through the token
 * (`max_session_duration_seconds`), and the client starts its polite close
 * WALL_CLOSE_S in, leaving room for the goodbye before the server cuts.
 */

export const TALK_BASE_S = 120;
export const WALL_CAP_S = 720;
export const WALL_CLOSE_S = WALL_CAP_S - 20;
export const MUTE_CHECK_IN_S = 20;

export class TalkClock {
  private pausedMs = 0;
  private mutedAt: number | null = null;
  private heldAt: number | null = null;
  private pauseStartedAt: number | null = null;
  private checkedIn = false;

  constructor(private readonly startedAt: number) {}

  setMuted(muted: boolean, now: number): void {
    if (muted && this.mutedAt === null) {
      this.mutedAt = now;
      this.checkedIn = false;
      if (this.pauseStartedAt === null) this.pauseStartedAt = now;
    } else if (!muted && this.mutedAt !== null) {
      this.mutedAt = null;
      if (this.heldAt === null && this.pauseStartedAt !== null) {
        this.pausedMs += now - this.pauseStartedAt;
        this.pauseStartedAt = null;
      }
    }
  }

  /** Hold pauses the clock like mute, but never arms the mute check-in. */
  setHeld(held: boolean, now: number): void {
    if (held && this.heldAt === null) {
      this.heldAt = now;
      if (this.pauseStartedAt === null) this.pauseStartedAt = now;
    } else if (!held && this.heldAt !== null) {
      this.heldAt = null;
      if (this.mutedAt === null && this.pauseStartedAt !== null) {
        this.pausedMs += now - this.pauseStartedAt;
        this.pauseStartedAt = null;
      }
    }
  }

  talkSeconds(now: number): number {
    const paused = this.pausedMs + (this.pauseStartedAt === null ? 0 : now - this.pauseStartedAt);
    return Math.floor((now - this.startedAt - paused) / 1000);
  }

  remainingSeconds(now: number): number {
    return Math.max(0, TALK_BASE_S - this.talkSeconds(now));
  }

  isOver(now: number): boolean {
    return this.talkSeconds(now) >= TALK_BASE_S || now - this.startedAt >= WALL_CLOSE_S * 1000;
  }

  /** True exactly once per mute stretch, once it has lasted MUTE_CHECK_IN_S. */
  takeCheckIn(now: number): boolean {
    if (this.mutedAt === null || this.checkedIn) return false;
    if (now - this.mutedAt < MUTE_CHECK_IN_S * 1000) return false;
    this.checkedIn = true;
    return true;
  }
}
