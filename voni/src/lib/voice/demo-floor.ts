import { SILENCE_CHECK_IN_INSTRUCTIONS, SILENCE_CHECK_IN_MS } from "@/lib/demo/voni-agent";
import { Floor, type SilenceCheckIn } from "./floor";

/**
 * The demo's silence check-in on the cascade (demo-cascade ticket 12).
 *
 * The managed session's Floor owned this rule: after a stretch of silence on a
 * free floor, one "still with me?" note goes out. On the cascade the service
 * owns the turn boundary, so the browser keeps the same Floor and feeds it the
 * same events — caller words, caller turn done, reply started/done — and the
 * check-in leaves through `speak()` as hidden context. It never becomes a
 * caption or a transcript turn, and the note is re-armed only when the caller
 * speaks again.
 */
export const DEMO_FLOOR_TICK_MS = 150;

export type DemoFloorDeps = {
  /** Send one hidden note; on the cascade this is `speak(...)`, never a caption. */
  speak: (instructions: string) => void;
  /** No agent audio queued or sounding, and the call can take a note. */
  settled: () => boolean;
  /** A tool call is running, or its result is held. */
  toolBusy: () => boolean;
  /** Not muted, not on hold, not closing, not waiting on a return. */
  allowed: () => boolean;
  /** Injected clock for tests; `Date.now()` otherwise. */
  now?: () => number;
};

/** The one Floor the demo cascade runs, armed with the configured check-in. */
export function createDemoFloor(deps: DemoFloorDeps): Floor {
  const floor = new Floor({
    send: (instructions) => {
      deps.speak(instructions);
      return true;
    },
    settled: deps.settled,
    toolBusy: deps.toolBusy,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const checkIn: SilenceCheckIn = {
    afterMs: SILENCE_CHECK_IN_MS,
    instructions: SILENCE_CHECK_IN_INSTRUCTIONS,
    allowed: deps.allowed,
  };
  floor.setSilenceCheckIn(checkIn);
  // Start the quiet clock at creation, not at the first interval tick.
  floor.tick();
  return floor;
}
