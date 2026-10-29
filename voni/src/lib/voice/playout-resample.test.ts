/**
 * The playout's device-rate decimation filter (ticket 34).
 *
 * The platform streams 24 kHz. When the output device runs below that — a
 * Bluetooth headset in headset mode (16 kHz), a phone or desktop route at
 * 16 kHz, telephony at 8 kHz — the resampler has to drop source samples. With
 * no low-pass before the drop, everything above the device Nyquist folds back
 * into the speech band: a 10 kHz tone becomes 6 kHz at the level it went in,
 * and the top of the voice becomes a mirror of itself.
 *
 * The seam is the one tickets 25–29 established: the real
 * `public/playout-processor.js` runs in a `vm` with the
 * AudioWorkletGlobalScope pieces it uses stubbed. What is asserted is the
 * spectrum of the delivered stream — the alias amplitude is measured with a
 * windowed DFT read at the folded frequency, never inferred from a comment —
 * and the device-rate path's passband and the untouched equal-rate path.
 *
 * The gate can fail: `withoutFilter()` is the same worklet with the decimator
 * removed (and an anchor that has moved is an error, never a silent pass), and
 * the alias must come back at full level.
 *
 * Stated numbers:
 *
 *   device rate        alias tone   folds to   passband ripple      alias after
 *   -----------        ----------   --------   ---------------      -----------
 *   16 kHz (headset)   10 kHz       6 kHz      ≤ 0.5 dB to 3 kHz    ≤ -55 dBFS
 *   8 kHz (telephony)  6 kHz        2 kHz      ≤ 1.0 dB to 3 kHz    ≤ -55 dBFS
 *
 * Run from `voni/`, because the worklet is read from `public/`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

type Port = { onmessage: ((e: { data: unknown }) => void) | null; posted: unknown[] };
type Processor = {
  port: Port;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};
type Arrival = [number, Float32Array];

const SRC = 24000;
const QUANTUM = 128;
const AMP = 0.5;
/** The platform streams 10 ms chunks in real time; the cushion then holds. */
const CHUNK_S = 0.01;
/**
 * The reply starts after the target cushion, so the first 0.5 s is silent and
 * the 5 ms start ramp is over well before the measurement window opens.
 */
const MEASURE_FROM_S = 0.55;
const MEASURE_S = 1;
const WORKLET = "public/playout-processor.js";

/**
 * The alias gate: a tone folded into the speech band may not exceed this. The
 * decimator's stated stopband is 60 dB, and the tone enters at -6 dBFS, so
 * -55 dBFS leaves margin for the measurement and the linear interpolator's
 * own images while still being far below anything a listener could hear
 * (16-bit noise is at -96 dBFS; speech-band masking is well above -55).
 */
const MAX_ALIAS_DBFS = -55;
/**
 * Passband ripple: the decimator's contribution may not move a tone below the
 * device Nyquist by more than this. It is the filter's own requirement; the
 * linear interpolator's droop at the very top of the band is the resampler's
 * existing behaviour, and is compared separately (see the passband test).
 */
const MAX_RIPPLE_DB = 0.5;
/** A Bluetooth headset in headset mode: 24 kHz in, 16 kHz out. */
const HEADSET_RATE = 16000;
/** Telephony and some phone routes: 24 kHz in, 8 kHz out. */
const PHONE_RATE = 8000;

function load(sampleRate: number, source = readFileSync(WORKLET, "utf8")) {
  const scope = {
    sampleRate,
    currentTime: 0,
    AudioWorkletProcessor: class {
      port: Port & { postMessage: (m: unknown) => void } = {
        onmessage: null,
        posted: [],
        postMessage(this: Port & { postMessage: (m: unknown) => void }, m: unknown) {
          this.posted.push(m);
        },
      } as Port & { postMessage: (m: unknown) => void };
    },
    registered: null as null | (new (o?: unknown) => Processor),
    registerProcessor(_name: string, ctor: new (o?: unknown) => Processor) {
      scope.registered = ctor;
    },
  };
  vm.runInNewContext(source, scope);
  return { proc: new scope.registered!(), scope };
}

