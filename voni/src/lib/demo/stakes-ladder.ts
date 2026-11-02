/**
 * The demo's stakes ladder: a nudge, a warm warning, then a polite end.
 *
 * Strikes are cumulative across the call: an on-track turn does not
 * reset them. Each off-track verdict (Jev, or the heuristic fallback)
 * climbs one rung.
 *
 * An upset or complaining turn is answered, never steered: it climbs no rung,
 * so no note can put a test offer or a business question over a complaint.
 */

export type Rung = "nudge" | "warning" | "end";

export type LadderVerdict = {
  offTrack: boolean;
  /** The judge read the turn as a complaint, not as trolling or stalling. */
  upset?: boolean;
};

const RUNGS: Rung[] = ["nudge", "warning", "end"];

export class StakesLadder {
  strikes = 0;

  /** The rung to deliver for this verdict, or null. */
  onVerdict(verdict: LadderVerdict | boolean): Rung | null {
    const offTrack = typeof verdict === "boolean" ? verdict : verdict.offTrack;
    const upset = typeof verdict === "boolean" ? false : verdict.upset === true;
    if (!offTrack || upset || this.strikes >= RUNGS.length) return null;
    this.strikes += 1;
    return RUNGS[this.strikes - 1];
  }
}
