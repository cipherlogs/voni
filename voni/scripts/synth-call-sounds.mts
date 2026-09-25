/**
 * Call sound generator: plain DSP math → mp3s for public/sounds/<variant>/.
 *
 *   node --import tsx scripts/synth-call-sounds.mts [--out dir]
 *     renders all A/B/C candidates + an audition page (call-sounds-lab.html)
 *   node --import tsx scripts/synth-call-sounds.mts --pick ringback=a,connected=b,...
 *     writes the picked variants to public/sounds/default/
 *
 * Needs `lame` and `ffmpeg` on PATH. Everything sits in A-major pentatonic so
 * any mix of picks still sounds like one family.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nextVelocity, scheduleTicks, strikeTick, TICK_FEEL } from "../src/lib/voice/call-sounds";

const SR = 48_000;
const N = {
  A2: 110, E3: 164.81, A3: 220, B3: 246.94, Cs4: 277.18, E4: 329.63, A4: 440, B4: 493.88,
  C5: 523.25, Cs5: 554.37, E5: 659.26, A5: 880, E6: 1318.51,
};

// ---------- DSP ----------

type Partial = [mult: number, gain: number, decayScale: number];
type ToneOpts = {
  dur: number;
  amp?: number;
  attack?: number;
  tau?: number; // exponential decay time constant (s); Infinity = sustain
  release?: number; // linear fade at the end of `dur`
  partials?: Partial[];
  glide?: number; // pitch ratio reached at the end of `dur` (1 = none)
  env?: (t: number) => number; // replaces attack/decay when given
};

const SINE: Partial[] = [[1, 1, 1]];
const BELL: Partial[] = [[1, 1, 1], [2, 0.28, 0.45], [3, 0.1, 0.3], [4.2, 0.04, 0.2]];
const WOOD: Partial[] = [[1, 1, 1], [4, 0.22, 0.18], [9.8, 0.05, 0.08]];
const WARM: Partial[] = [[1, 1, 1], [2, 0.35, 0.6], [3, 0.12, 0.4]];

const seconds = (s: number) => new Float32Array(Math.round(s * SR));

function tone(out: Float32Array, at: number, freq: number, o: ToneOpts): void {
  const { dur, amp = 1, attack = 0.004, tau = 0.2, release = 0.01, glide = 1 } = o;
  const start = Math.round(at * SR);
  const n = Math.min(Math.round(dur * SR), out.length - start);
  for (const [mult, gain, decayScale] of o.partials ?? SINE) {
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = freq * mult * glide ** (t / dur);
      phase += (2 * Math.PI * f) / SR;
      let e: number;
      if (o.env) e = o.env(t);
      else {
        const a = t < attack ? Math.sin((Math.PI / 2) * (t / attack)) ** 2 : 1;
        e = a * Math.exp(-t / (tau * decayScale));
      }
      const tail = dur - t;
      if (tail < release) e *= tail / release;
      out[start + i] += amp * gain * e * Math.sin(phase);
    }
  }
}

/** One-pole lowpass (or highpass), in place. */
function onePole(b: Float32Array, cutoff: number, high = false): Float32Array {
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
  let y = 0;
  for (let i = 0; i < b.length; i++) {
    y += k * (b[i] - y);
    b[i] = high ? b[i] - y : y;
  }
  return b;
}

/** Small damped-comb room: gives notes air without a wash. */
function room(b: Float32Array, wet = 0.16): Float32Array {
  const dry = Float32Array.from(b);
  const sum = new Float32Array(b.length);
  for (const d of [0.0297, 0.0371, 0.0411, 0.0437]) {
    const D = Math.round(d * SR);
    const line = new Float32Array(b.length);
    let lp = 0;
    for (let i = 0; i < b.length; i++) {
      const fb = i >= D ? line[i - D] : 0;
      lp += 0.35 * (fb - lp);
      line[i] = dry[i] + 0.55 * lp;
      sum[i] += line[i];
    }
  }
  for (let i = 0; i < b.length; i++) b[i] = dry[i] + (wet / 4) * sum[i];
  return b;
}

