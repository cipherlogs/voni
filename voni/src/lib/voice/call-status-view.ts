import { formatCallStatus } from "../calls/call-status";
import type { VoiceState } from "./session";

/**
 * Call status copy derived during render (ticket 08 re-render hygiene).
 *
 * These were inline ternaries in `voice-call.tsx`; they now live here so
 * unit tests pin the exact strings (identical pixels) while the component
 * stays a thin derivation site with no synced-then-derived effect copies.
 * No React, no I/O.
 */

export type VoiceStatusInput = {
  state: VoiceState;
  elapsed: number;
  toolActive: boolean;
  filler: string | null;
  quotaExceeded: boolean;
};

/** "What is happening right now" — shared by both layouts; only rendered off-idle. */
export function getVoiceStatusText({
  state,
  elapsed,
  toolActive,
  filler,
  quotaExceeded,
}: VoiceStatusInput): string {
  if (state === "connecting") return "Calling…";
  if (state === "listening" || state === "speaking") {
    if (toolActive) return filler ?? "Looking that up…";
    return filler ?? `${formatCallStatus(elapsed)} · ${state === "speaking" ? "speaking" : "listening"}`;
  }
  if (quotaExceeded) return "Free demo time is up";
  return `Call ended · ${formatCallStatus(elapsed)}`;
}

export type DemoStatusInput = {
  hasError: boolean;
  returning: boolean;
  holding: boolean;
  connected: boolean;
  reconnecting: boolean;
  speaking: boolean;
  toolActive: boolean;
  filler: string | null;
  elapsed: number;
  statusText: string;
};

/** Demo header status: error, reconnecting, and hold read before the shared line. */
export function getDemoCallStatus({
  hasError,
  returning,
  holding,
  connected,
  reconnecting,
  speaking,
  toolActive,
  filler,
  elapsed,
  statusText,
}: DemoStatusInput): string {
  if (hasError && !returning) return "Call didn't connect";
  if (returning) return "Reconnecting…";
  if (holding && (connected || reconnecting)) return `On hold · ${formatCallStatus(elapsed)}`;
  if (connected && !toolActive && !filler) {
    return `${speaking ? "Speaking" : "Listening"} · ${formatCallStatus(elapsed)}`;
  }
  return statusText;
}
