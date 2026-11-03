/**
 * The key-gated real-legs check (demo-cascade ticket 22).
 *
 * The check answers the one question a fake cannot: do the real vendors, the
 * real local or deployed service, the trace artifact and the cost meter agree
 * with the app's own signed body? It is deliberately outside the pull-request
 * path (CI runs its unit tests and never invokes the command): only a real
 * deploy, a real key and a real caller can answer it.
 *
 * What this module keeps:
 *
 * - **One signing construction.** The body and the call token come from
 *   `buildDemoCascadeBody` (the mint's own builder, ticket 06) and are delivered
 *   through `deliverCallBody` (ticket 07). This file never re-implements a
 *   claim, a hash or an HMAC.
 * - **Identity only on the socket.** The first frame is the app's
 *   `buildConfigMessage` (ticket 65); the caller audio uses the app's
 *   `encodeAudioFrame`, and every down frame goes through the app's
 *   `parseServerMessage` / `decodeAudioMessage`.
 * - **No invented evidence.** A missing key skips by name. A missing trace
 *   artifact on a remote service is a named skip, never a pass. A costs row is
 *   accepted only when it is measured or states why it is not.
 *
 * The operator surface (`scripts/real-legs.mts`) owns argv, environment and
 * the printed report; everything testable lives here.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CASCADE_PROTOCOL_VERSION,
  buildConfigMessage,
  decodeAudioMessage,
  encodeAudioFrame,
  encodeContextMessage,
  parseServerMessage,
} from "../../src/lib/voice/cascade-session";
import { buildDemoCascadeBody } from "../../src/lib/demo/cascade-body";
import { deliverCallBody } from "../../src/lib/demo/pipeline-delivery";
import { getVoice } from "../../src/lib/agents/voices";
import { SCOREBOARD_BUDGETS } from "../../src/lib/demo/scoreboard-budgets";
import {
  DEMO_VOICE_IDS,
  VONI_GREETINGS,
  rungInstructions,
} from "../../src/lib/demo/voni-agent";
import BOUNDS from "../../src/lib/voice/cascade-bounds.json";

export const REAL_LEGS_COMMAND = "check:real-legs";
export const BROWSER_CALL_PATH = "/v1/browser-call";
export const EVENTS_DIR_ENV = "VOICE_PIPELINE_EVENTS_DIR";
export const BASE_URL_ENV = "VOICE_PIPELINE_SERVICE_URL";
export const APP_PIPELINE_URL_ENV = "VOICE_PIPELINE_URL";

/** The two vendor keys the service cannot open a real leg without. */
export const REQUIRED_KEYS = ["META_API_KEY", "ASSEMBLYAI_API_KEY"] as const;

/** The one named skip reason; the no-key run prints exactly this. */
export const KEY_SKIP_REASON =
  "META_API_KEY and ASSEMBLYAI_API_KEY are required for the real legs";

/** The committed caller line: German, 24 kHz mono PCM16, the `jorg` voice. */
export function defaultCallerClip(): string {
  return fileURLToPath(
    new URL("../../public/voices/cascade/jorg.wav", import.meta.url),
  );
}

/**
 * The demo voice a no-flags rehearsal measures: the roster's one English
 * voice (demo-cascade ticket 01). The harness reads the roster, never its own
 * literal. Note the pairing is gone: the only committed caller clip is still
 * the German line, so a no-flags run replays German caller audio against the
 * English agent until an English clip is committed.
 */
export const DEFAULT_VOICE: string = DEMO_VOICE_IDS[0];

/**
 * The one pricing path, named on every `cost.priced` row. Source of truth:
 * `voice-pipeline/cascade/events.py` `COST_PRODUCER`; the report cites it so a
 * reader can tell a measured price from anything else.
 */
export const COST_PRODUCER = "cascade.cost.cost_call";

/** The caller's explicit end request, per Locale used by the demo roster. */
export const HANGUP_LINES: Readonly<Record<string, string>> = Object.freeze({
  en: "Okay, that's all I needed. Please hang up now.",
  de: "Okay, das war alles. Bitte legen Sie jetzt auf.",
  es: "Vale, eso es todo. Puedes colgar ya.",
  fr: "D'accord, c'est tout. Vous pouvez raccrocher.",
  pt: "Tudo bem, é isso. Pode desligar agora.",
});

export const REAL_LEGS_USAGE = `usage: npm run ${REAL_LEGS_COMMAND} -- [options]

  --base-url URL      the pipeline's HTTP(S) base (default: VOICE_PIPELINE_URL,
                      then VOICE_PIPELINE_SERVICE_URL)
  --ws-url URL        the browser-call WebSocket URL (derived from --base-url)
  --voice ID          the demo voice and subject (default: ${DEFAULT_VOICE}, the
                      roster's English voice; the committed caller clip is
                      still the German line until an English clip ships)
  --audio PATH        a caller clip replayed for each caller turn (default:
                      the committed clip; without it, one short line is
                      synthesized with the key)
  --events-dir PATH   the service's trace directory (default:
                      ${EVENTS_DIR_ENV}, then voice-pipeline/.events)
  --timeout-ms N      per-wait bound (default: 120000)
  --with-resume       also prove the hold return (default)
  --no-resume         skip the hold-return phase
  --no-hangup         skip the caller hang-up phase
  --json              print one machine-readable report
  --help, -h          this text

Requires ${REQUIRED_KEYS.join(" and ")}; without them it prints
"skipped: ${KEY_SKIP_REASON}" and exits 0. Needs the
shared VOICE_PIPELINE_ENVELOPE_SECRET to sign the body.

Reuses the app's builder, signer and delivery client; it is never run in the
pull-request workflow.`;

// ---------------------------------------------------------------------------
// The skip decision
// ---------------------------------------------------------------------------

export type RealLegsEnvironment = Readonly<Record<string, string | undefined>>;

export type SkipDecision = { skip: false } | { skip: true; reason: string };

