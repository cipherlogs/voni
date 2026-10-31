import type { CascadeConnectFailure } from "./cascade-session";

/**
 * THE DEMO'S UNAVAILABLE COPY (demo-cascade ticket 11).
 *
 * The demo has no managed fallback: a refused cascade connect is the end of
 * the call, not a handover. The visitor is owed the same courtesy in every
 * refusal cause — one clear, human line that says the demo is unavailable and
 * what to do next. These strings name no engine, no route and no vendor: the
 * experience reads as one product.
 *
 * The mapping is pure so each cause can be pinned by a test without a socket.
 */
export type DemoCascadeFailure = CascadeConnectFailure;

export const DEMO_UNAVAILABLE_MESSAGES: Readonly<Record<DemoCascadeFailure, string>> = {
  draining:
    "The live demo is taking a short break for an update. Please try again in a minute.",
  managed:
    "The live demo isn't available on this line right now. Please try again in a minute.",
  unavailable:
    "The live demo couldn't start just now. Check your connection, then try again.",
  protocol:
    "This page can't reach the live demo right now. Reload the page and try again.",
};

/** The one visitor-facing line for a refused demo connect. */
export function demoUnavailableMessage(cause: DemoCascadeFailure): string {
  return DEMO_UNAVAILABLE_MESSAGES[cause];
}
