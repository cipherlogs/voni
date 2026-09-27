/**
 * The floor: the one gate every line we prompt the agent to say goes
 * through (a `reply.create` with instructions). Live calls showed what
 * happens without it: a note sent while a tool call was running replaced
 * the reply waiting on its result (the reveal was lost), a welcome-back
 * landed on "Just sent!" and repeated it, and an invite note raced the
 * platform's own invite so both were spoken (sess_aacaf0224d0441cdb).
 *
 * A line goes out only when nobody holds the floor: no reply playing or
 * starting, no tool call running or awaiting its reply, playback settled,
 * and the caller not speaking. One line at a time; a line with a `key`
 * replaces the waiting one of the same key.
 *
 * Pure apart from the injected clock: the session feeds it events and
 * calls `tick()` on a short interval.
 */

export type FloorLine = {
  instructions: string;
  /** A newer line with the same key replaces the waiting one. */
  key?: string;
  /** Dropped instead of retried when the caller takes the floor first (check-ins). */
  droppable?: boolean;
  /** Next in line (a resume after a noise cut). */
  front?: boolean;
};

export type FloorDeps = {
  /** Send one reply.create; false when the socket is down (the line waits). */
  send: (instructions: string) => boolean;
  /** No agent audio queued or sounding. */
  settled: () => boolean;
  /** A tool call is running, or its result is held. */
  toolBusy: () => boolean;
  now?: () => number;
};

export type SilenceCheckIn = {
  afterMs: number;
  instructions: string;
  /** Not muted, not on hold, not closing. */
  allowed: () => boolean;
};

/** After the caller's final words, the platform's answer usually starts within this. */
export const CALLER_ANSWER_WAIT_MS = 2500;
/**
 * The caller holds the floor from speech start to speech stop. This caps a
 * stop that never comes (a lost event), never a real sentence: a 9s
 * monologue with sparse partials is still speech.
 */
const CALLER_SPEECH_MAX_MS = 30_000;
/** A tool result was sent: the platform's reply to it is coming. */
const TOOL_ANSWER_WAIT_MS = 2500;
/**
 * Our reply.create never started: free the floor. The line is not sent
 * again: the platform answers an idle reply.create within ~0.6s (measured),
 * and a late start after a resend would say it twice.
 */
const OURS_START_TIMEOUT_MS = 4000;

export class Floor {
  private queue: FloorLine[] = [];
  private replyActive = false;
  /** Our line, sent and not yet started. */
  private sent: { line: FloorLine; at: number } | null = null;
  /** Our line whose reply is playing. */
  private current: FloorLine | null = null;
  /** Our line whose reply was just cut. */
  private cut: FloorLine | null = null;
  private callerUntil = 0;
  private toolAnswerUntil = 0;
  private freeSince: number | null = null;
  private checkIn: SilenceCheckIn | null = null;
  private checkInArmed = true;
  private readonly now: () => number;

  constructor(private readonly deps: FloorDeps) {
    this.now = deps.now ?? Date.now;
  }

  setSilenceCheckIn(checkIn: SilenceCheckIn | null): void {
    this.checkIn = checkIn;
  }

  /** Queue a line; it goes out once the floor is free. */
  speak(line: FloorLine): void {
    if (line.key) this.queue = this.queue.filter((l) => l.key !== line.key);
    if (line.front) this.queue.unshift(line);
    else this.queue.push(line);
    this.tick();
  }

  /** Nobody holds the floor. */
  isFree(): boolean {
    const now = this.now();
    return (
      !this.replyActive &&
      this.sent === null &&
      !this.deps.toolBusy() &&
      now >= this.toolAnswerUntil &&
      now >= this.callerUntil &&
      this.deps.settled()
    );
  }

  /**
   * A reply started: ours, when one was sent (the platform answers a
   * reply.create within ~0.6s, measured). A caller who talks over it is the
   * server's barge-in to handle, like any reply.
   */
  replyStarted(): void {
    this.replyActive = true;
    this.callerUntil = 0;
    this.toolAnswerUntil = 0;
    this.freeSince = null;
    this.current = this.sent?.line ?? null;
    this.sent = null;
  }

  replyDone(interrupted: boolean): void {
    this.replyActive = false;
    this.cut = interrupted ? this.current : null;
    this.current = null;
  }

  /**
   * The caller really took the floor over our line (not a noise or a
   * filler, which resume the rest of it): say it again, whole, once the
   * floor frees. A droppable line just goes.
   */
  requeueCut(): void {
    const line = this.cut;
    this.cut = null;
    if (line) this.requeue(line);
  }

  callerSpeechStarted(): void {
    this.callerUntil = this.now() + CALLER_SPEECH_MAX_MS;
    this.freeSince = null;
    this.checkInArmed = true;
  }

  /** Speech stopped: the platform may still answer, or they may go on. */
  callerSpeechStopped(): void {
    this.callerUntil = Math.min(this.callerUntil, this.now() + CALLER_ANSWER_WAIT_MS);
  }

  /** Partial words: still speaking. */
  callerWords(): void {
    this.callerUntil = Math.max(this.callerUntil, this.now() + CALLER_ANSWER_WAIT_MS);
    this.freeSince = null;
  }

  /** The caller's final words: the platform's answer is coming. */
  callerTurnDone(): void {
    this.callerUntil = this.now() + CALLER_ANSWER_WAIT_MS;
  }

  /** The session judged the speech to be noise: the caller doesn't hold the floor. */
  callerWasNoise(): void {
    this.callerUntil = 0;
  }

  toolCalled(): void {
    this.freeSince = null;
  }

  toolResultSent(): void {
    this.toolAnswerUntil = this.now() + TOOL_ANSWER_WAIT_MS;
  }

  clear(): void {
    this.queue = [];
    this.sent = null;
    this.current = null;
    this.cut = null;
  }

  tick(): void {
    const now = this.now();
    if (this.sent && now - this.sent.at >= OURS_START_TIMEOUT_MS) this.sent = null;
    if (!this.isFree()) {
      this.freeSince = null;
      return;
    }
    this.freeSince ??= now;
    if (this.queue.length === 0) this.maybeCheckIn(now);
    const line = this.queue[0];
    if (!line) return;
    if (!this.deps.send(line.instructions)) return;
    this.queue.shift();
    this.sent = { line, at: now };
  }

  private maybeCheckIn(now: number): void {
    const checkIn = this.checkIn;
    if (!checkIn || !this.checkInArmed || this.freeSince === null) return;
    if (!checkIn.allowed()) {
      this.freeSince = now;
      return;
    }
    if (now - this.freeSince < checkIn.afterMs) return;
    this.checkInArmed = false;
    this.queue.push({ instructions: checkIn.instructions, key: "silence", droppable: true });
  }

  private requeue(line: FloorLine): void {
    if (line.droppable) return;
    if (line.key && this.queue.some((l) => l.key === line.key)) return;
    this.queue.unshift(line);
  }
}
