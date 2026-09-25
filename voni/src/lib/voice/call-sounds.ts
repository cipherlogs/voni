/**
 * Call sounds: telephony earcons for browser calls (demo, test, cascade).
 *
 * Files are served from `/sounds/<variant>/<state>.mp3` and played through
 * plain HTMLAudio — no WebAudio graph, no assets bundled. A missing file is
 * silence, never an error: the call works identically with no sounds
 * installed, so dropping files in is all it takes to voice the call.
 *
 * Variant is build-time (`NEXT_PUBLIC_CALL_SOUND_VARIANT`, default
 * "default"): a second folder + one env change is the whole A/B mechanism.
 *
 * The one exception is the caption tick: it is synthesized per strike
 * (tiny WebAudio graph) so repeated ticks vary like a piano key struck by
 * a hand — a file can't change its timbre per hit. `nextVelocity`,
 * `strikeTick` and `scheduleTicks` stay self-contained (no imports, no
 * closures): the audition page embeds their source verbatim.
 */

export type CallSoundState = "ringback" | "connected" | "hangup" | "error";

/** Caption-tick tuning knobs (audition: scripts/call-sounds-lab.html). */
export const TICK_FEEL = { spread: 0.45, detune: 10, bright: 1, level: 0.07, pitch: 330 };
export type TickFeel = typeof TICK_FEEL;
export type TickState = { nextFree: number; velocity: number };

/**
 * Human velocity walk: consecutive strikes are related, drift home toward
 * 0.6, and stay in [0.3, 1]. `spread` is how unsteady the hand is.
 */
export function nextVelocity(prev: number, feel: TickFeel): number {
  const step = (Math.random() * 2 - 1) * feel.spread;
  return Math.min(1, Math.max(0.3, prev + 0.3 * (0.6 - prev) + 0.7 * step));
}

/**
 * One soft wooden "thuck": a low knock whose pitch drops as it lands, plus a
 * few ms of band-passed contact noise, framed by a 160 Hz highpass and a
 * lowpass. Velocity shapes it the way a hammer does: harder is louder,
 * clickier, opens the lowpass, lands from higher and goes slightly sharp.
 */
export function strikeTick(ctx: BaseAudioContext, out: AudioNode, at: number, v: number, feel: TickFeel): void {
  const cents = (Math.random() * 2 - 1) * feel.detune + 6 * v;
  const freq = feel.pitch * 2 ** (cents / 1200);
  const tau = 0.01 + 0.006 * v;
  const peak = feel.level * (0.35 + 0.65 * v ** 1.5);

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 160;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1200 + 2400 * v * feel.bright;
  lp.Q.value = 0.5;
  hp.connect(lp).connect(out);

  // Body (the "thu-"): pitch falls onto the note in 12ms.
  const osc = ctx.createOscillator();
  const body = ctx.createGain();
  osc.frequency.setValueAtTime(freq * (1.4 + 0.4 * v), at);
  osc.frequency.exponentialRampToValueAtTime(freq, at + 0.012);
  body.gain.setValueAtTime(0, at);
  body.gain.linearRampToValueAtTime(peak, at + 0.002);
  body.gain.setTargetAtTime(0, at + 0.002, tau);
  osc.connect(body).connect(hp);
  osc.start(at);
  osc.stop(at + tau * 8);

  // Contact (the "-ck"): 12ms of decaying noise, brighter and louder on hard hits.
  const n = Math.ceil(ctx.sampleRate * 0.012);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.002));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 900 + 900 * v;
  bp.Q.value = 1.2;
  const click = ctx.createGain();
  click.gain.value = peak * (0.2 + 0.5 * v * feel.bright);
  src.connect(bp).connect(click).connect(hp);
  src.start(at);
}

/**
 * Strike once per new word (max 3 per burst), 45–75ms apart. A backlog over
 * 300ms drops strikes instead of machine-gunning a caption that lands whole.
 * `v` forces the velocity (the firm yield tick).
 */
export function scheduleTicks(
  ctx: BaseAudioContext,
  out: AudioNode,
  state: TickState,
  words: number,
  feel: TickFeel,
  v?: number,
): void {
  const now = ctx.currentTime;
  for (let i = 0; i < Math.min(words, 3); i++) {
    const at = Math.max(now, state.nextFree);
    if (at - now > 0.3) return;
    state.velocity = v ?? nextVelocity(state.velocity, feel);
    strikeTick(ctx, out, at, state.velocity, feel);
    state.nextFree = at + 0.045 + Math.random() * 0.03;
  }
}

const VARIANT =
  process.env.NEXT_PUBLIC_CALL_SOUND_VARIANT ?? "default";

/** Best-effort support check: no Audio, no sounds, no crash (SSR/workers). */
function audioAvailable(): boolean {
  return typeof Audio !== "undefined";
}

export class CallSounds {
  private ringback: HTMLAudioElement | null = null;
  private missing = new Set<string>();
  private ctx: AudioContext | null = null;
  private tickState: TickState = { nextFree: 0, velocity: 0.6 };

  private url(state: CallSoundState): string {
    return `/sounds/${VARIANT}/${state}.mp3`;
  }

  /** Start the connecting loop. Idempotent; silent when the file is absent. */
  startRingback(): void {
    if (!audioAvailable() || this.ringback) return;
    const url = this.url("ringback");
    if (this.missing.has(url)) return;
    try {
      const el = new Audio(url);
      el.loop = true;
      el.volume = 0.25;
      el.onerror = () => {
        this.missing.add(url);
        this.stopRingback();
      };
      this.ringback = el;
      void el.play().catch(() => {
        // Autoplay policy or missing file: the call continues silently.
        this.stopRingback();
      });
    } catch {
      this.ringback = null;
    }
  }

  stopRingback(): void {
    try {
      this.ringback?.pause();
    } catch {
      // Already gone; the loop reference below still clears.
    }
    this.ringback = null;
  }

  /** One-shot earcon. Fire-and-forget; missing files stay silent. */
  play(state: Exclude<CallSoundState, "ringback">): void {
    if (!audioAvailable()) return;
    const url = this.url(state);
    if (this.missing.has(url)) return;
    try {
      const el = new Audio(url);
      el.volume = 0.4;
      el.onerror = () => this.missing.add(url);
      void el.play().catch(() => undefined);
    } catch {
      // No audio, no problem.
    }
  }

  /** Caption tick: `words` humanized strikes. No WebAudio, no tick. */
  tick(words = 1, v?: number): void {
    if (typeof AudioContext === "undefined") return;
    try {
      const ctx = (this.ctx ??= new AudioContext());
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      scheduleTicks(ctx, ctx.destination, this.tickState, words, TICK_FEEL, v);
    } catch {
      // No audio, no problem.
    }
  }

  stopAll(): void {
    this.stopRingback();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
