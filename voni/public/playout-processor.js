/**
 * Agent-voice playback worklet: one continuous output stream for every reply.
 *
 * Lives in /public because AudioWorklet modules load from a URL, not a bundle.
 *
 * It replaces one AudioBufferSourceNode per `reply.audio` chunk (AssemblyAI's
 * browser sample). That approach pops, for three reasons this file fixes:
 *
 *   - No jitter buffer. The first chunk plays at once, so a chunk that arrives
 *     a few ms late leaves a hard gap. Here a reply waits for the target
 *     cushion of audio (or the defined lull in arrivals) before it starts, and
 *     its gain never follows how much is left. The cushion itself is held by
 *     slow drift correction: a stream that arrives a hair slower than the
 *     device plays is played a hair slower, never pumped. A reply that runs
 *     dry mid-stream resumes on the next audio — a short cushion, refilled by
 *     the same corrector — instead of waiting for a fresh target.
 *   - Per-chunk resampling. Each 24 kHz buffer resampled on its own to the
 *     device rate leaves a seam at every join. Here a single linear resampler
 *     carries its phase across chunks, so the joins don't exist.
 *   - Hard edges. Starts ramp in over EDGE_S, the source running dry fades out
 *     over EDGE_S (and resumes at once if the audio returns), and `flush`
 *     fades out over the time given by the main thread. Never a fade derived
 *     from how much audio is left.
 *
 * Messages in:  {type:"play", seq, rate, samples: Float32Array}
 *               {type:"flush", fadeS, keepCushion}  a barge-in keeps the cushion
 *               deadline (see flush); a hang-up passes keepCushion:false
 *               {type:"probe", on}  dev pop recorder (see POP_*), off by default
 *               {type:"tap", on}  dev delivered capture, off by default
 * Messages out: {type:"level", seq, queuedMs, cushionMs, targetCushionMs,
 *               correctionPct, playing, idle, consumed}, posted every few
 *               quanta while sounding and once on going idle. `seq` is the last
 *               play message seen, so the main thread knows the idle report is
 *               current. `cushionMs` is the audio held ahead of the playhead —
 *               what the jitter buffer holds — and `targetCushionMs` the cushion
 *               a reply starts at. `correctionPct` is the playback-rate
 *               correction in percent: negative while it plays slower to
 *               refill the cushion, zero when the stream needs no correction.
 *               `consumed` counts source samples played or flushed since load:
 *               the main thread paces captions against it.
 *               {type:"pop", kind, size, at}  only while the probe is on:
 *               "jump" = adjacent output samples differ by more than POP_JUMP
 *               (a click the ear hears), "overload" = output beyond ±1 (the
 *               device clips it). Throttled per kind to one per POP_EVERY_S.
 *               {type:"tap", samples: Float32Array}  only while the capture is
 *               on: the output exactly as emitted, in ~100ms transferable
 *               blocks. The tap copies after rendering, so it never changes a
 *               sample. Turning it off posts the final partial block, then
 *               {type:"tap-end"} so the main thread can close a complete WAV.
 */
/**
 * The target cushion: how much audio a reply holds before it starts. This is
 * the reply's jitter budget and a named decision, not an accident of arrival
 * timing. Audio arrives in real time (measured: 10ms chunks every 10ms), so
 * this is the only cushion against a network hiccup: 80ms broke up on phones.
 * Owner call: a fixed 500ms.
 */
const TARGET_CUSHION_S = 0.5;
/**
 * Slow drift correction. The producer and the device do not share a clock: a
 * stream that arrives a little slower than it plays drains the cushion 10ms a
 * second at 1%, and nothing ever puts it back. While a reply sounds, the
 * worklet therefore plays a fraction of a percent slower (or faster) than real
 * time until the cushion is back at target.
 *
 * The corrector only ever changes the resampling step — never the gain, and
 * never the signal path — and it is slow in both senses that matter:
 *
 *   - SMOOTH: the cushion error is averaged over this window, so ordinary
 *     jitter, a burst, and the cushion draining at the end of a reply are not
 *     drift. Only a cushion that stays away from target moves the rate.
 *   - SLEW: the correction moves at most this much per second, so the pitch
 *     glides; over one level-report interval (21ms) that is a hundredth of a
 *     percent.
 *   - MAX_RATE_ADJUST: 1% of playback rate, 17 cents, under the pitch step a
 *     listener can name.
 *   - DEADBAND: cushion error the corrector ignores entirely, so a stream
 *     arriving on time is played bit for bit.
 *   - RANGE: the error beyond the deadband at which the correction reaches its
 *     ceiling — the corrector's proportional band.
 *   - QUIET: nothing arriving means the reply is ending or stalled; the
 *     cushion draining then is the boundary fade's business, not drift's.
 */
