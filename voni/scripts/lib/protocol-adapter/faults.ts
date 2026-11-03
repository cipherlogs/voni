/**
 * The media seam's two transformations: the soundscape mixed under the caller,
 * and the scenario's faults applied to the uplink.
 *
 * Both are pure over a frame and call time, so the protocol adapter and the
 * browser adapter (ticket 17) can apply the same scenario record the same way.
 * A fault never changes the scenario; it either drops a frame, delays it, or
 * ends the call, and every choice is recorded.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "One seam, two adapters" and the
 * scenario schema's `faults` vocabulary.
 */

import type { Fault } from "@/lib/demo/verification/scenarios";

import { INGRESS_FRAME_MS } from "../real-legs";
import type { AppliedFault } from "./types";

/** The default soundscape level when a scenario does not pin one. */
export const DEFAULT_SOUNDSCAPE_LEVEL_DB = -30;

/** Digital silence: the named soundscape that mixes nothing. */
export const QUIET_SOUNDSCAPE = "quiet-room";

export type UplinkFrameDecision = {
  /** False means the frame is a gap: it is not sent. */
  readonly send: boolean;
  /** How long the frame waits before it is sent; 0 is the pump's own cadence. */
  readonly delayMs: number;
  /** The fault that caused a drop or delay, for the run record. */
  readonly fault: Fault | null;
};

function inWindow(fault: Fault, atMs: number): boolean {
  if (atMs < fault.atMs) return false;
  // An instantaneous fault covers the one frame due at its instant; a frame
  // clock rarely lands exactly on a whole millisecond, so equality alone would
  // silently apply nothing.
  if (fault.durationMs === undefined) return atMs < fault.atMs + INGRESS_FRAME_MS;
  return atMs < fault.atMs + fault.durationMs;
}

/**
 * Decide one caller frame from the scenario's faults. The order is deliberate:
 * a dropout is a gap and wins over a delay; the largest delay wins otherwise,
 * because a frame that is both jittered and endpoint-latent arrives late by the
 * larger amount.
 */
export function decideUplinkFrame(
  faults: readonly Fault[],
  atMs: number,
): UplinkFrameDecision {
  let delayMs = 0;
  let delayFault: Fault | null = null;

  for (const fault of faults) {
    if (fault.kind === "call-drop") continue;
    if (!inWindow(fault, atMs)) continue;
    if (fault.kind === "audio-dropout") {
      return { send: false, delayMs: 0, fault };
    }
    if (fault.kind === "network-jitter") {
      // Deterministic jitter: four steps inside the declared window, so two
      // runs of one scenario see the same shape and a test can pin it.
      const ceil = Math.max(1, fault.durationMs ?? 1);
      const step = Math.floor(atMs / INGRESS_FRAME_MS) % 4;
      const candidate = (step * ceil) / 4;
      if (candidate > delayMs) {
        delayMs = candidate;
        delayFault = fault;
      }
    }
    if (fault.kind === "endpoint-latency") {
      const candidate = Math.max(1, fault.durationMs ?? 1);
      if (candidate > delayMs) {
        delayMs = candidate;
        delayFault = fault;
      }
    }
  }

  return { send: true, delayMs, fault: delayFault };
}

/** The earliest instant at which a `call-drop` fault ends the call. */
export function callDropAtMs(faults: readonly Fault[]): number | null {
  const drops = faults.filter((fault) => fault.kind === "call-drop");
  if (drops.length === 0) return null;
  return Math.min(...drops.map((fault) => fault.atMs));
}

/** The gain a soundscape's dB level means, clamped to full scale by the mixer. */
export function soundscapeGain(levelDb: number | undefined): number {
  return Math.pow(10, (levelDb ?? DEFAULT_SOUNDSCAPE_LEVEL_DB) / 20);
}

/**
 * Mix one loop of a soundscape into a PCM16 frame in place.
 *
 * `pcm` is a looped soundscape at 24 kHz mono PCM16; `atMs` places the frame
 * in call time so the loop is continuous across frames. Samples are summed and
 * clipped, never rescaled: a loud soundscape that clips is evidence of the
 * level the caller heard, not a quietly normalised file.
 */
export function mixSoundscape(
  frame: Uint8Array,
  soundscapePcm: Uint8Array,
  atMs: number,
  levelDb: number | undefined,
): void {
  if (soundscapePcm.byteLength < 2 || frame.byteLength === 0) return;
  const gain = soundscapeGain(levelDb);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const source = new DataView(
    soundscapePcm.buffer,
    soundscapePcm.byteOffset,
    soundscapePcm.byteLength,
  );
  const sourceSamples = Math.floor(soundscapePcm.byteLength / 2);
  const startSample = Math.floor((atMs * 24_000) / 1_000) % sourceSamples;
  for (let index = 0; index * 2 + 1 < frame.byteLength; index += 1) {
    const mixed =
      view.getInt16(index * 2, true) +
      Math.round(source.getInt16(((startSample + index) % sourceSamples) * 2, true) * gain);
    view.setInt16(index * 2, Math.max(-32768, Math.min(32767, mixed)), true);
  }
}

/**
 * Collect the faults the run actually applied into the evidence record. A
 * scenario fault that never fired is a gap the runner records separately; this
 * function only counts what the media seam saw.
 */
export function appliedFaults(
  faults: readonly Fault[],
  counts: ReadonlyMap<string, number>,
): AppliedFault[] {
  return faults.map((fault) => {
    const count = counts.get(`${fault.kind}@${fault.atMs}`) ?? 0;
    const observed =
      fault.kind === "call-drop"
        ? count > 0
          ? "the call was closed at the fault point"
          : "the call ended before the fault point"
        : fault.kind === "audio-dropout"
          ? `${count} caller frame(s) dropped`
          : `${count} caller frame(s) delayed`;
    return {
      kind: fault.kind,
      atMs: fault.atMs,
      ...(fault.durationMs === undefined ? {} : { durationMs: fault.durationMs }),
      observed,
    };
  });
}