function finish(b: Float32Array, peakDb: number): Float32Array {
  const fade = Math.round(0.005 * SR);
  for (let i = 0; i < fade; i++) b[b.length - 1 - i] *= i / fade;
  let peak = 0;
  for (const v of b) peak = Math.max(peak, Math.abs(v));
  const g = 10 ** (peakDb / 20) / (peak || 1);
  for (let i = 0; i < b.length; i++) b[i] *= g;
  return b;
}

// ---------- The sounds ----------

type SoundName = "ringback" | "connected" | "hangup" | "error";
type Variant = { label: string; note: string; render: () => Float32Array };

const LEAD = 0.06; // ringback starts after silence so mp3 padding lands in it

const SOUNDS: Record<SoundName, { when: string; spec: string; maxSec: number; minSec?: number; variants: Record<"a" | "b" | "c", Variant> }> = {
  ringback: {
    when: "Loops while the call connects",
    spec: "3.0 s loop",
    minSec: 2,
    maxSec: 4,
    variants: {
      a: {
        label: "Classic",
        note: "The familiar 440 + 480 Hz double ring, rounded at the edges and kept low.",
        render: () => {
          const b = seconds(3);
          for (const at of [LEAD, LEAD + 0.6])
            for (const f of [440, 480])
              tone(b, at, f, { dur: 0.4, tau: Infinity, attack: 0.03, release: 0.06, amp: 0.5 });
          return finish(onePole(b, 1800), -3);
        },
      },
      b: {
        label: "Two bells",
        note: "E5 then C♯5 as soft bells: a tonal ring that reads as “calling” without the phone buzz.",
        render: () => {
          const b = seconds(3);
          tone(b, LEAD, N.E5, { dur: 1.6, tau: 0.32, partials: BELL, release: 0.4 });
          tone(b, LEAD + 0.28, N.Cs5, { dur: 1.6, tau: 0.38, partials: BELL, release: 0.4, amp: 0.85 });
          return finish(room(b), -3);
        },
      },
      c: {
        label: "Breath",
        note: "One slow A4 swell with a faint fifth and a gentle shimmer. The quietest option.",
        render: () => {
          const b = seconds(3);
          const len = 1.6;
          const env = (t: number) => Math.sin((Math.PI * t) / len) ** 2 * (1 - 0.12 * Math.sin(2 * Math.PI * 5 * t) ** 2);
          tone(b, LEAD, N.A4, { dur: len, env, release: 0.001 });
          tone(b, LEAD, N.E5, { dur: len, env, release: 0.001, amp: 0.25 });
          return finish(b, -3);
        },
      },
    },
  },
  connected: {
    when: "Plays once when the agent answers",
    spec: "≤ 0.8 s",
    maxSec: 0.8,
    variants: {
      a: {
        label: "Pure rise",
        note: "E5 to A5 in plain sines. Clean and neutral, like a system confirm.",
        render: () => {
          const b = seconds(0.5);
          tone(b, 0, N.E5, { dur: 0.3, tau: 0.1 });
          tone(b, 0.11, N.A5, { dur: 0.38, tau: 0.13 });
          return finish(b, -3);
        },
      },
      b: {
        label: "Glass fifth",
        note: "A5 up to E6 as glass bells with a little air. The brightest.",
        render: () => {
          const b = seconds(0.72);
          tone(b, 0, N.A5, { dur: 0.5, tau: 0.14, partials: BELL });
          tone(b, 0.1, N.E6, { dur: 0.55, tau: 0.16, partials: BELL, amp: 0.8 });
          return finish(room(b), -3);
        },
      },
      c: {
        label: "Wood note",
        note: "A single warm marimba C♯5 with a short room tail. Understated.",
        render: () => {
          const b = seconds(0.6);
          tone(b, 0, N.Cs5, { dur: 0.55, tau: 0.16, partials: WOOD, attack: 0.002 });
          return finish(room(b, 0.22), -3);
        },
      },
    },
  },
  // Same muted WARM timbre + 1.4 kHz lowpass as error A, but a falling
  // consonant gesture that lands on the tonic (A3): error repeats and stays
  // unresolved, hangup resolves. Softer attack than error so it never clicks
  // on the hundredth hearing.
  hangup: {
    when: "Plays when either side ends the call",
    spec: "≤ 0.8 s",
    maxSec: 0.8,
    variants: {
      a: {
        label: "Low fall",
        note: "E4 falling a fourth to A3, muted like the error taps. Lands home.",
        render: () => {
          const b = seconds(0.65);
          tone(b, 0, N.E4, { dur: 0.28, tau: 0.08, partials: WARM, attack: 0.008, amp: 0.85 });
          tone(b, 0.15, N.A3, { dur: 0.48, tau: 0.15, partials: WARM, attack: 0.008 });
          return finish(onePole(b, 1400), -3);
        },
      },
      b: {
        label: "Soft third",
        note: "C♯4 easing down to A3 with a little air. The warmest of the three.",
        render: () => {
          const b = seconds(0.72);
          tone(b, 0, N.Cs4, { dur: 0.3, tau: 0.09, partials: WARM, attack: 0.012, amp: 0.8 });
          tone(b, 0.17, N.A3, { dur: 0.5, tau: 0.16, partials: WARM, attack: 0.012 });
          return finish(room(onePole(b, 1300), 0.12), -3);
        },
      },
      c: {
        label: "Settle",
        note: "One low A3 that sinks a touch as it fades. The lightest on repeat.",
        render: () => {
          const b = seconds(0.55);
          tone(b, 0, N.A3, { dur: 0.52, tau: 0.14, partials: WARM, attack: 0.01, glide: 0.97 });
          return finish(onePole(b, 1200), -3);
        },
      },
    },
  },
  error: {
    when: "Failure, dropped call or rate-limit block",
    spec: "≤ 1.0 s",
    maxSec: 1,
    variants: {
      a: {
        label: "Double tap",
        note: "Two muted B3 taps: “that didn't go through”, without alarm.",
        render: () => {
          const b = seconds(0.55);
          for (const at of [0, 0.17]) tone(b, at, N.B3, { dur: 0.3, tau: 0.07, partials: WARM, attack: 0.003 });
          return finish(onePole(b, 1400), -3);
        },
      },
      b: {
        label: "Half-step down",
        note: "C5 slipping to B4, a minor second. Clearly off, still polite.",
        render: () => {
          const b = seconds(0.7);
          tone(b, 0, N.C5, { dur: 0.3, tau: 0.12, partials: WARM, amp: 0.85 });
          tone(b, 0.18, N.B4, { dur: 0.5, tau: 0.18, partials: WARM });
          return finish(onePole(b, 2200), -3);
        },
      },
      c: {
        label: "Dull thud",
        note: "One low tone that sags slightly in pitch. The most distinct from hang-up.",
        render: () => {
          const b = seconds(0.55);
          tone(b, 0, N.E3, { dur: 0.5, tau: 0.13, partials: [[1, 1, 1], [2, 0.6, 0.7], [3, 0.3, 0.5]], glide: 0.9, attack: 0.003 });
          return finish(onePole(b, 1100), -3);
        },
      },
    },
  },
};

