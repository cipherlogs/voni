/**
 * Light call-chrome constants shared by the voice engine and its hosts.
 *
 * Ticket 05 splits the heavy `voice-call` engine behind `next/dynamic`, so
 * the landing demo card and the Test agent dialog must paint their chrome
 * (start/hang-up fills, session cap) without importing the engine. This
 * module carries only those constants — no session, no judges, no tools —
 * so hosts stay in the first-paint bundle while the engine loads on demand.
 * Values are frozen: identical Demo call / Test call behavior after load.
 */

/**
 * Call = green solid fill. Universal across every phone, softphone and
 * messaging app (Jakob's Law).
 *
 * The live-call green is scoped (`.voice-call-live-fill` in globals.css —
 * owned by a parallel crew, referenced here, never defined here), never a
 * general token. Fill-only with white text; never body text.
 */
export const CALL_GREEN = "voice-call-live-fill";

/**
 * Hang-up is spelled out rather than using the `destructive` button variant:
 * this scaffold's `destructive` is a TINT (`bg-destructive/10` with red
 * text), not the solid red fill a hang-up button needs. The solid fill still
 * comes from the `destructive` token (both themes) with white text — no raw
 * red shade and no manual dark-mode overrides.
 */
export const HANGUP_RED = "bg-destructive text-white hover:bg-destructive/90";

/** Session caps, in seconds. The server enforces them; the UI only mirrors. */
export const INLINE_CAP_SECONDS = 180;
