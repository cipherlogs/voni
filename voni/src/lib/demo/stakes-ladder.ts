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
 * reply that is still in progress. Latest instruction wins.
 */
export class ReplyQueue {
  private replyActive = false;
  private pending: string | null = null;
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
    this.pending = instructions;
    if (this.replyActive) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), REPLY_GRACE_MS);
  }

  clear(): void {
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private flush(): void {
    if (this.replyActive || this.pending === null) return;
    const instructions = this.pending;
    this.clear();
    this.deliver(instructions);
  }
}
