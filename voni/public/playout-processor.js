/**
 * Agent-voice playback worklet: one continuous output stream for every reply.
 *
 * Lives in /public because AudioWorklet modules load from a URL, not a bundle.
 *
 * It replaces one AudioBufferSourceNode per `reply.audio` chunk (AssemblyAI's
 * browser sample). That approach pops, for three reasons this file fixes:
 *
 *   - No jitter buffer. The first chunk plays at once, so a chunk that arrives
 *     a few ms late leaves a hard gap. Here a reply waits for PREROLL_S of audio
 *     (or a short lull in arrivals) before it starts.
 *   - Per-chunk resampling. Each 24 kHz buffer resampled on its own to the
 *     device rate leaves a seam at every join. Here a single linear resampler
 *     carries its phase across chunks, so the joins don't exist.
 *   - Hard edges. Starts ramp in over EDGE_S, the output fades as the buffer
 *     runs dry (end of a reply, or a network stall), and `flush` fades out
 *     over the time given by the main thread.
 *
 * Messages in:  {type:"play", seq, rate, samples: Float32Array}
 *               {type:"flush", fadeS}
 *               {type:"probe", on}  dev pop recorder (see POP_*), off by default
 * Messages out: {type:"level", seq, queuedMs, idle, consumed}, posted every few quanta
 *               while sounding and once on going idle. `seq` is the last play
 *               message seen, so the main thread knows the idle report is current.
 *               `consumed` counts source samples played or flushed since load:
 *               the main thread paces captions against it.
 *               {type:"pop", kind, size, at}  only while the probe is on:
 *               "jump" = adjacent output samples differ by more than POP_JUMP
 *               (a click the ear hears), "overload" = output beyond ±1 (the
 *               device clips it). Throttled per kind to one per POP_EVERY_S.
 */
/**
 * Audio arrives in real time (measured: 10ms chunks every 10ms), so this
 * pre-roll is the only cushion against a network hiccup: 80ms broke up on
 * phones. Owner call: a fixed 500ms.
 */
const PREROLL_S = 0.5;
const EDGE_S = 0.005;
const LEVEL_EVERY_QUANTA = 8;
/** Speech at 48 kHz moves well under this between samples; a click does not. */
const POP_JUMP = 0.3;
const POP_EVERY_S = 0.02;

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
    this.gain = 0; // 0..1 envelope, rises at most one EDGE_S ramp at a time
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
    this.port.onmessage = (e) => this.receive(e.data);
  }

  receive(msg) {
    if (msg.type === "play") {
      if (msg.rate !== this.rate) {
        this.rate = msg.rate;
        this.step = this.rate / sampleRate;
      }
      this.seq = msg.seq;
      if (msg.samples.length === 0) return;
      this.chunks.push(msg.samples);
      this.queued += msg.samples.length;
      this.lastPush = currentTime;
      this.idle = false;
    } else if (msg.type === "flush") {
      this.flush(msg.fadeS);
    } else if (msg.type === "probe") {
      this.popProbe = Boolean(msg.on);
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
    if (!this.playing) return 0;
    const edge = EDGE_S * this.rate;
    // Envelope: fade over the last EDGE_S of data so running dry (reply end
    // or stall) never cuts a non-zero sample, and never rise faster than an
    // EDGE_S ramp — a late chunk landing mid-fade must not snap back to 1.
    const room = Math.max(0, (this.queued + 1 - this.frac) / edge);
    this.gain = Math.min(room, 1, this.gain + this.step / edge);
    const y = (this.a + (this.b - this.a) * this.frac) * this.gain;
    this.frac += this.step;
    while (this.frac >= 1) {
      const s = this.take();
      if (s === null) {
        // Dry. The envelope already reached 0; wait for the next pre-roll.
        this.playing = false;
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
    this.playing = true;
  }

  flush(fadeS) {
    // Render the fade from the audio already sounding, then drop the rest.
    // The next reply starts from a clean state and the tail mixes over it.
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
    this.a = this.b = this.frac = 0;
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

  process(_inputs, outputs) {
    const out = outputs[0][0];
    // Never start under a flush tail: tail + a loud new reply summed past
    // full scale (measured 1.49), which the device clips into a crackle.
    // The tail is ≤40ms, so the wait is inaudible.
    if (!this.playing && this.queued > 0 && !this.tail) {
      const lull = currentTime - this.lastPush >= PREROLL_S;
      if (this.queued >= PREROLL_S * this.rate || lull) this.start();
    }
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

    const nowIdle = !this.playing && this.queued === 0 && !this.tail;
    this.quanta += 1;
    if ((nowIdle && !this.idle) || (!nowIdle && this.quanta % LEVEL_EVERY_QUANTA === 0)) {
      this.port.postMessage({
        type: "level",
        seq: this.seq,
        queuedMs: (this.queued / this.rate) * 1000,
        idle: nowIdle,
        consumed: this.consumed,
      });
    }
    this.idle = nowIdle;
    return true;
  }
}

registerProcessor("playout-processor", PlayoutProcessor);