/** A continuous tone at `hz`, 10 ms chunks, arriving in real time. */
function toneTrace(hz: number, seconds: number): Arrival[] {
  const n = Math.round(CHUNK_S * SRC);
  const arrivals: Arrival[] = [];
  for (let pos = 0; pos < Math.round(seconds * SRC); pos += n) {
    const chunk = new Float32Array(n);
    for (let i = 0; i < n; i++) chunk[i] = AMP * Math.sin((2 * Math.PI * hz * (pos + i)) / SRC);
    arrivals.push([pos / SRC, chunk]);
  }
  return arrivals;
}

/** Drive the real worklet at `deviceRate`; returns every delivered sample. */
function render(deviceRate: number, arrivals: Arrival[], seconds: number, source?: string) {
  const { proc, scope } = load(deviceRate, source);
  const out = new Float32Array(Math.ceil((seconds * deviceRate) / QUANTUM) * QUANTUM);
  let seq = 0;
  let next = 0;
  for (let q = 0; q * QUANTUM < out.length; q++) {
    scope.currentTime = (q * QUANTUM) / deviceRate;
    while (next < arrivals.length && arrivals[next]![0] <= scope.currentTime) {
      proc.port.onmessage!({ data: { type: "play", seq: ++seq, rate: SRC, samples: arrivals[next]![1] } });
      next++;
    }
    const buf = new Float32Array(QUANTUM);
    proc.process([], [[buf]]);
    out.set(buf, q * QUANTUM);
  }
  return out;
}

/**
 * Amplitude of a tone at `hz` in `samples`, Hann-windowed. One second at the
 * device rate is 1 Hz resolution, so a folded 6 kHz alias and the 10 kHz tone
 * that produced it are separate bins, not a hand-wave. The absolute phase does
 * not matter, only the amplitude.
 */
function toneAmplitude(samples: Float32Array, from: number, count: number, hz: number, rate: number) {
  let re = 0;
  let im = 0;
  let weight = 0;
  for (let i = 0; i < count; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1));
    const phase = (2 * Math.PI * hz * i) / rate;
    const y = samples[from + i]!;
    re += y * w * Math.cos(phase);
    im -= y * w * Math.sin(phase);
    weight += w;
  }
  return (2 * Math.sqrt(re * re + im * im)) / weight;
}

/** The measured band the listener hears, after the cushion and the start ramp. */
function measure(samples: Float32Array, hz: number, rate: number) {
  const from = Math.round(MEASURE_FROM_S * rate);
  return toneAmplitude(samples, from, Math.round(MEASURE_S * rate), hz, rate);
}

const db = (amplitude: number) => 20 * Math.log10(amplitude);

/** Replace one fragment of the worklet source; a moved anchor is an error. */
function mutate(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  assert.ok(at >= 0, `the mutation anchor \`${from.trim()}\` is no longer in ${WORKLET}`);
  assert.equal(
    source.indexOf(from, at + 1),
    -1,
    `the mutation anchor \`${from.trim()}\` appears more than once in ${WORKLET}`,
  );
  return source.slice(0, at) + to + source.slice(at + from.length);
}

/** The real worklet with the device-rate decimator removed: the red case. */
function withoutFilter(): string {
  return mutate(
    readFileSync(WORKLET, "utf8"),
    "return this.decimator ? this.filterSample(raw) : raw;",
    "return raw;",
  );
}

/**
 * The alias gate. The measured alias must stay under MAX_ALIAS_DBFS; the
 * failure names the folded frequency and the level, so the next reader does
 * not have to re-measure to know what the device-rate path is doing.
 */
function assertAliasRejected(
  samples: Float32Array,
  rate: number,
  aliasHz: number,
  label: string,
): number {
  const alias = db(measure(samples, aliasHz, rate));
  assert.ok(
    alias <= MAX_ALIAS_DBFS,
    `${label}: a ${aliasHz} Hz alias measures ${alias.toFixed(1)} dBFS ` +
      `(gate ≤ ${MAX_ALIAS_DBFS} dBFS) — the device-rate path dropped samples without a low-pass`,
  );
  return alias;
}

// --- A Bluetooth-headset-like device rate, below 24 kHz ---------------------