// ---------- Encode + measure ----------

function wav(samples: Float32Array): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return out;
}

function encode(samples: Float32Array, mp3Path: string): Buffer {
  const wavPath = `${mp3Path}.wav`;
  writeFileSync(wavPath, wav(samples));
  execFileSync("lame", ["--silent", "-V4", "-m", "m", "--resample", "48", wavPath, mp3Path]);
  rmSync(wavPath);
  return readFileSync(mp3Path);
}

/** Integrated loudness + true peak via ffmpeg's EBU R128 meter (stderr). */
function measure(mp3Path: string, mp3: Buffer) {
  const log = spawnSync("ffmpeg", ["-nostats", "-i", mp3Path, "-af", "ebur128=peak=true", "-f", "null", "-"]).stderr.toString();
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const i = summary.match(/I:\s+(-?[\d.]+) LUFS/);
  const p = summary.match(/Peak:\s+(-?[\d.]+) dBFS/);
  return { lufs: i ? Number(i[1]) : null, peak: p ? Number(p[1]) : null, bytes: mp3.length, mp3 };
}

/**
 * Encode, then level-match to TARGET_LUFS (README: roughly −14, so earcons
 * * sit under speech) without letting the peak pass −1 dBFS.
 */
const TARGET_LUFS = -14;
function render(name: SoundName, samples: Float32Array, path: string) {
  let m = measure(path, encode(samples, path));
  if (m.lufs !== null && m.lufs > -60) {
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
    const gain = Math.min(10 ** ((TARGET_LUFS - m.lufs) / 20), 10 ** (-1 / 20) / peak);
    for (let i = 0; i < samples.length; i++) samples[i] *= gain;
    m = measure(path, encode(samples, path));
  }
  check(name, samples, m.bytes);
  return m;
}

