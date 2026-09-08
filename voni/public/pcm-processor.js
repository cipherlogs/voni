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
 * three. Linear interpolation is good enough for speech.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputSampleRate, targetSampleRate } = options.processorOptions;
    this.ratio = inputSampleRate / targetSampleRate;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    const outLength = Math.floor(input.length / this.ratio);
    const pcm16 = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const sample = input[Math.floor(i * this.ratio)] ?? 0;
      // Clamp before rounding: Float32 mic data can exceed [-1, 1] on loud
      // input, and wrapping an out-of-range value produces a loud click.
      pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    // Transferred, not copied — this runs on every 128-sample render quantum.
    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