test("resampling: a 10 kHz tone above a 16 kHz device's Nyquist does not fold to 6 kHz", () => {
  // 10 kHz is 2 kHz above the 16 kHz route's 8 kHz Nyquist. Sampled at 16 kHz
  // it lands at 6 kHz, inside the speech band, where the caller hears it as a
  // whistle the voice never contained.
  const filtered = render(HEADSET_RATE, toneTrace(10000, 2), 3);
  const alias = assertAliasRejected(filtered, HEADSET_RATE, 6000, "headset");

  // The tone itself is gone, not merely moved: nothing is left at 10 kHz in a
  // 16 kHz stream (it cannot exist), so the check is on its selected alias.
  const residue = db(measure(filtered, 10000, HEADSET_RATE));
  console.log(
    `headset: 10 kHz in, alias at 6 kHz ${alias.toFixed(1)} dBFS, ` +
      `residue at 10 kHz ${residue.toFixed(1)} dBFS`,
  );
  assert.ok(alias < -55, "the alias is inside the gate");
});

test("resampling: the 16 kHz device passband is preserved within 0.5 dB", () => {
  // A 1 kHz tone is a fifth of the way to the 8 kHz Nyquist: every speech band
  // has it, and the filter may not thin it. Compare the delivered amplitude to
  // the source amplitude (0.5, -6.02 dBFS) and to the unfiltered resampler.
  const filtered = render(HEADSET_RATE, toneTrace(1000, 2), 3);
  const plain = render(HEADSET_RATE, toneTrace(1000, 2), 3, withoutFilter());
  const level = db(measure(filtered, 1000, HEADSET_RATE));
  const unfilteredLevel = db(measure(plain, 1000, HEADSET_RATE));
  const sourceLevel = db(AMP);
  console.log(
    `headset: 1 kHz delivered ${level.toFixed(2)} dBFS (source ${sourceLevel.toFixed(2)}, ` +
      `unfiltered ${unfilteredLevel.toFixed(2)})`,
  );
  assert.ok(
    Math.abs(level - sourceLevel) <= MAX_RIPPLE_DB,
    `1 kHz delivered ${level.toFixed(2)} dBFS, ${(level - sourceLevel).toFixed(2)} dB from the source`,
  );
  assert.ok(
    Math.abs(level - unfilteredLevel) <= MAX_RIPPLE_DB,
    `the decimator moved 1 kHz by ${(level - unfilteredLevel).toFixed(2)} dB`,
  );
});

test("resampling: the 16 kHz device passband to 3 kHz is preserved within 0.5 dB", () => {
  // 3 kHz is the top of the intelligibility band on a 16 kHz route. The
  // linear interpolator droops slightly here in both runs; the filter's own
  // contribution is the difference between them, and it may not add ripple.
  for (const hz of [500, 3000]) {
    const filtered = render(HEADSET_RATE, toneTrace(hz, 2), 3);
    const plain = render(HEADSET_RATE, toneTrace(hz, 2), 3, withoutFilter());
    const level = db(measure(filtered, hz, HEADSET_RATE));
    const unfilteredLevel = db(measure(plain, hz, HEADSET_RATE));
    assert.ok(
      Math.abs(level - unfilteredLevel) <= MAX_RIPPLE_DB,
      `${hz} Hz moved ${(level - unfilteredLevel).toFixed(2)} dB with the decimator`,
    );
    assert.ok(
      Math.abs(level - db(AMP)) <= 1,
      `${hz} Hz delivered ${level.toFixed(2)} dBFS, more than 1 dB from the source`,
    );
  }
});

test("resampling: an 8 kHz telephony route does not fold 6 kHz to 2 kHz", () => {
  // The other real device-rate path: 24 kHz in, 8 kHz out. The device Nyquist
  // is 4 kHz, so 6 kHz folds to 2 kHz — a whistle in the middle of the voice.
  const filtered = render(PHONE_RATE, toneTrace(6000, 2), 3);
  const alias = assertAliasRejected(filtered, PHONE_RATE, 2000, "telephony");
  console.log(`telephony: 6 kHz in, alias at 2 kHz ${alias.toFixed(1)} dBFS`);
  assert.ok(alias < -55, "the alias is inside the gate");
});

