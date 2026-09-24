/**
 * Mic capture worklet for the Voice Agent API.
 *
 * Lives in /public because AudioWorklet modules load from a URL, not a bundle.
 *
 * It resamples to 24 kHz here rather than forcing `new AudioContext({ sampleRate:
 * 24000 })`, which is the shortcut AssemblyAI's quickstart uses. That shortcut is
 * Chromium-only and fails *silently* on the other two engines:
 *
 *   - Firefox honours the rate but runs a non-default-rate context in a separate
 *     audio graph, and only the default graph feeds its echo canceller. The
 *     agent's own playback is then re-captured by the mic, so it transcribes
 *     itself as user speech and interrupts every one of its own replies.
 *   - Safari ignores the option outright and runs at the hardware rate (usually
 *     48 kHz). Those samples sent as if they were 24 kHz play back chipmunked.
 *
 * Letting the context keep its native rate and converting here works on all
 * three. Linear interpolation is good enough for speech. The read position and
 * the block's last sample carry over between 128-frame quanta, so a 44.1 kHz
 * device (non-integer ratio) neither drops nor repeats samples at the joins.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputSampleRate, targetSampleRate } = options.processorOptions;
    this.ratio = inputSampleRate / targetSampleRate;
    // Read position relative to the current block; -1 <= pos means "between
    // the previous block's last sample (`last`) and this block's first".
    this.pos = 0;
    this.last = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    const n = input.length;
    const pcm16 = new Int16Array(Math.ceil((n + 1) / this.ratio) + 1);
    let out = 0;
    let t = this.pos;
    while (t <= n - 1) {
      const i = Math.floor(t);
      const frac = t - i;
      const a = i < 0 ? this.last : input[i];
      const b = i + 1 < n ? input[i + 1] : a;
      const sample = a + (b - a) * frac;
      // Clamp before rounding: Float32 mic data can exceed [-1, 1] on loud
      // input, and wrapping an out-of-range value produces a loud click.
      pcm16[out++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      t += this.ratio;
    }
    this.pos = t - n;
    this.last = input[n - 1];
    const frame = pcm16.slice(0, out);
    // Transferred, not copied — this runs on every 128-sample render quantum.
    this.port.postMessage(frame.buffer, [frame.buffer]);
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