const DRIFT_SMOOTH_S = 2;
const DRIFT_SLEW_PER_S = 0.005;
const MAX_RATE_ADJUST = 0.01;
const DRIFT_DEADBAND_S = 0.04;
const DRIFT_RANGE_S = 0.36;
const DRIFT_QUIET_S = 0.1;
/**
 * The defined lull: no arrivals for this long means the stream has ended even
 * though the target was never reached, so a reply shorter than the cushion
 * still plays instead of waiting forever.
 */
const LULL_S = 0.5;
/**
 * Resume after a dry-out. A buffer running dry mid-reply is a stall, not the
 * end of the reply: the caller is owed the rest of the sentence, so the next
 * audio to arrive continues it at once, on the short cushion that audio
 * provides, and the drift corrector refills the cushion afterwards. Waiting
 * for a whole new target cushion here is the fixed half-second hole this
 * replaces.
 *
 * A gap longer than this is a new reply, not a resume: it waits for the target
 * like any reply start, so a conversation's jitter budget is not spent on a
 * stall that is really a new turn.
 */
const RESUME_WINDOW_S = 1;
/**
 * Fade at a reply boundary: the start of a reply, and the point the source
 * runs dry (a reply ending, or a stall). Never from how much is left.
 */
const EDGE_S = 0.005;
const LEVEL_EVERY_QUANTA = 8;
/** Speech at 48 kHz moves well under this between samples; a click does not. */
const POP_JUMP = 0.3;
const POP_EVERY_S = 0.02;
/** Delivered capture block: 100ms is enough to keep port traffic trivial. */
const TAP_BLOCK_S = 0.1;

class PlayoutProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.head = 0; // read offset into chunks[0]
    this.queued = 0; // source samples not yet read
    this.rate = 24000;
    this.step = this.rate / sampleRate;
    // Resampler: output = a + (b - a) * frac, between source samples a and b.
    this.a = 0;
    this.b = 0;
    this.frac = 0;
    this.playing = false;
    this.gain = 0; // 0..1 envelope: a start ramp, then constant 1 for the reply
    /** Playback-rate correction as a ratio: -0.01 plays 1% slower, 0 is exact. */
    this.adjust = 0;
    /** Smoothed cushion error in seconds: what the corrector treats as drift. */
    this.drift = 0;
    this.hold = 0; // last sample before the source ran dry, faded out over EDGE_S
    this.holdLeft = 0; // samples left in that fade-out; 0 when not fading
    /** When the source last ran dry: the window in which later audio resumes it. */
    this.dryAt = -Infinity;
    /**
     * The time by which a reply may start on the cushion a barge-in already
     * cost, instead of waiting for a fresh target. A flush drops the
     * interrupted reply's queued audio — speech the caller has already talked
     * over — but it keeps this deadline so the new reply is not charged a
     * second pre-roll. Infinity means no credit: an ordinary cold start.
     *
     * Audio that arrives inside the window still starts on the remainder of it
     * (the target is preserved, never shortened). Audio that arrives later —
     * the normal case, because the server has to end-point, judge and generate
     * — starts at once instead of waiting out an artificial half second.
     */
    this.cushionBy = Infinity;
    /** EDGE_S in output samples, and the matching per-sample gain step. */
    this.edgeSamples = Math.round(EDGE_S * sampleRate);
    this.gainStep = 1 / (EDGE_S * sampleRate);
    this.lastPush = -1;
    this.seq = 0;
    this.tail = null; // pre-rendered flush fade, mixed into the output
    this.tailAt = 0;
    this.quanta = 0;
    this.idle = true;
    this.popProbe = false;
    this.lastOut = 0;
    this.popAt = {};
    this.consumed = 0;
    this.tapOn = false;
    this.tapBuf = null;
    this.tapLen = 0;
    this.port.onmessage = (e) => this.receive(e.data);
  }

  receive(msg) {
    if (msg.type === "play") {
      if (msg.rate !== this.rate) {
        this.rate = msg.rate;
        this.step = this.rate / sampleRate;
        // A new source clock says nothing about the old drift.
        this.adjust = 0;
        this.drift = 0;
      }
      this.seq = msg.seq;
      if (msg.samples.length === 0) return;
      this.chunks.push(msg.samples);
      this.queued += msg.samples.length;
      this.lastPush = currentTime;
      this.idle = false;
    } else if (msg.type === "flush") {
      // A barge-in keeps the cushion unless the caller says otherwise (a
      // deliberate hang-up passes false).
      this.flush(msg.fadeS, msg.keepCushion !== false);
    } else if (msg.type === "probe") {
      this.popProbe = Boolean(msg.on);
    } else if (msg.type === "tap") {
      if (msg.on) this.startTap();
      else this.stopTap();
    }
  }

  /** Next source sample, or null when the buffer is empty. */
  take() {
    while (this.chunks.length && this.head >= this.chunks[0].length) {
      this.chunks.shift();
      this.head = 0;
    }
    if (!this.chunks.length) return null;
    this.queued -= 1;
    this.consumed += 1;
    return this.chunks[0][this.head++];
  }

  /** Render one output sample of the stream, or 0 when not playing. */
  next() {
    // The source ran dry (reply end, or a stall): the fade-out started at the
    // last sample and is counted in samples, never in how much audio is left.
    if (this.holdLeft > 0) {
      this.holdLeft -= 1;
      return this.hold * (this.holdLeft / this.edgeSamples);
    }
    if (!this.playing) return 0;
    // Gain: ramp in over EDGE_S when the reply starts, then constant 1. It is
    // deliberately not a function of `queued` — a buffer that sawtooths at the
    // chunk rate must not amplitude-modulate the voice.
    this.gain = Math.min(1, this.gain + this.gainStep);
    const y = (this.a + (this.b - this.a) * this.frac) * this.gain;
    // The drift correction lives only in the resampling step: the signal stays
    // continuous and the gain is untouched.
    this.frac += this.step * (1 + this.adjust);
    while (this.frac >= 1) {
      const s = this.take();
      if (s === null) {
        // Dry. Start the fade-out from the sample just emitted, and remember
        // when: audio arriving soon after this resumes the reply, not a new one.
        this.playing = false;
        this.dryAt = currentTime;
        this.hold = y;
        this.holdLeft = this.edgeSamples;
        this.a = this.b = this.frac = 0;
        break;
      }
      this.frac -= 1;
      this.a = this.b;
      this.b = s;
    }
    return y;
  }

  start() {
    const first = this.take();
    this.a = first;
    this.b = first;
    this.frac = 0;
    this.gain = 0;
    this.hold = 0;
    this.holdLeft = 0;
    this.dryAt = -Infinity;
    // The barge-in credit is spent by this start: a later reply waits for the
    // target like any reply, so a barge-in never removes the jitter budget.
    this.cushionBy = Infinity;
    // A reply starts on the target cushion, so there is nothing to correct yet.
    this.adjust = 0;
    this.drift = 0;
    this.playing = true;
  }

  /**
   * One quantum of slow drift correction, while a reply sounds. The cushion is
   * averaged first, then compared with the target; the error beyond the
   * deadband is the correction the reply wants, and it is slewed toward from
   * where it is. A short cushion plays slower to refill, a long one faster to
   * drain.
   */
  correct(dt, maxDelta) {
    const error = this.queued / this.rate - TARGET_CUSHION_S;
    this.drift += (error - this.drift) * (1 - Math.exp(-dt / DRIFT_SMOOTH_S));
    // Nothing arriving: the reply is ending or stalled, and the cushion
    // draining is the boundary fade's business, not drift's.
    if (currentTime - this.lastPush > DRIFT_QUIET_S) return;
    const slack =
      Math.abs(this.drift) <= DRIFT_DEADBAND_S
        ? 0
        : this.drift - Math.sign(this.drift) * DRIFT_DEADBAND_S;
    const want = Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, slack / DRIFT_RANGE_S));
    this.adjust += Math.max(-maxDelta, Math.min(maxDelta, want - this.adjust));
  }

  flush(fadeS, keepCushion = true) {
    // Render the fade from the audio already sounding, then drop the rest: the
    // interrupted reply is speech the caller has already talked over and must
    // never sound again. The next reply starts from a clean buffer and the tail
    // mixes over it.
    const n = Math.round(fadeS * sampleRate);
    const tail = new Float32Array(n);
    const prev = this.tail;
    for (let i = 0; i < n; i++) {
      tail[i] = this.next() * (1 - i / n);
      if (prev && this.tailAt < prev.length) tail[i] += prev[this.tailAt++] * (1 - i / n);
    }
    this.tail = tail;
    this.tailAt = 0;
    this.consumed += this.queued;
    this.chunks = [];
    this.head = 0;
    this.queued = 0;
    this.playing = false;
    this.hold = 0;
    this.holdLeft = 0;
    this.a = this.b = this.frac = 0;
    this.adjust = 0;
    this.drift = 0;
    this.dryAt = -Infinity;
    // A barge-in carries the cushion's deadline across the flush, so the new
    // reply is not charged a second pre-roll (see the constructor). A hang-up
    // keeps nothing: it holds no credit for audio that will never come.
    this.cushionBy = keepCushion ? currentTime + TARGET_CUSHION_S : Infinity;
  }

  /** Dev pop recorder: flag what the speaker is about to click on. */
  checkPop(y) {
    const jump = Math.abs(y - this.lastOut);
    this.lastOut = y;
    if (jump > POP_JUMP) this.reportPop("jump", jump);
    if (Math.abs(y) > 1) this.reportPop("overload", Math.abs(y));
  }

  reportPop(kind, size) {
    const last = this.popAt[kind];
    if (last !== undefined && currentTime - last < POP_EVERY_S) return;
    this.popAt[kind] = currentTime;
    this.port.postMessage({ type: "pop", kind, size, at: currentTime });
  }

  /** Dev delivered capture on: start a block buffer at the output rate. */
  startTap() {
    this.tapBlock = Math.max(128, Math.round(sampleRate * TAP_BLOCK_S));
    this.tapBuf = new Float32Array(this.tapBlock);
    this.tapLen = 0;
    this.tapOn = true;
  }

  /** Dev delivered capture off: flush the tail, then ack so a WAV can close. */
  stopTap() {
    this.postTap();
    this.tapOn = false;
    this.tapBuf = null;
    this.port.postMessage({ type: "tap-end" });
  }

  /**
   * Copy one quantum of already-rendered output into the current block. Reads
   * the output array only, after every sample is final: the tap cannot alter
   * what the speaker receives.
   */
  tapWrite(out) {
    for (let i = 0; i < out.length; i++) {
      if (this.tapLen === this.tapBlock) this.postTap();
      this.tapBuf[this.tapLen++] = out[i];
    }
  }

  /** Post the current block (partial or full) as a transferable buffer. */
  postTap() {
    if (!this.tapOn || this.tapLen === 0) return;
    const samples = new Float32Array(this.tapLen);
    samples.set(this.tapBuf.subarray(0, this.tapLen));
    this.tapLen = 0;
    this.port.postMessage({ type: "tap", samples }, [samples.buffer]);
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    // Start only on the target cushion, or once arrivals have paused for the
    // defined lull. A reply shorter than the cushion therefore still plays, and
    // a jitter trace never starts on less than the target. The exceptions are a
    // reply that just ran dry: audio arriving inside the resume window is the
    // rest of that reply and starts at once, on whatever short cushion arrived;
    // the corrector refills it — and a reply after a barge-in: the cushion's
    // deadline survived the flush, so once the barge-in itself has cost the
    // target the next reply starts on its first audio instead of paying for a
    // fresh pre-roll. Never start under a flush tail: tail + a loud new reply
    // summed past full scale (measured 1.49), which the device clips into a
    // crackle — the tail is ≤40ms.
    if (!this.playing && this.queued > 0 && !this.tail && this.holdLeft === 0) {
      const lull = currentTime - this.lastPush >= LULL_S;
      const resuming = currentTime - this.dryAt <= RESUME_WINDOW_S;
      const cushioned = currentTime >= this.cushionBy;
      const buffered = this.queued >= TARGET_CUSHION_S * this.rate;
      if (resuming || cushioned || buffered || lull) this.start();
    }
    const dt = out.length / sampleRate;
    if (this.playing) this.correct(dt, DRIFT_SLEW_PER_S * dt);
    for (let i = 0; i < out.length; i++) {
      let y = this.next();
      if (this.tail) {
        y += this.tail[this.tailAt++];
        if (this.tailAt >= this.tail.length) this.tail = null;
      }
      out[i] = y;
      if (this.popProbe) this.checkPop(y);
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    if (this.tapOn) this.tapWrite(out);

    const nowIdle = !this.playing && this.queued === 0 && !this.tail && this.holdLeft === 0;
    this.quanta += 1;
    if ((nowIdle && !this.idle) || (!nowIdle && this.quanta % LEVEL_EVERY_QUANTA === 0)) {
      this.port.postMessage({
        type: "level",
        seq: this.seq,
        queuedMs: (this.queued / this.rate) * 1000,
        cushionMs: (this.queued / this.rate) * 1000,
        targetCushionMs: TARGET_CUSHION_S * 1000,
        correctionPct: this.playing ? this.adjust * 100 : 0,
        playing: this.playing,
        idle: nowIdle,
        consumed: this.consumed,
      });
    }
    this.idle = nowIdle;
    return true;
  }
}

registerProcessor("playout-processor", PlayoutProcessor);