test("resampling: the device-rate path neither pumps at the chunk rate nor inserts holes", () => {
  // The filter is linear and time-invariant, so it cannot shape the envelope.
  // This pins that on the path it was added to: a steady tone arriving in
  // 10 ms chunks must deliver the same RMS in every 10 ms block (the defect
  // ticket 25 removed was a 10 %–21 % sawtooth at this rate), and the reply
  // must not be interrupted by silence.
  const out = render(HEADSET_RATE, toneTrace(1000, 2), 3);
  const from = Math.round(MEASURE_FROM_S * HEADSET_RATE);
  const to = from + Math.round(MEASURE_S * HEADSET_RATE);
  const block = Math.round(CHUNK_S * HEADSET_RATE);
  const rms: number[] = [];
  for (let i = from; i + block <= to; i += block) {
    let sum = 0;
    for (let j = 0; j < block; j++) sum += out[i + j]! * out[i + j]!;
    rms.push(Math.sqrt(sum / block));
  }
  const mean = rms.reduce((a, b) => a + b, 0) / rms.length;
  const depth = (Math.max(...rms) - Math.min(...rms)) / (2 * mean);
  assert.ok(depth <= 0.02, `the 10 ms envelope swings ${(depth * 100).toFixed(1)} % (gate 2 %)`);

  // No inserted hole: no 5 ms run of near-silence inside the reply.
  let silent = 0;
  for (let i = from; i < to; i++) {
    silent = Math.abs(out[i]!) < 1e-6 ? silent + 1 : 0;
    assert.ok(silent < Math.round(0.005 * HEADSET_RATE), `a hole opens at ${(i / HEADSET_RATE).toFixed(3)} s`);
  }
});

// --- The filter is only on the device-rate path ----------------------------

test("resampling: equal-rate playback is unchanged, sample for sample", () => {
  // 24 kHz in, 24 kHz out: the resampler never drops a sample, so the
  // decimator must not be in the path. The delivered stream is identical to the
  // same worklet with the decimator removed — byte for byte, not "close".
  const arrivals = toneTrace(220, 2);
  const filtered = render(SRC, arrivals, 3);
  const plain = render(SRC, arrivals, 3, withoutFilter());
  assert.deepEqual(Array.from(filtered), Array.from(plain), "equal-rate playback was filtered");
  assert.ok(
    filtered.some((y) => y !== 0),
    "the trace never sounded, so the comparison proves nothing",
  );
});

test("resampling: upsampling playback is unchanged, sample for sample", () => {
  // 24 kHz in, 48 kHz out: also no decimation. A filter here would add delay
  // and phase to the normal path, which ticket 29's tap proof and the drift
  // contract both depend on not happening.
  const arrivals = toneTrace(1000, 2);
  const filtered = render(48000, arrivals, 3);
  const plain = render(48000, arrivals, 3, withoutFilter());
  assert.deepEqual(Array.from(filtered), Array.from(plain), "upsampling playback was filtered");
});

test("resampling: at a device rate below the stream the decimator does change the output", () => {
  // The comparison above is only meaningful if the two runs can differ at all:
  // at 16 kHz the alias is audible without the filter and gone with it.
  const arrivals = toneTrace(10000, 2);
  const filtered = render(HEADSET_RATE, arrivals, 3);
  const plain = render(HEADSET_RATE, arrivals, 3, withoutFilter());
  assert.notDeepEqual(Array.from(filtered), Array.from(plain), "the device-rate path is not filtered");
});

// --- The negative control: the gate fails without the filter ---------------

test("negative control: without the decimator the alias comes back at full level", () => {
  // The gate only has meaning if the defect can make it fail. This is today's
  // worklet: sample dropping with no low-pass, the 10 kHz tone folded to 6 kHz.
  const plain = render(HEADSET_RATE, toneTrace(10000, 2), 3, withoutFilter());
  const alias = db(measure(plain, 6000, HEADSET_RATE));
  console.log(`negative control: alias at 6 kHz ${alias.toFixed(1)} dBFS`);
  assert.ok(alias > -20, `the restored defect only measures ${alias.toFixed(1)} dBFS`);
  assert.throws(
    () => assertAliasRejected(plain, HEADSET_RATE, 6000, "negative control"),
    (error: Error) => {
      assert.match(error.message, /a 6000 Hz alias measures -?[\d.]+ dBFS/);
      assert.match(error.message, /without a low-pass/);
      return true;
    },
  );
});

test("negative control: a mutation whose anchor has moved is an error, not a pass", () => {
  // The control above is only worth its runtime if the fragment it removes
  // still exists. When a fix moves the code, this is the failure that says so.
  assert.throws(
    () => mutate(readFileSync(WORKLET, "utf8"), "a line this worklet does not contain", "x"),
    /no longer in public\/playout-processor\.js/,
  );
});
