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