function present(env: RealLegsEnvironment, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The key gate. Both real vendor keys are required because the service builds
 * two vendor legs per call; one key would produce half a call and no honest
 * evidence. Whitespace is absence, exactly as the service's env reader treats
 * it.
 */
export function skipDecision(env: RealLegsEnvironment): SkipDecision {
  for (const name of REQUIRED_KEYS) {
    if (!present(env, name)) return { skip: true, reason: KEY_SKIP_REASON };
  }
  return { skip: false };
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type RealLegsOptions = {
  baseUrl?: string;
  wsUrl?: string;
  voice: string;
  audioPath?: string;
  eventsDir?: string;
  timeoutMs: number;
  /** Prove the hold return after the call's turns (default true). */
  withResume: boolean;
  /** Prove the service ends the call on the caller's request (default true). */
  withHangup: boolean;
  json: boolean;
  help: boolean;
};

const FLAGS_WITH_VALUE = new Set([
  "--base-url",
  "--ws-url",
  "--voice",
  "--audio",
  "--events-dir",
  "--timeout-ms",
]);

/** Parse the operator's flags; every malformed input is a named usage error. */
export function parseRealLegsArgs(argv: readonly string[]): RealLegsOptions {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      flags.set(flag, "");
      continue;
    }
    if (
      flag === "--with-resume" ||
      flag === "--no-resume" ||
      flag === "--with-hangup" ||
      flag === "--no-hangup"
    ) {
      flags.set(flag, "");
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      flags.set("--help", "");
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(flag)) {
      throw new UsageError(`unknown option ${JSON.stringify(flag)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    flags.set(flag, value);
    index += 1;
  }

  const timeoutRaw = flags.get("--timeout-ms");
  let timeoutMs = 120_000;
  if (timeoutRaw !== undefined) {
    timeoutMs = Number(timeoutRaw);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new UsageError(
        `--timeout-ms must be a positive whole number, got ${JSON.stringify(timeoutRaw)}`,
      );
    }
  }

  return {
    baseUrl: flags.get("--base-url"),
    wsUrl: flags.get("--ws-url"),
    voice: flags.get("--voice") ?? DEFAULT_VOICE,
    audioPath: flags.get("--audio"),
    eventsDir: flags.get("--events-dir"),
    timeoutMs,
    withResume: !flags.has("--no-resume"),
    withHangup: !flags.has("--no-hangup"),
    json: flags.has("--json"),
    help: flags.has("--help"),
  };
}

// ---------------------------------------------------------------------------
// Target: a local service or a deployed one
// ---------------------------------------------------------------------------

export class RealLegsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RealLegsError";
    this.code = code;
  }
}

export type RealLegsTarget = {
  /** The HTTP(S) base the signed body is delivered to. */
  httpBase: string;
  /** The browser-call URL the identity-only config is sent to. */
  wsUrl: string;
  /** True only for a loopback host; the trace is expected to be local. */
  local: boolean;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackHost(hostname: string): boolean {
  const host = bareHost(hostname);
  return LOOPBACK.has(host) || host.endsWith(".localhost");
}

function refuse(code: string, message: string): never {
  throw new RealLegsError(code, message);
}

function parseHttpBase(raw: string, field: string): { httpBase: string; local: boolean } {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    refuse(
      `${field}-invalid`,
      `${field} is not a URL: expected an http(s) base such as https://host[:port]`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    refuse(`${field}-invalid`, `${field} must use http or https (got "${url.protocol}")`);
  }
  if (!url.hostname) refuse(`${field}-invalid`, `${field} has no host`);
  if (url.username || url.password) {
    refuse(`${field}-invalid`, `${field} must not carry credentials`);
  }
  if (url.search || url.hash) {
    refuse(`${field}-invalid`, `${field} must be a base URL: no query string and no fragment`);
  }
  const local = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !local) {
    refuse(
      `${field}-insecure`,
      `${field} must use https for a deployed service (got "${value}"); http is allowed only on loopback`,
    );
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  return { httpBase: `${url.origin}${prefix}`, local };
}

function parseWsUrl(raw: string, field: string): { httpBase: string; wsUrl: string; local: boolean } {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    refuse(
      `${field}-invalid`,
      `${field} is not a URL: expected ws(s)://host[:port]${BROWSER_CALL_PATH}`,
    );
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    refuse(`${field}-invalid`, `${field} must use ws or wss (got "${url.protocol}")`);
  }
  if (!url.hostname) refuse(`${field}-invalid`, `${field} has no host`);
  if (url.username || url.password) {
    refuse(`${field}-invalid`, `${field} must not carry credentials`);
  }
  if (url.search || url.hash) {
    refuse(`${field}-invalid`, `${field} must carry no query string and no fragment`);
  }
  if (!url.pathname.endsWith(BROWSER_CALL_PATH)) {
    refuse(
      `${field}-invalid`,
      `${field} must end with ${BROWSER_CALL_PATH} (got "${url.pathname}")`,
    );
  }
  const local = isLoopbackHost(url.hostname);
  if (url.protocol === "ws:" && !local) {
    refuse(
      `${field}-insecure`,
      `${field} must use wss for a deployed service (got "${value}"); ws is allowed only on loopback`,
    );
  }
  const prefix = url.pathname.slice(0, -BROWSER_CALL_PATH.length).replace(/\/+$/, "");
  const baseOrigin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
  return {
    httpBase: `${baseOrigin}${prefix}`,
    wsUrl: `${baseOrigin.replace(/^http/, "ws")}${prefix}${BROWSER_CALL_PATH}`,
    local,
  };
}

function derivedWsUrl(httpBase: string): string {
  const url = new URL(httpBase);
  const prefix = url.pathname.replace(/\/+$/, "");
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${prefix}${BROWSER_CALL_PATH}`;
}

/**
 * Resolve the one service the check talks to. A base derives the WebSocket URL
 * (the app does the same for the browser); a WebSocket URL alone derives the
 * delivery base. A pair that names two hosts is refused: the signed body and
 * the socket must reach the same deployment.
 */
export function resolveTargets(input: { baseUrl?: string; wsUrl?: string }): RealLegsTarget {
  const base = input.baseUrl?.trim() ?? "";
  const ws = input.wsUrl?.trim() ?? "";
  if (!base && !ws) {
    refuse(
      "target-missing",
      "one of --base-url or --ws-url is required (or set VOICE_PIPELINE_URL / VOICE_PIPELINE_SERVICE_URL)",
    );
  }
  if (base && ws) {
    const http = parseHttpBase(base, "--base-url");
    const socket = parseWsUrl(ws, "--ws-url");
    if (http.httpBase !== socket.httpBase) {
      refuse(
        "target-mismatch",
        `--base-url "${http.httpBase}" and --ws-url "${socket.wsUrl}" must name the same service, but they resolve to "${http.httpBase}" and "${socket.httpBase}"`,
      );
    }
    return { httpBase: http.httpBase, wsUrl: socket.wsUrl, local: http.local && socket.local };
  }
  if (base) {
    const http = parseHttpBase(base, "--base-url");
    return {
      httpBase: http.httpBase,
      wsUrl: derivedWsUrl(http.httpBase),
      local: http.local,
    };
  }
  const socket = parseWsUrl(ws, "--ws-url");
  return { httpBase: socket.httpBase, wsUrl: socket.wsUrl, local: socket.local };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type RealLegsCheckStatus = "pass" | "fail" | "skip" | "info";

export type RealLegsCheck = {
  /** The human row label. */
  name: string;
  /** Stable machine name used in the failure summary. */
  code: string;
  status: RealLegsCheckStatus;
  detail: string;
};

export function passed(name: string, code: string, detail: string): RealLegsCheck {
  return { name, code, status: "pass", detail };
}

export function failed(name: string, code: string, detail: string): RealLegsCheck {
  return { name, code, status: "fail", detail };
}

export function skipped(name: string, code: string, detail: string): RealLegsCheck {
  return { name, code, status: "skip", detail };
}

/**
 * A measured input that is not a verdict: an unmeasured cost row is INFO,
 * never PASS (CODING_STANDARDS "Gates and measured evidence").
 */
export function info(name: string, code: string, detail: string): RealLegsCheck {
  return { name, code, status: "info", detail };
}

/** Print every assertion in order, then the one named skip lines and the tally. */
export function formatRealLegsReport(checks: readonly RealLegsCheck[]): string {
  const lines = ["demo-cascade real legs (ticket 22)", ""];
  for (const entry of checks) {
    const mark = entry.status.toUpperCase();
    lines.push(`  ${mark.padEnd(6)}${entry.name.padEnd(16)}${entry.detail}`);
  }
  lines.push("");
  for (const entry of checks) {
    if (entry.status === "skip") lines.push(`skipped: ${entry.detail}`);
  }
  const failures = checks.filter((entry) => entry.status === "fail");
  const skips = checks.filter((entry) => entry.status === "skip");
  const infos = checks.filter((entry) => entry.status === "info");
  if (failures.length > 0) {
    lines.push(
      `${failures.length} of ${checks.length} checks failed: ${failures
        .map((entry) => entry.code)
        .join(", ")}`,
    );
  } else if (skips.length > 0 || infos.length > 0) {
    const counts = [
      `${checks.length - skips.length - infos.length} passed`,
      ...(infos.length > 0 ? [`${infos.length} info`] : []),
      ...(skips.length > 0 ? [`${skips.length} skipped (named above)`] : []),
    ];
    lines.push(`${checks.length} checks: ${counts.join(", ")}`);
  } else {
    lines.push(`${checks.length} checks, all passed`);
  }
  return `${lines.join("\n")}\n`;
}

export function realLegsExitCode(checks: readonly RealLegsCheck[]): number {
  return checks.some((entry) => entry.status === "fail") ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Trace lines
// ---------------------------------------------------------------------------

/** One trace line; a malformed line is a refusal, never skipped evidence. */
export function parseTraceLines(text: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const rawLines = text.split("\n");
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RealLegsError(
        "trace-malformed",
        `trace line ${index + 1} is not JSON: ${raw.slice(0, 120)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RealLegsError(
        "trace-malformed",
        `trace line ${index + 1} is not a JSON object`,
      );
    }
    lines.push(parsed as Record<string, unknown>);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Caller audio
// ---------------------------------------------------------------------------

export type CallerAudio = {
  /** Raw PCM16, mono, 24 kHz. */
  pcm: Uint8Array;
  /** What was played, cited for the report. */
  source: string;
};

/** The caller line used only when the committed clip is not present. */
const CALLER_LINES: Record<string, string> = {
  en: "Hi, I am interested in your service. Could you explain what it costs?",
  de: "Hallo, ich interessiere mich für Ihren Service. Können Sie mir die Kosten erklären?",
  es: "Hola, me interesa su servicio. ¿Puede explicarme cuánto cuesta?",
  fr: "Bonjour, votre service m'intéresse. Pouvez-vous m'expliquer le coût ?",
  pt: "Olá, estou interessado no seu serviço. Pode explicar-me quanto custa?",
};

/** A WAV's PCM data chunk; the committed clip is 24 kHz mono PCM16. */
export function decodeWavPcm(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 44) {
    throw new RealLegsError("audio-invalid", "caller audio is shorter than a WAV header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readTag = (offset: number) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (readTag(0) !== "RIFF" || readTag(8) !== "WAVE") {
    throw new RealLegsError("audio-invalid", "caller audio is not a RIFF/WAVE file");
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = readTag(offset);
    const size = view.getUint32(offset + 4, true);
    if (tag === "fmt ") {
      const format = view.getUint16(offset + 8, true);
      const channels = view.getUint16(offset + 10, true);
      const rate = view.getUint32(offset + 12, true);
      const bits = view.getUint16(offset + 22, true);
      if (format !== 1 || channels !== 1 || rate !== 24_000 || bits !== 16) {
        throw new RealLegsError(
          "audio-format",
          `caller audio must be 24 kHz mono PCM16; got format ${format}, ${channels} channel(s), ${rate} Hz, ${bits}-bit`,
        );
      }
    }
    if (tag === "data") {
      return bytes.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  throw new RealLegsError("audio-invalid", "caller audio carries no data chunk");
}

export type LoadCallerAudioInput = {
  audioPath?: string;
  voice: string;
  /** The line to synthesize when no clip is present (default: the caller line). */
  text?: string;
  env: RealLegsEnvironment;
  fetchImpl: typeof fetch;
};

/**
 * The caller's line, played for each caller turn: the committed clip when it
 * exists, otherwise one short line through the real AssemblyAI TTS with the
 * key. Neither is a named failure, never silence.
 */
export async function loadCallerAudio(input: LoadCallerAudioInput): Promise<CallerAudio> {
  const path = input.audioPath ?? defaultCallerClip();
  // An explicit text is a different line, not the committed clip: it must be
  // synthesized even when the default clip exists (the hang-up turn).
  if (input.text === undefined) {
    if (existsSync(path)) {
      if (input.audioPath === undefined && path.toLowerCase().endsWith(".wav")) {
        // The committed clip is already the service's input format; no
        // external tool is needed for the common run.
        return { pcm: decodeWavPcm(readFileSync(path)), source: `committed caller clip ${path}` };
      }
      // An explicit clip may be any format ffmpeg reads; it is transcoded to
      // the wire's one format rather than refused for its container.
      return { pcm: transcodeToPcm(path), source: `caller clip ${path} (ffmpeg)` };
    }
    if (input.audioPath !== undefined) {
      throw new RealLegsError(
        "audio-missing",
        `--audio "${input.audioPath}" does not exist, and no synthesized fallback replaces an explicit clip`,
      );
    }
  }

  const apiKey = input.env.ASSEMBLYAI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new RealLegsError(
      "audio-missing",
      `the committed caller clip "${path}" is missing and ASSEMBLYAI_API_KEY is not set, so no caller line exists`,
    );
  }
  const language = getVoice(input.voice)?.languageCode ?? "en";
  const text = input.text ?? CALLER_LINES[language] ?? CALLER_LINES.en;
  const vendorVoice = `aai-${input.voice}`;
  let response: Response;
  try {
    response = await input.fetchImpl("https://tts.us.assemblyai.com/v1/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text, voice_id: vendorVoice, container: "wav", stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RealLegsError(
      "audio-synthesis-failed",
      `the committed caller clip is missing and the TTS request failed: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new RealLegsError(
      "audio-synthesis-failed",
      `the committed caller clip is missing and TTS refused the line (${response.status}): ${detail || "(no detail)"}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new RealLegsError(
      "audio-synthesis-failed",
      "the committed caller clip is missing and TTS returned no audio",
    );
  }
  return {
    pcm: decodeWavPcm(bytes),
    source: `synthesized caller line (${language}) through ${vendorVoice}`,
  };
}

/** Decode any clip ffmpeg understands into 24 kHz mono PCM16. */
function transcodeToPcm(path: string): Uint8Array {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", path, "-ac", "1", "-ar", "24000", "-f", "s16le", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    throw new RealLegsError(
      "audio-transcode",
      `could not run ffmpeg for "${path}": ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new RealLegsError(
      "audio-transcode",
      `ffmpeg refused "${path}": ${String(result.stderr).trim().slice(0, 300) || `exit ${result.status}`}`,
    );
  }
  return new Uint8Array(result.stdout);
}

// ---------------------------------------------------------------------------
// Caller ingress: one continuous, drift-corrected pump
// ---------------------------------------------------------------------------

/**
 * The cadence is the browser mic path's, not an invented one.
 *
 * `startAudioGraph` opens the shared context at the app's 24 kHz contract rate
 * where the platform allows it, and `public/pcm-processor.js` posts exactly one
 * frame per 128-sample render quantum. On that 24 kHz context the browser sends
 * 128 samples (256 bytes of PCM16) every 128 / 24000 s ≈ 5.333 ms, continuously,
 * for the whole call — the microphone never stops. The vendor's policy is
 * real-time ingress: a stream that stops or lags is closed with "Ingress audio
 * slower than real-time", and a stream delivered as one burst is closed with
 * "Audio processing backlog too large".
 */
export const INGRESS_SAMPLE_RATE = 24_000;
export const INGRESS_FRAME_SAMPLES = 128;
export const INGRESS_FRAME_BYTES = INGRESS_FRAME_SAMPLES * 2;
export const INGRESS_FRAME_MS = (INGRESS_FRAME_SAMPLES / INGRESS_SAMPLE_RATE) * 1_000;

/** One caller turn's trailing silence: the vendor's endpointing needs it. */
export const TURN_TAIL_MS = 1_000;

const BYTES_PER_MS = (INGRESS_SAMPLE_RATE * 2) / 1_000;

export type IngressPump = {
  /** Start the frame clock at this instant and send frame 0. */
  start(): void;
  /** Queue a caller turn; resolves after it and its tail silence are sent. */
  say(pcm: Uint8Array): Promise<void>;
  /** Stop the clock; resolves once the loop has left. */
  stop(): Promise<void>;
  /** Frames sent, for the operator report and the cadence tests. */
  frames(): number;
};

export type IngressPumpDeps = {
  /** Send one frame: 256 bytes of 24 kHz mono PCM16. */
  send: (pcm: Uint8Array<ArrayBuffer>) => void;
  /** A monotonic millisecond clock (the wall clock is enough at this scale). */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The frame carrying the clip's last speech sample was sent at this instant. */
  onSpeechEnd?: (at: number) => void;
};

/** A sample quieter than this is silence for the endpointing measurement. */
export const SPEECH_SAMPLE_FLOOR = 500;

/** Audio-timeline ms of the clip's last speech sample, or null for a silent clip. */
export function lastSpeechMs(pcm: Uint8Array): number | null {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = (view.byteLength >> 1) - 1; i >= 0; i--) {
    if (Math.abs(view.getInt16(i * 2, true)) >= SPEECH_SAMPLE_FLOOR) {
      return (i * 1_000) / INGRESS_SAMPLE_RATE;
    }
  }
  return null;
}

/**
 * A caller-side microphone, without a microphone: silence between the turns,
 * the queued clip inside them, always at the browser's frame cadence.
 *
 * Frame N is due at `startedAt + N * INGRESS_FRAME_MS`, absolute. Each wake
 * sleeps until its own due instant and re-checks, so a late timer never
 * accumulates drift and an early one never sends ahead of real time. Exactly
 * one frame goes out per due instant: a stalled loop resumes the schedule
 * without a catch-up burst beyond the stall itself, which is the same shape a
 * browser's render quanta take after a main-thread pause.
 */
export function createIngressPump(deps: IngressPumpDeps): IngressPump {
  let running = false;
  let loop: Promise<void> | null = null;
  let startedAt = 0;
  let frameIndex = 0;
  let queue = new Uint8Array(0);
  /** Audio-timeline position through which caller speech is queued, in ms. */
  let queueEndMs = 0;
  /** Audio-timeline position already sent (silence included), in ms. */
  let sentMs = 0;
  let waiters: { atMs: number; resolve: () => void }[] = [];

  function takeFrame(): Uint8Array<ArrayBuffer> {
    const frame = new Uint8Array(INGRESS_FRAME_BYTES);
    const take = Math.min(queue.length, INGRESS_FRAME_BYTES);
    if (take > 0) {
      frame.set(queue.subarray(0, take));
      queue = queue.subarray(take);
    }
    return frame;
  }

  function resolveDue(): void {
    if (waiters.length === 0) return;
    const due = waiters.filter((waiter) => waiter.atMs <= sentMs);
    if (due.length === 0) return;
    waiters = waiters.filter((waiter) => waiter.atMs > sentMs);
    for (const waiter of due) waiter.resolve();
  }

  async function run(): Promise<void> {
    while (running) {
      const due = startedAt + frameIndex * INGRESS_FRAME_MS;
      let wait = due - deps.now();
      // Re-check after every sleep: an early wake must not send ahead of the
      // schedule, and a late one sends the next frame now, not two at once.
      while (running && wait > 0) {
        await deps.sleep(wait);
        wait = due - deps.now();
      }
      if (!running) return;
      try {
        deps.send(takeFrame());
      } catch {
        // The socket died under the pump. Stop quietly: the call's own waits
        // name the failure; a rejected pump would only become an unhandled
        // rejection after this function returned.
        running = false;
        const left = waiters;
        waiters = [];
        for (const waiter of left) waiter.resolve();
        return;
      }
      frameIndex += 1;
      sentMs = (frameIndex * INGRESS_FRAME_SAMPLES * 1_000) / INGRESS_SAMPLE_RATE;
      resolveDue();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      startedAt = deps.now();
      frameIndex = 0;
      sentMs = 0;
      loop = run();
    },
    say(pcm) {
      if (!running) {
        return Promise.reject(
          new RealLegsError(
            "ingress-not-started",
            "the caller pump must be started before a turn is queued",
          ),
        );
      }
      if (pcm.length === 0) return Promise.resolve();
      const startMs = Math.max(queueEndMs, sentMs);
      const speechEndMs = lastSpeechMs(pcm);
      if (speechEndMs !== null) {
        waiters.push({
          atMs: startMs + speechEndMs,
          resolve: () => deps.onSpeechEnd?.(deps.now()),
        });
      }
      queueEndMs = startMs + pcm.length / BYTES_PER_MS;
      const next = new Uint8Array(queue.length + pcm.length);
      next.set(queue);
      next.set(pcm, queue.length);
      queue = next;
      return new Promise<void>((resolvePromise) => {
        waiters.push({ atMs: queueEndMs + TURN_TAIL_MS, resolve: resolvePromise });
      });
    },
    async stop() {
      running = false;
      const pending = loop;
      loop = null;
      if (pending) await pending;
      const left = waiters;
      waiters = [];
      for (const waiter of left) waiter.resolve();
    },
    frames() {
      return frameIndex;
    },
  };
}

// ---------------------------------------------------------------------------
// The call's flow
// ---------------------------------------------------------------------------

/** The socket surface the flow uses; the default is the platform WebSocket. */
export type RealLegsSocket = {
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onError(handler: (message: string) => void): void;
  onClose(handler: () => void): void;
};

export type RealLegsDeps = {
  env?: RealLegsEnvironment;
  fetchImpl?: typeof fetch;
  connect?: (url: string) => RealLegsSocket;
  loadCallerAudio?: (input: LoadCallerAudioInput) => Promise<CallerAudio>;
  readTrace?: (path: string) => string;
  traceExists?: (path: string) => boolean;
  readdir?: (path: string) => string[];
  sleep?: (ms: number) => Promise<void>;
  /** The ingress pump's monotonic clock; injectable so tests pin the cadence. */
  now?: () => number;
  callId?: string;
};

/** One reviewed reply: its endpointing plus reply split, marked partial. */
export type ReplyGapTurn = {
  /** Caller end of speech → final caller transcript receipt, or null unmeasured. */
  endpointingMs: number | null;
  /** Final transcript receipt → first agent audio receipt (the reply gap). */
  replyGapMs: number;
  /**
   * The gap is undivided: no `reply.started` frame exists on this wire, so
   * generation and delivery are not split. The trace-based split in
   * `latency-split.ts` is the full seam; this client-side measure stays
   * marked partial rather than guessing the division.
   */
  partial: true;
};

/**
 * Gate every timed reply gap on the frozen reply-gap budget.
 *
 * The only gate is `SCOREBOARD_BUDGETS.replyGapP95Ms`, read from the single
 * frozen table and cited by key: handshake bounds, token lifetimes, cushions,
 * hold windows, hedge delays and timeouts bound behaviour but are never quoted
 * as felt speed, so none of them appears here. The budgets table is frozen by
 * its own guard; this gate follows it, never a restated literal.
 */
export function assessReplyGaps(turns: ReplyGapTurn[]): RealLegsCheck[] {
  if (turns.length === 0) {
    return [failed("reply gaps", "reply-gap", "no completed caller turn produced a timed reply")];
  }
  const budgetKey = "replyGapP95Ms";
  const budgetMs = SCOREBOARD_BUDGETS.replyGapP95Ms.value;
  const rows = turns.map((turn, index) => {
    const endpointing =
      turn.endpointingMs === null ? "endpointing n/a" : `endpointing ${turn.endpointingMs}ms`;
    return `turn ${index + 1}: ${endpointing} + reply ${turn.replyGapMs}ms [partial]`;
  });
  const over = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.replyGapMs > budgetMs);
  if (over.length > 0) {
    const named = over
      .map(({ turn, index }) => `turn ${index + 1} reply ${turn.replyGapMs}ms`)
      .join(", ");
    return [
      failed(
        "reply gaps",
        "reply-gap",
        `${named} past the frozen ${budgetKey} budget of ${budgetMs}ms: ${rows.join("; ")}`,
      ),
    ];
  }
  return [
    passed(
      "reply gaps",
      "reply-gap",
      `${rows.join("; ")}; every reply within the frozen ${budgetKey} budget of ${budgetMs}ms`,
    ),
  ];
}

type CallState = {
  captions: { role: "user" | "agent"; text: string; final: boolean }[];
  audioFrames: number;
  audioBytes: number;
  end: Record<string, unknown> | null;
  error: string | null;
  closed: boolean;
  configKeys: string[] | null;
  turnLatencies: number[];
  endpointingMs: number[];
  pendingFinalAt: number | null;
  pendingAudioSeen: boolean;
  speechEndedAt: number | null;
  /** Last received agent audio frame; the previous reply's end once quiet. */
  lastAudioAt: number | null;
};

function defaultConnect(url: string): RealLegsSocket {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (handler) => {
      ws.onopen = () => handler();
    },
    onMessage: (handler) => {
      ws.onmessage = (event) => handler(typeof event.data === "string" ? event.data : "");
    },
    onError: (handler) => {
      ws.onerror = () => handler("the voice service socket reported an error");
    },
    onClose: (handler) => {
      ws.onclose = () => handler();
    },
  };
}

const STATE_POLL_MS = 25;
/** The greeting's audio arrives with sub-250 ms gaps; this is its end. */
const GREETING_QUIET_MS = 1_200;
/** How long a resumed call is observed before deciding it did not greet. */
const RESUME_GREETING_WINDOW_MS = 1_500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function defaultNow(): number {
  return performance.now();
}

function countUserFinals(state: CallState): number {
  return state.captions.filter((caption) => caption.role === "user" && caption.final).length;
}

async function waitFor(
  state: CallState,
  predicate: () => boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (state.error) {
      throw new RealLegsError("call-error", `${label}: the service refused the call: ${state.error}`);
    }
    if (state.closed && !state.end) {
      throw new RealLegsError(
        "call-closed",
        `${label}: the socket closed before the expected frame arrived`,
      );
    }
    if (Date.now() > deadline) {
      throw new RealLegsError(
        "call-timeout",
        `${label}: no expected frame within ${timeoutMs} ms`,
      );
    }
    await sleep(STATE_POLL_MS);
  }
}

/**
 * Let the agent finish speaking before the next caller turn: wait until no new
 * audio frame has arrived for a quiet window. A caller that talks over the
 * agent would barge in, which is a different test; this check is about two
 * clean turns. Bounded, so a stuck stream still ends the check by name.
 */
async function settleAudio(
  state: CallState,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
  label: string,
  quietMs = 800,
): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 20_000);
  let seen = state.audioFrames;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(100);
    if (state.error) {
      throw new RealLegsError("call-error", `${label}: the service refused the call: ${state.error}`);
    }
    if (state.closed && !state.end) {
      throw new RealLegsError(
        "call-closed",
        `${label}: the socket closed while the agent was speaking`,
      );
    }
    if (state.audioFrames !== seen) {
      seen = state.audioFrames;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) return;
  }
}

/**
 * Wait for the opening to finish.
 *
 * The greeting is not a turn and carries no caption (`cascade/greeting.py`), so
 * there is no "greeting finished" frame. The service's `greeting.done` trace row
 * is written only when the call ends (`_flush_operational_events`), so polling
 * the artifact would deadlock a live call. The wire's own signal is the greeting
 * audio: the service streams it as fast as the voice leg synthesizes it, with
 * sub-second gaps (measured under 250 ms), and nothing follows it until a
 * caller turn. Waiting for the first frame first keeps a slow-starting call
 * from being mistaken for a finished one; the quiet window is its end.
 */
async function waitForGreeting(
  state: CallState,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    state,
    () => state.audioFrames >= 1,
    timeoutMs,
    sleep,
    "greeting",
  );
  const deadline = Date.now() + timeoutMs;
  let lastFrames = state.audioFrames;
  let quietSince = Date.now();
  for (;;) {
    if (state.error) {
      throw new RealLegsError(
        "call-error",
        `greeting: the service refused the call: ${state.error}`,
      );
    }
    if (state.closed && !state.end) {
      throw new RealLegsError(
        "call-closed",
        "greeting: the socket closed before the greeting finished",
      );
    }
    if (state.audioFrames !== lastFrames) {
      lastFrames = state.audioFrames;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= GREETING_QUIET_MS) {
      return;
    }
    if (Date.now() > deadline) {
      throw new RealLegsError(
        "call-timeout",
        `greeting: the greeting audio did not settle within ${timeoutMs} ms`,
      );
    }
    await sleep(STATE_POLL_MS);
  }
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Assert the trace artifact: every line names the call id and the demo
 * subject, and one `cost.priced` row is either measured or says why it is not.
 *
 * A trace that cannot be read from here is a **named skip** when the target is
 * a deployed service (the artifact lives on the service host) and a **failure**
 * when the target is local (the same machine owns the directory).
 */
export function assessTrace(input: {
  exists: boolean;
  text: string | null;
  callId: string;
  voice: string;
  local: boolean;
  eventsDir: string;
  eventsPath: string | null;
}): RealLegsCheck[] {
  if (!input.exists || input.text === null) {
    const where = input.eventsPath ?? `${input.eventsDir}/${input.callId}.jsonl`;
    if (!input.local) {
      return [
        skipped(
          "trace",
          "trace-remote",
          `the trace artifact lives on the service host at ${where}; pass --events-dir after copying it, or run against a local service`,
        ),
        skipped(
          "cost row",
          "cost-remote",
          `the cost.priced row lives in the remote trace artifact at ${where}`,
        ),
      ];
    }
    return [
      failed(
        "trace",
        "trace-missing",
        `no trace artifact at ${where}; the service writes one JSONL per call id`,
      ),
      failed("cost row", "cost-missing", `no trace artifact at ${where}, so no cost.priced row`),
    ];
  }

  let lines: Record<string, unknown>[];
  try {
    lines = parseTraceLines(input.text);
  } catch (error) {
    const message = (error as Error).message;
    return [
      failed("trace", "trace-malformed", message),
      failed("cost row", "cost-malformed", message),
    ];
  }
  if (lines.length === 0) {
    return [
      failed("trace", "trace-empty", `${input.eventsDir}/${input.callId}.jsonl has no lines`),
      failed("cost row", "cost-missing", "the trace has no cost.priced row"),
    ];
  }

  const subject = `demo:${input.voice}`;
  // Every line of a demo trace names `demo:<voice>`, operational lines
  // included (ticket 17). A line without a subject is as wrong as one naming
  // another identity: the trace is the evidence that this call happened.
  const wrongCall = lines.filter((line) => line.callId !== input.callId);
  const wrongSubject = lines.filter((line) => line.subject !== subject);
  const bindingOk =
    wrongCall.length === 0 && wrongSubject.length === 0 && lines.length > 0;
  const checks: RealLegsCheck[] = [
    bindingOk
      ? passed(
          "trace",
          "trace",
          `${input.eventsDir}/${input.callId}.jsonl: ${lines.length} lines, every one callId "${input.callId}" and subject "${subject}"`,
        )
      : failed(
          "trace",
          "trace-binding",
          `${wrongCall.length + wrongSubject.length} of ${lines.length} lines do not bind to callId "${input.callId}" and subject "${subject}": ${JSON.stringify(wrongCall[0] ?? wrongSubject[0]).slice(0, 240)}`,
        ),
  ];

  const priced = lines.find((line) => line.type === "cost.priced");
  if (!priced) {
    checks.push(failed("cost row", "cost-missing", "the trace has no cost.priced row"));
    return checks;
  }
  const measured = priced.measured === true;
  // The one pricing path names itself on every row (`cascade.cost.cost_call`,
  // `cascade/events.py` COST_PRODUCER); the rate table that priced it is
  // always cited, even when a leg is unmeasured.
  const producer = priced.producer;
  const version = priced.rateTableVersion;
  const total = priced.totalUsd;
  const problems: string[] = [];
  if (producer !== COST_PRODUCER) {
    problems.push(
      `producer is ${JSON.stringify(producer)}, not "${COST_PRODUCER}"`,
    );
  }
  if (typeof version !== "string" || version.trim() === "") {
    problems.push(`rateTableVersion is ${JSON.stringify(version)}, not a cited rate table`);
  }
  if (measured) {
    if (typeof total !== "number") {
      problems.push(`a measured row needs a numeric totalUsd, got ${JSON.stringify(total)}`);
    }
    checks.push(
      problems.length === 0
        ? passed("cost row", "cost", `cost.priced measured $${total} with ${String(version)} (producer ${COST_PRODUCER})`)
        : failed(
            "cost row",
            "cost-invalid",
            `a measured cost.priced row must name its producer and rate table; ${problems.join("; ")}`,
          ),
    );
    return checks;
  }
  const reason = priced.unmeasuredReason;
  if (priced.measured !== false || typeof reason !== "string" || reason.trim() === "") {
    problems.push(
      `a cost row must be measured or state an unmeasuredReason; measured=${JSON.stringify(priced.measured)}, unmeasuredReason=${JSON.stringify(reason)}`,
    );
  }
  checks.push(
    problems.length === 0
      ? info(
          "cost row",
          "cost",
          `cost.priced unmeasured: ${reason} (producer ${COST_PRODUCER}; rate table ${String(version)})`,
        )
      : failed(
          "cost row",
          "cost-invalid",
          `an unmeasured cost.priced row must state its reason, producer and rate table; ${problems.join("; ")}`,
        ),
  );
  return checks;
}

/**
 * The bounded recent-turn history a hold return carries. Only settled turns:
 * final caller captions and the agent's streamed lines (partials of one reply
 * collapse to the last, longest text). The newest `maxTurns` messages are
 * kept, and a leading assistant line is dropped so the resumed history starts
 * at a caller turn. The builder validates the bound again.
 */
export function carriedHistory(
  captions: readonly { role: "user" | "agent"; text: string; final: boolean }[],
  maxTurns: number,
): { role: "user" | "assistant"; content: string }[] {
  const settled: { role: "user" | "assistant"; content: string }[] = [];
  for (const caption of captions) {
    const text = caption.text.trim();
    if (text === "") continue;
    if (caption.role === "user" && !caption.final) continue;
    const previous = settled[settled.length - 1];
    if (caption.role === "agent" && previous?.role === "assistant") {
      // The service streams an agent line as growing partials; the longest is
      // the line the caller heard.
      if (text.length >= previous.content.length) previous.content = text;
      continue;
    }
    settled.push({
      role: caption.role === "agent" ? "assistant" : "user",
      content: text,
    });
  }
  const bounded = settled.slice(Math.max(0, settled.length - maxTurns));
  while (bounded.length > 0 && bounded[0].role === "assistant") bounded.shift();
  return bounded;
}

/**
 * Run the real-legs call and return every assertion in report order.
 *
 * One fatal step (the signed body, the delivery, the caller audio, the socket)
 * returns a single named failure; later checks are not invented. Once the call
 * is running, every assertion is recorded. The caller speaks twice, the hidden
 * context note rides the next model request, and with `withResume` (the
 * default) the call is stopped and the same call id is re-minted with
 * `resume: true` and the carried history, proving the hold return end to end.
 */
export async function runRealLegs(
  options: RealLegsOptions,
  target: RealLegsTarget,
  deps: RealLegsDeps = {},
): Promise<RealLegsCheck[]> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? defaultNow;
  const connect = deps.connect ?? defaultConnect;
  const loadAudio = deps.loadCallerAudio ?? loadCallerAudio;
  const traceExists = deps.traceExists ?? existsSync;
  const readTrace = deps.readTrace ?? ((path: string) => readFileSync(path, "utf8"));
  const readDir = deps.readdir ?? ((path: string) => readdirSync(path));
  const callId = deps.callId ?? randomUUID();
  const checks: RealLegsCheck[] = [];
  const listEvents = (): string[] | null => {
    try {
      return readDir(resolveEventsDir(options, env)).sort();
    } catch {
      return null;
    }
  };
  // Snapshot the trace directory before the first connect, so the resume phase
  // can prove the run added exactly one file for this call id.
  const eventsBefore = listEvents();

  async function connectCall(
    minted: Awaited<ReturnType<typeof buildDemoCascadeBody>>,
  ): Promise<{
    state: CallState;
    socket: RealLegsSocket;
    ingress: ReturnType<typeof createIngressPump>;
  }> {
    const state: CallState = {
      captions: [],
      audioFrames: 0,
      audioBytes: 0,
      end: null,
      error: null,
      closed: false,
      configKeys: null,
      turnLatencies: [],
      endpointingMs: [],
      pendingFinalAt: null,
      pendingAudioSeen: false,
      speechEndedAt: null,
      lastAudioAt: null,
    };
    let socket: RealLegsSocket;
    try {
      socket = connect(target.wsUrl);
    } catch (error) {
      throw new RealLegsError(
        "connect-failed",
        `could not open ${target.wsUrl}: ${(error as Error).message}`,
      );
    }
    const opened = new Promise<void>((resolvePromise) =>
      socket.onOpen(() => resolvePromise()),
    );
    const ingress = createIngressPump({
      send: (frame) => socket.send(encodeAudioFrame(frame.buffer)),
      now,
      sleep,
      onSpeechEnd: (at) => {
        state.speechEndedAt = at;
      },
    });
    socket.onMessage((raw) => {
      ingress.start();
      const audioFrame = decodeAudioMessage(raw);
      if (audioFrame) {
        state.audioFrames += 1;
        state.audioBytes += audioFrame.pcm.length;
        state.lastAudioAt = now();
        if (state.pendingFinalAt !== null && !state.pendingAudioSeen) {
          state.pendingAudioSeen = true;
          state.turnLatencies.push(now() - state.pendingFinalAt);
        }
        return;
      }
      const event = parseServerMessage(raw);
      if (!event) return;
      switch (event.kind) {
        case "caption":
          state.captions.push({ role: event.role, text: event.text, final: event.final });
          if (event.role === "user" && event.final) {
            state.pendingFinalAt = now();
            state.pendingAudioSeen = false;
            if (state.speechEndedAt !== null) {
              state.endpointingMs.push(now() - state.speechEndedAt);
              state.speechEndedAt = null;
            }
          }
          break;
        case "end":
          try {
            state.end = recordFrom(JSON.parse(raw) as unknown);
          } catch {
            state.error = "the service's end frame was not readable JSON";
          }
          break;
        case "error":
          state.error = event.message;
          break;
        default:
          break;
      }
    });
    socket.onError((message) => {
      // The service closes the socket after its one end frame; that close is
      // not a failure of a call that already ended.
      if (state.end === null) state.error = message;
    });
    socket.onClose(() => {
      state.closed = true;
    });

    let connectTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        opened,
        new Promise<never>((_resolve, reject) => {
          connectTimer = setTimeout(
            () =>
              reject(
                new RealLegsError(
                  "connect-timeout",
                  `no WebSocket open on ${target.wsUrl} within ${options.timeoutMs} ms`,
                ),
              ),
            options.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
    }

    const config = buildConfigMessage({
      serviceUrl: target.wsUrl,
      callToken: minted.callToken,
      agentId: minted.agentId,
      protocolVersion: CASCADE_PROTOCOL_VERSION,
    });
    state.configKeys = Object.keys(JSON.parse(config) as Record<string, unknown>).sort();
    socket.send(config);
    return { state, socket, ingress };
  }

  let call: Awaited<ReturnType<typeof buildDemoCascadeBody>>;
  try {
    call = await buildDemoCascadeBody({ voice: options.voice, callId });
  } catch (error) {
    checks.push(
      failed(
        "signed body",
        "sign-failed",
        `${(error as Error).name}: ${(error as Error).message}`,
      ),
    );
    return checks;
  }
  checks.push(
    passed(
      "signed body",
      "signed-body",
      `v2 demo body for "${call.agentId}", call "${call.callId}", body hash ${call.bodyHash}`,
    ),
  );

  const delivery = await deliverCallBody(
    {
      pipelineBase: target.httpBase,
      callToken: call.callToken,
      callId: call.callId,
      signedBody: call.signedBody,
    },
    { fetchImpl },
  );
  if (!delivery.ok) {
    checks.push(
      failed(
        "delivery",
        delivery.code,
        `POST ${target.httpBase}/v1/call-body refused: ${delivery.code} — ${delivery.message}`,
      ),
    );
    return checks;
  }
  if (
    delivery.callId !== call.callId ||
    delivery.agentId !== call.agentId ||
    delivery.bodyHash !== call.bodyHash
  ) {
    checks.push(
      failed(
        "delivery",
        "delivery-mismatch",
        `the service accepted call "${delivery.callId}" for "${delivery.agentId}" with body hash ${delivery.bodyHash}; the app sent "${call.callId}", "${call.agentId}", ${call.bodyHash}`,
      ),
    );
    return checks;
  }
  checks.push(
    passed(
      "delivery",
      "delivery",
      `POST ${target.httpBase}/v1/call-body → 202 accepted; call "${call.callId}", subject "${call.agentId}", body hash ${call.bodyHash}`,
    ),
  );

  let audio: CallerAudio;
  try {
    audio = await loadAudio({
      audioPath: options.audioPath,
      voice: options.voice,
      env,
      fetchImpl,
    });
  } catch (error) {
    checks.push(
      failed(
        "caller audio",
        "audio-missing",
        `${(error as Error).name}: ${(error as Error).message}`,
      ),
    );
    return checks;
  }
  if (audio.pcm.length === 0) {
    checks.push(failed("caller audio", "audio-empty", `${audio.source} carries no PCM`));
    return checks;
  }
  checks.push(
    passed(
      "caller audio",
      "caller-audio",
      `${audio.source}: ${audio.pcm.length} bytes, 24 kHz mono PCM16`,
    ),
  );

  let connection: Awaited<ReturnType<typeof connectCall>>;
  try {
    connection = await connectCall(call);
  } catch (error) {
    checks.push(
      failed(
        "connect",
        (error as RealLegsError).code ?? "connect-failed",
        `${(error as Error).name}: ${(error as Error).message}`,
      ),
    );
    return checks;
  }
  const { state, socket, ingress } = connection;

  try {
    await waitForGreeting(state, sleep, options.timeoutMs);

    const beforeTurnOneUser = countUserFinals(state);
    const beforeTurnOneAudio = state.audioFrames;
    // `say` paces the clip at the pump's cadence and resolves after the
    // trailing silence, so the vendor has heard a whole caller turn.
    await ingress.say(audio.pcm);
    await waitFor(
      state,
      () => countUserFinals(state) > beforeTurnOneUser,
      options.timeoutMs,
      sleep,
      "turn 1",
    );
    // The agent's turn has no final caption (`turn_stream._speak` emits agent
    // lines as partials); its audio going quiet is the turn's end. The demo
    // reply may cross a tool round, so the window is wider than a sentence gap.
    await waitFor(
      state,
      () => state.audioFrames > beforeTurnOneAudio,
      options.timeoutMs,
      sleep,
      "turn 1 reply",
    );
    await settleAudio(state, sleep, options.timeoutMs, "turn 1", 2_500);
    const userFinalsAfterTurnOne = countUserFinals(state);
    const audioFramesAfterTurnOne = state.audioFrames;

    await ingress.say(audio.pcm);
    await waitFor(
      state,
      () => countUserFinals(state) > userFinalsAfterTurnOne,
      options.timeoutMs,
      sleep,
      "turn 2",
    );
    await waitFor(
      state,
      () => state.audioFrames > audioFramesAfterTurnOne,
      options.timeoutMs,
      sleep,
      "turn 2 reply",
    );
    await settleAudio(state, sleep, options.timeoutMs, "turn 2", 2_500);

    // Ticket 12 AC3: the demo's off-track note reaches the service over the
    // hidden context frame and is never captioned. The service holds the note
    // for the next model request, and a note while the caller is silent starts
    // no turn of its own, so spend it: one more caller turn, whose reply is the
    // model request that carried the note. A phase that only sends the note
    // would pass even with context handling deleted. The time-up note uses the
    // same frame but tells the agent to hang up, so it is not sent mid-check;
    // the off-track note is the one that leaves the call alive to resume.
    const contextNote = rungInstructions("nudge");
    const captionsBeforeContext = state.captions.length;
    const userFinalsBeforeContext = countUserFinals(state);
    const audioFramesBeforeContext = state.audioFrames;
    socket.send(encodeContextMessage(contextNote));
    await ingress.say(audio.pcm);
    await waitFor(
      state,
      () => countUserFinals(state) > userFinalsBeforeContext,
      options.timeoutMs,
      sleep,
      "context turn",
    );
    await waitFor(
      state,
      () => state.audioFrames > audioFramesBeforeContext,
      options.timeoutMs,
      sleep,
      "context reply",
    );
    await settleAudio(state, sleep, options.timeoutMs, "context turn", 2_500);
    const captionsAfterContext = state.captions.length - captionsBeforeContext;
    const leaked = state.captions.filter(
      (caption) =>
        caption.text.includes(contextNote) ||
        caption.text.includes("The caller's last turn was off-track."),
    );
    checks.push(
      leaked.length === 0 && state.end === null && !state.closed && state.error === null
        ? passed(
            "hidden context",
            "context-hidden",
            `sent the off-track note as a context frame (${contextNote.length} chars); the next caller turn was answered (${captionsAfterContext} captions after the note), none contains it; the call stayed alive`,
          )
        : failed(
            "hidden context",
            "context-leaked",
            `the hidden context frame must not be captioned and must not end the call; leaked=${JSON.stringify(leaked[0]?.text ?? "").slice(0, 160)}, ended=${state.end !== null}, closed=${state.closed}, error=${JSON.stringify(state.error)}`,
          ),
    );

    if (options.withHangup) {
      const locale = getVoice(options.voice)?.languageCode ?? "en";
      try {
        const hangupAudio = await loadAudio({
          voice: options.voice,
          text: HANGUP_LINES[locale] ?? HANGUP_LINES.en,
          env,
          fetchImpl,
        });
        const userFinalsBeforeHangup = countUserFinals(state);
        const captionsBeforeHangup = state.captions.length;
        await ingress.say(hangupAudio.pcm);
        await waitFor(
          state,
          () => countUserFinals(state) > userFinalsBeforeHangup,
          options.timeoutMs,
          sleep,
          "hang-up turn",
        );
        // The service, not this harness, must end the call: no `stop` frame is
        // sent before this wait. That is the whole point of the check.
        await waitFor(
          state,
          () => state.end !== null,
          Math.min(options.timeoutMs, 20_000),
          sleep,
          "hang-up end",
        );
        const hangupEnd = state.end ?? {};
        const counts =
          (hangupEnd.metrics as { counts?: Record<string, number> } | undefined)?.counts ??
          {};
        const goodbyeLines = state.captions
          .slice(captionsBeforeHangup)
          .filter((caption) => caption.role === "agent" && caption.text.trim() !== "")
          .map((caption) => caption.text);
        const endError = (hangupEnd as { error?: unknown }).error;
        const ok =
          hangupEnd.endedBy === "stop" &&
          (counts.end_call ?? 0) >= 1 &&
          goodbyeLines.length > 0 &&
          endError === undefined;
        checks.push(
          ok
            ? passed(
                "hang-up",
                "hangup",
                `the caller's end request ended call "${callId}" (endedBy "${String(hangupEnd.endedBy)}", end_call ${counts.end_call ?? 0}); the agent's last line was ${JSON.stringify(goodbyeLines.at(-1) ?? "").slice(0, 120)}`,
              )
            : failed(
                "hang-up",
                "hangup",
                `the caller asked to end but the service did not end the call: endedBy=${JSON.stringify(hangupEnd.endedBy)}, end_call=${counts.end_call ?? 0}, agentLines=${goodbyeLines.length}, callerFinal=${JSON.stringify(state.captions.filter((caption) => caption.role === "user" && caption.final).at(-1)?.text ?? "")}, endError=${JSON.stringify(endError)}`,
              ),
        );
      } catch (error) {
        checks.push(
          failed(
            "hang-up",
            (error as RealLegsError).code ?? "hangup-failed",
            `${(error as Error).name}: ${(error as Error).message}; callerFinal=${JSON.stringify(state.captions.filter((caption) => caption.role === "user" && caption.final).at(-1)?.text ?? "")}`,
          ),
        );
      }
    }

    await ingress.stop();
    if (state.end === null) {
      socket.send(JSON.stringify({ type: "stop" }));
      await waitFor(state, () => state.end !== null, options.timeoutMs, sleep, "end message");
    }
  } catch (error) {
    checks.push(
      failed(
        "call",
        (error as RealLegsError).code ?? "call-failed",
        `${(error as Error).name}: ${(error as Error).message}`,
      ),
    );
    await ingress.stop().catch(() => undefined);
    socket.close();
    checks.push(
      ...assessTraceAfterCall(options, target, callId, traceExists, readTrace, null, env),
    );
    return checks;
  } finally {
    await ingress.stop().catch(() => undefined);
    socket.close();
  }

  checks.push(
    passed(
      "identity config",
      "identity-config",
      `first frame carried only ${state.configKeys?.join(", ")} for "${call.agentId}"`,
    ),
  );

  const userFinals = countUserFinals(state);
  const agentLines = state.captions
    .filter((caption) => caption.role === "agent" && caption.text.trim() !== "")
    .map((caption) => caption.text);
  checks.push(
    userFinals >= 2 && agentLines.length >= 2
      ? passed(
          "captions",
          "captions",
          `${userFinals} caller finals and ${agentLines.length} agent caption lines (the service streams agent lines as partials; the greeting is not a turn and carries no caption); first agent line: ${JSON.stringify(agentLines[0] ?? "").slice(0, 120)}`,
        )
      : failed(
          "captions",
          "captions",
          `expected at least two caller finals and two agent caption lines (one per turn; the greeting carries no caption); got ${userFinals} caller finals and ${agentLines.length} agent lines`,
        ),
  );

  const gapTurns: ReplyGapTurn[] = state.turnLatencies.map((replyGapMs, index) => ({
    endpointingMs: state.endpointingMs[index] ?? null,
    replyGapMs,
    partial: true,
  }));
  checks.push(...assessReplyGaps(gapTurns));

  checks.push(
    state.audioFrames > 0 && state.audioBytes > 0
      ? passed(
          "audio",
          "audio-frames",
          `${state.audioFrames} audio frames, ${state.audioBytes} PCM bytes (24 kHz PCM16)`,
        )
      : failed("audio", "audio-frames", "no audio frames arrived from the service"),
  );

  const end = state.end ?? {};
  const endCost = recordFrom(end.cost);
  const endTurns = typeof end.turns === "number" ? end.turns : 0;
  const gaps = (end.metrics as { gaps_ms?: unknown } | undefined)?.gaps_ms;
  const endCounts =
    (end.metrics as { counts?: Record<string, number> } | undefined)?.counts ?? {};
  const endOk =
    end.callId === callId &&
    endTurns >= 2 &&
    endCost !== null &&
    (endCost.measured === true || typeof endCost.unmeasuredReason === "string");
  checks.push(
    endOk
      ? passed(
          "end message",
          "end-message",
          `callId "${callId}" ended after ${endTurns} turns; cost ${endCost?.measured === true ? `measured $${String(endCost.totalUsd)}` : `unmeasured (${String(endCost?.unmeasuredReason ?? "")})`}; gaps ${JSON.stringify(gaps)}; hedge ${endCounts.hedge_started ?? 0}/${endCounts.hedge_won ?? 0}`,
        )
      : failed(
          "end message",
          "end-message",
          `expected the end message for call "${callId}" with at least two turns and a measured-or-explained cost; got ${JSON.stringify(
            { callId: end.callId, turns: end.turns, cost: end.cost },
          ).slice(0, 300)}`,
        ),
  );

  let resumedEventsPath: string | null = null;
  if (options.withResume) {
    try {
      const history = carriedHistory(state.captions, BOUNDS.resumeHistoryTurns);
      if (history.length === 0) {
        throw new RealLegsError(
          "resume-history",
          "the two turns left no settled history to carry into the hold return",
        );
      }
      const resumeCallId = callId;
      const resumed = await buildDemoCascadeBody({
        voice: options.voice,
        callId: resumeCallId,
        resume: true,
        history,
      });
      if (resumed.callId !== resumeCallId) {
        throw new RealLegsError(
          "resume-call-id",
          `the hold return minted call "${resumed.callId}", not the held call "${callId}"`,
        );
      }
      if (resumed.callToken === call.callToken) {
        throw new RealLegsError(
          "resume-token-reused",
          "the hold return reused the previous cascade token; a fresh token is required",
        );
      }
      checks.push(
        passed(
          "resume body",
          "resume-body",
          `re-minted call "${callId}" with resume: true and ${history.length} carried turns (${history.map((turn) => turn.role).join(", ")}); fresh cascade token`,
        ),
      );

      const resumeDelivery = await deliverCallBody(
        {
          pipelineBase: target.httpBase,
          callToken: resumed.callToken,
          callId: resumed.callId,
          signedBody: resumed.signedBody,
        },
        { fetchImpl },
      );
      if (!resumeDelivery.ok) {
        throw new RealLegsError(
          resumeDelivery.code,
          `POST ${target.httpBase}/v1/call-body refused the hold return: ${resumeDelivery.code} — ${resumeDelivery.message}`,
        );
      }
      if (
        resumeDelivery.callId !== resumeCallId ||
        resumeDelivery.agentId !== resumed.agentId ||
        resumeDelivery.bodyHash !== resumed.bodyHash
      ) {
        throw new RealLegsError(
          "resume-delivery-mismatch",
          `the service accepted call "${resumeDelivery.callId}" for "${resumeDelivery.agentId}" with body hash ${resumeDelivery.bodyHash}; the app sent "${callId}", "${resumed.agentId}", ${resumed.bodyHash}`,
        );
      }
      checks.push(
        passed(
          "resume delivery",
          "resume-delivery",
          `POST ${target.httpBase}/v1/call-body → 202 accepted; same call "${callId}", fresh body hash ${resumed.bodyHash}`,
        ),
      );

      const resumedConnection = await connectCall(resumed);
      try {
        await sleep(RESUME_GREETING_WINDOW_MS);
        if (resumedConnection.state.error) {
          throw new RealLegsError(
            "resume-error",
            `the resumed call was refused: ${resumedConnection.state.error}`,
          );
        }
        const locale = getVoice(options.voice)?.languageCode ?? "en";
        const greeting = VONI_GREETINGS[locale] ?? VONI_GREETINGS.en;
        const spokenGreeting = resumedConnection.state.captions.find(
          (caption) => caption.role === "agent" && caption.text.includes(greeting),
        );
        if (resumedConnection.state.audioFrames > 0 || spokenGreeting !== undefined) {
          throw new RealLegsError(
            "resume-greeted",
            `a resumed call must not speak the greeting; got ${resumedConnection.state.audioFrames} audio frames and ${JSON.stringify(spokenGreeting?.text ?? "").slice(0, 120)} within ${RESUME_GREETING_WINDOW_MS} ms`,
          );
        }
        checks.push(
          passed(
            "no greeting",
            "resume-no-greeting",
            `no audio and no caption in ${RESUME_GREETING_WINDOW_MS} ms after the resumed config; the call waited for the caller`,
          ),
        );

        // A resumed call sends nothing until the caller speaks, so the first
        // server frame cannot start the pump. The socket has been open through
        // the no-greeting window, so the legs are up; start it explicitly.
        resumedConnection.ingress.start();
        const beforeResumeUser = countUserFinals(resumedConnection.state);
        await resumedConnection.ingress.say(audio.pcm);
        await waitFor(
          resumedConnection.state,
          () => countUserFinals(resumedConnection.state) > beforeResumeUser,
          options.timeoutMs,
          sleep,
          "resumed call",
        );
        await waitFor(
          resumedConnection.state,
          () => resumedConnection.state.audioFrames > 0,
          options.timeoutMs,
          sleep,
          "resumed reply",
        );
        await settleAudio(
          resumedConnection.state,
          sleep,
          options.timeoutMs,
          "resumed call",
          2_500,
        );
        const continuation = [...resumedConnection.state.captions]
          .reverse()
          .find((caption) => caption.role === "agent" && caption.text.trim() !== "");
        if (continuation === undefined) {
          throw new RealLegsError(
            "resume-no-reply",
            "the resumed call answered the caller clip with no agent caption",
          );
        }
        if (continuation.text.includes(greeting)) {
          throw new RealLegsError(
            "resume-greeted",
            `the resumed reply repeated the greeting: ${JSON.stringify(continuation.text).slice(0, 120)}`,
          );
        }
        checks.push(
          passed(
            "continuation",
            "resume-continuation",
            `caller clip answered with ${JSON.stringify(continuation.text).slice(0, 140)}; ${history.length} carried turns were in the signed body`,
          ),
        );

        await resumedConnection.ingress.stop();
        resumedConnection.socket.send(JSON.stringify({ type: "stop" }));
        await waitFor(
          resumedConnection.state,
          () => resumedConnection.state.end !== null,
          options.timeoutMs,
          sleep,
          "resumed end message",
        );
        const resumedEnd = resumedConnection.state.end ?? {};
        resumedEventsPath =
          typeof resumedEnd.eventsPath === "string" ? resumedEnd.eventsPath : null;
        const resumedTurns = typeof resumedEnd.turns === "number" ? resumedEnd.turns : 0;
        checks.push(
          resumedEnd.callId === callId && resumedTurns >= 1
            ? passed(
                "resume end",
                "resume-end-message",
                `callId "${callId}" ended after ${resumedTurns} resumed turn(s); the call id was re-claimed`,
              )
            : failed(
                "resume end",
                "resume-end-message",
                `expected the resumed call to end under "${callId}" after at least one turn; got ${JSON.stringify({
                  callId: resumedEnd.callId,
                  turns: resumedEnd.turns,
                }).slice(0, 200)}`,
              ),
        );
      } finally {
        await resumedConnection.ingress.stop().catch(() => undefined);
        resumedConnection.socket.close();
      }
    } catch (error) {
      checks.push(
        failed(
          "resume",
          (error as RealLegsError).code ?? "resume-failed",
          `${(error as Error).name}: ${(error as Error).message}`,
        ),
      );
    }
  }

  if (options.withResume) {
    const added = (() => {
      const after = listEvents();
      if (after === null || eventsBefore === null) return null;
      return after.filter((name) => !eventsBefore.includes(name));
    })();
    const expected = `${callId}.jsonl`;
    checks.push(
      added === null
        ? skipped(
            "resume trace",
            "resume-trace-remote",
            `the events directory is not readable here; pass --events-dir to prove one trace file for call "${callId}"`,
          )
        : added.length === 1 && added[0] === expected
          ? passed(
              "resume trace",
              "resume-trace",
              `one trace file "${expected}" for call "${callId}"; the hold return appended to it and opened no second call record`,
            )
          : failed(
              "resume trace",
              "resume-trace",
              `expected exactly one new trace file "${expected}" for call "${callId}"; got ${JSON.stringify(added)}`,
            ),
    );
  }

  checks.push(
    ...assessTraceAfterCall(
      options,
      target,
      callId,
      traceExists,
      readTrace,
      resumedEventsPath ?? (typeof end.eventsPath === "string" ? end.eventsPath : null),
      env,
    ),
  );
  return checks;
}

/** The trace path the service owns; `--events-dir` wins, then its env, then the default. */
export function resolveEventsDir(
  options: Pick<RealLegsOptions, "eventsDir">,
  env: RealLegsEnvironment,
): string {
  const configured = options.eventsDir ?? env[EVENTS_DIR_ENV];
  if (configured && configured.trim() !== "") return configured.trim();
  return fileURLToPath(new URL("../../../voice-pipeline/.events", import.meta.url));
}

function assessTraceAfterCall(
  options: RealLegsOptions,
  target: RealLegsTarget,
  callId: string,
  traceExists: (path: string) => boolean,
  readTrace: (path: string) => string,
  eventsPath: string | null,
  env: RealLegsEnvironment,
): RealLegsCheck[] {
  const dir = resolveEventsDir(options, env);
  // An operator who names the directory (flag or env) is pointing at a local
  // copy of the artifact; the service's own absolute path is then a server
  // fact that does not name that copy. Otherwise prefer the path the end
  // message cited over guessing the service's filename.
  const configured =
    (options.eventsDir ?? env[EVENTS_DIR_ENV] ?? "").trim() !== "";
  const expected = configured ? `${dir}/${callId}.jsonl` : (eventsPath ?? `${dir}/${callId}.jsonl`);
  const exists = traceExists(expected);
  const text = exists
    ? (() => {
        try {
          return readTrace(expected);
        } catch {
          return null;
        }
      })()
    : null;
  return assessTrace({
    exists: text !== null,
    text,
    callId,
    voice: options.voice,
    local: target.local,
    eventsDir: dir,
    eventsPath: expected,
  });
}
