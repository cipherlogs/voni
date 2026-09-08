/**
 * Idle rule: end the session after `idleMs` with no user speech, agent
 * speech, or panel interaction. Thinking pauses count as idle (that's the
 * point of the check-in), but typing and taps extend the clock — hybrid mode
 * means the user may answer with the keyboard. Suspended while speech,
 * readback, or confirmed execution is underway, and while on standby break
 * (standby has its own rule but never outlives the cap).
 */

export function shouldEndIdle(opts: {
  now: number;
  lastActivityAt: number;
  idleMs: number;
  live: boolean;
  suspended: boolean;
}): boolean {
  if (!opts.live || opts.suspended) return false;
  return opts.now - opts.lastActivityAt >= opts.idleMs;
}

/** Eligible for the soft check-in shortly before the idle deadline. */
export function shouldCheckIn(opts: {
  now: number;
  lastActivityAt: number;
  idleMs: number;
  checkInLeadMs: number;
  live: boolean;
  suspended: boolean;
  checkInSent: boolean;
}): boolean {
  if (!opts.live || opts.suspended || opts.checkInSent) return false;
  const elapsed = opts.now - opts.lastActivityAt;
  return elapsed >= opts.idleMs - opts.checkInLeadMs && elapsed < opts.idleMs;
}
