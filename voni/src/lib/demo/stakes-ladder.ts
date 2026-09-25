/**
 * The demo's stakes ladder: a nudge, a warm warning, then a polite end.
 *
 * Strikes are cumulative across the call: an on-track turn does not
 * reset them. Each off-track verdict (Jev, or the heuristic fallback)
 * climbs one rung.
 */

export type Rung = "nudge" | "warning" | "end";

const RUNGS: Rung[] = ["nudge", "warning", "end"];

export class StakesLadder {
  strikes = 0;

  /** The rung to deliver for this verdict, or null. */
  onVerdict(offTrack: boolean): Rung | null {
    if (!offTrack || this.strikes >= RUNGS.length) return null;
    this.strikes += 1;
    return RUNGS[this.strikes - 1];
  }
}

/**
 * Wait this long before speaking into an idle floor. The judge's verdict
 * can arrive before the agent's reply to that same turn has started, and
 * the Voice Agent API has no way to cancel a reply, so the queue waits
 * this long for it to begin. If it begins, delivery waits for it to finish.
 */
export const REPLY_GRACE_MS = 1200;

/**
 * Delivers one-shot instructions (`reply.create`) without talking over a
 * reply that is still in progress. First in, first out: every rung is spoken
 * in order, never skipped by a later one.
 */
export class ReplyQueue {
  private replyActive = false;
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deliver: (instructions: string) => void) {}

  onReplyStarted(): void {
    this.replyActive = true;
  }

  /** The caller took the floor: hold until the agent's answer to them finishes. */
  onCallerSpeech(): void {
    this.replyActive = true;
  }

  onReplyDone(): void {
    this.replyActive = false;
    this.flush();
  }

  enqueue(instructions: string): void {
    this.pending.push(instructions);
    if (this.replyActive) return;
    this.arm();
  }

  clear(): void {
    this.pending = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, REPLY_GRACE_MS);
  }

  private flush(): void {
    if (this.replyActive || this.pending.length === 0) return;
    // A grace timer may still be armed (reply finished before it fired):
    // cancel it so a later enqueue gets its own full grace.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const instructions = this.pending.shift() as string;
    this.deliver(instructions);
    // The reply to this one may still be starting (grace covers that); if
    // more is queued, re-arm so it follows without stalling when no reply
    // ever starts, and waits for it to finish when one does.
    if (this.pending.length > 0) this.arm();
  }
}
