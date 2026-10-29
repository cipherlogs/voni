/**
 * Which sample rate the playout's audio context runs at.
 *
 * The microphone and the playout deliberately share one `AudioContext` so the
 * echo canceller hears what we play (see mic-capture.ts). That context's rate
 * is the hardware's business: a Bluetooth headset in headset mode may open at
 * 16 kHz, a telephony route at 8 kHz. When that rate is below the rate the
 * agent streams at, the playout worklet has to drop samples, and the decimating
 * low-pass in `public/playout-processor.js` (ticket 34) makes that safe.
 *
 * But the filter is only needed because the context is below the stream. Where
 * the platform will open a context *at* the stream rate, no sample is dropped
 * and no filter is needed at all — so that context is preferred. Some platforms
 * ignore the request and open at their own device rate; Safari refuses the
 * option outright. Neither is a reason to fail a call: the preference falls back
 * to the plain device context, and the low-pass stays mandatory there.
 *
 * The request is never trusted. The returned `rate` is the live context's
 * `sampleRate`, so the worklet's device rate and the playout's `msg.rate` can
 * never disagree about which one is a lie, and a context that did not honour
 * the request is closed rather than used as if it had.
 */

/** The one option this module sets on an `AudioContext`. */
export type ContextOptions = { sampleRate?: number };

/**
 * The constructor seam. Regex-free and browser-free on purpose: the choice is
 * observed in a test with a fake, never by sniffing the user agent.
 */
export type AudioContextFactory = (options?: ContextOptions) => AudioContext;

export type PlayoutContextChoice = {
  /** The context to build the mic source and the playout on. */
  ctx: AudioContext;
  /** The rate this context actually renders at: the worklet's device rate. */
  rate: number;
  /** True when `rate` is the stream rate, so no source sample is dropped. */
  atStreamRate: boolean;
  /** How the context was obtained: the preference, or the device default. */
  source: "stream" | "device";
};

/**
 * A probe that must succeed before a preferred context is accepted. It throws
 * when the context cannot host the caller's graph — in this app, when the
 * microphone cannot be attached to it. A rate the platform reports but cannot
 * wire a `MediaStreamAudioSourceNode` into (Firefox across rates) is not
 * support, and must not be mistaken for it.
 */
export type ContextProbe = (ctx: AudioContext) => void;

/**
 * Open the shared context at `streamRate` when the platform honours it, or at
 * its default device rate otherwise.
 *
 * The preferred context is kept only if it reports exactly the requested rate
 * and passes `usable`. A context that fails either is closed: playing on it
 * would silently change what the worklet believes about the resampling step,
 * and a context the microphone cannot join would trade a filter for silence.
 * The fallback default is *not* guarded — if the platform cannot open a context
 * at all, the call cannot start and the caller must see that failure rather
 * than a silent stream.
 */
export function openStreamRateContext(
  streamRate: number,
  create: AudioContextFactory = (options) => new AudioContext(options),
  usable?: ContextProbe,
): PlayoutContextChoice {
  if (!Number.isFinite(streamRate) || streamRate <= 0) {
    throw new RangeError(`A stream rate must be a positive number of Hz, got ${streamRate}.`);
  }

  let preferred: AudioContext | null = null;
  try {
    preferred = create({ sampleRate: streamRate });
  } catch {
    // Safari refuses the option outright. The preference is lost, not the call.
    preferred = null;
  }
  if (preferred && preferred.sampleRate === streamRate) {
    let accepted = true;
    try {
      usable?.(preferred);
    } catch {
      // The rate is there but the graph cannot live on it: not support.
      accepted = false;
    }
    if (accepted) {
      return {
        ctx: preferred,
        rate: streamRate,
        atStreamRate: true,
        source: "stream",
      };
    }
  }
  if (preferred) {
    // A context that ignored the request must not survive: it would sound at a
    // rate the playout never asked for. Closing it also releases the device it
    // may have claimed before the fallback opens the real one.
    try {
      void preferred.close().catch(() => undefined);
    } catch {
      // Already closing, or a context that never opened: nothing to release.
    }
  }

  const ctx = create();
  return {
    ctx,
    rate: ctx.sampleRate,
    atStreamRate: ctx.sampleRate === streamRate,
    source: "device",
  };
}
