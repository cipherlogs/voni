import type { CascadeConnectFailure } from "./cascade-session";

/**
 * THE DEMO'S UNAVAILABLE COPY (demo-cascade ticket 11).
 *
 * The demo has no managed fallback: a refused cascade connect — or an
 * admitted call that never sounds (demo-cascade ticket 06: no second silent
 * start) — is the end of the call, not a handover. The visitor is owed the
 * same courtesy in every
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

/**
 * The line for a live call whose one reconnect could not resume it. The call
 * had already started, so this is not the connect refusal above: it names the
 * drop and the way back, never an engine or a vendor. The machine cause stays
 * in the call marks.
 */
export function demoReconnectFailedMessage(cause: string): string {
  return cause === "second-drop"
    ? "The call dropped again and can't be resumed. Please start a new call."
    : "The call dropped and couldn't be reconnected. Check your connection, then start a new call.";
}