function check(name: SoundName, samples: Float32Array, bytes: number): void {
  const spec = SOUNDS[name];
  const sec = samples.length / SR;
  if (bytes >= 100_000) throw new Error(`${name}: ${bytes} bytes (limit 100KB)`);
  if (sec > spec.maxSec || sec < (spec.minSec ?? 0)) throw new Error(`${name}: ${sec}s outside spec`);
  if (name === "ringback") {
    const edge = Math.round(0.05 * SR);
    const loud = (a: Float32Array) => a.some((v) => Math.abs(v) > 1e-3);
    if (loud(samples.subarray(0, edge)) || loud(samples.subarray(-edge)))
      throw new Error("ringback: first/last 50ms must be silent for a seamless loop");
  }
}

/** Peak envelope for the audition page's waveform. */
function outline(samples: Float32Array, buckets = 96): number[] {
  const size = Math.ceil(samples.length / buckets);
  return Array.from({ length: buckets }, (_, k) => {
    let m = 0;
    for (let i = k * size; i < Math.min(samples.length, (k + 1) * size); i++) m = Math.max(m, Math.abs(samples[i]));
    return Math.round(m * 1000) / 1000;
  });
}

// ---------- CLI ----------

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const names = Object.keys(SOUNDS) as SoundName[];
const pick = flag("--pick");

if (pick) {
  const dir = resolve(import.meta.dirname, "../public/sounds/default");
  mkdirSync(dir, { recursive: true });
  const chosen = Object.fromEntries(pick.split(",").map((kv) => kv.split("=")));
  for (const name of names) {
    const key = chosen[name] as "a" | "b" | "c" | undefined;
    if (!key) continue; // unpicked = no file = silence (see README)
    const v = SOUNDS[name].variants[key];
    if (!v) throw new Error(`${name}=${key}: no such variant`);
    const samples = v.render();
    const path = join(dir, `${name}.mp3`);
    const m = render(name, samples, path);
    console.log(`${name} = ${key} (${v.label})  ${(samples.length / SR).toFixed(2)}s  ${(m.bytes / 1024).toFixed(1)}KB  ${m.lufs} LUFS  peak ${m.peak} dBFS`);
  }
} else {
  const out = resolve(flag("--out") ?? join(tmpdir(), "call-sounds-lab"));
  mkdirSync(out, { recursive: true });
  const data = names.map((name) => ({
    name,
    when: SOUNDS[name].when,
    spec: SOUNDS[name].spec,
    variants: (["a", "b", "c"] as const).map((key) => {
      const v = SOUNDS[name].variants[key];
      const samples = v.render();
      const path = join(out, `${name}-${key}.mp3`);
      const m = render(name, samples, path);
      const mp3 = m.mp3;
      console.log(`${name}-${key} ${v.label.padEnd(15)} ${(samples.length / SR).toFixed(2)}s  ${(mp3.length / 1024).toFixed(1)}KB  ${m.lufs} LUFS  peak ${m.peak} dBFS`);
      return {
        key, label: v.label, note: v.note, sec: samples.length / SR, kb: mp3.length / 1024, lufs: m.lufs,
        wave: outline(samples), src: `data:audio/mpeg;base64,${mp3.toString("base64")}`,
      };
    }),
  }));
  const template = readFileSync(resolve(import.meta.dirname, "call-sounds-lab.html"), "utf8");
  // The caption tick is synthesized live: embed the shipped functions'
  // source so the page plays exactly what the app plays.
  const tick = [nextVelocity, strikeTick, scheduleTicks].map(String).join("\n");
  const page = template
    .replace("/*DATA*/null", JSON.stringify(data))
    .replace("/*TICK_FEEL*/null", JSON.stringify(TICK_FEEL))
    .replace("/*TICK*/", () => tick);
  writeFileSync(join(out, "call-sounds-lab.html"), page);
  console.log(`\n${join(out, "call-sounds-lab.html")}`);
}
