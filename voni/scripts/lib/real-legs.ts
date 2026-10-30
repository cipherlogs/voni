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

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CASCADE_PROTOCOL_VERSION,
  buildConfigMessage,
  decodeAudioMessage,
  encodeAudioFrame,
  parseServerMessage,
} from "../../src/lib/voice/cascade-session";
import { buildDemoCascadeBody } from "../../src/lib/demo/cascade-body";
import { deliverCallBody } from "../../src/lib/demo/pipeline-delivery";
import { getVoice } from "../../src/lib/agents/voices";

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

/** The demo voice whose locale matches the committed caller clip. */
export const DEFAULT_VOICE = "jorg";

export const REAL_LEGS_USAGE = `usage: npm run ${REAL_LEGS_COMMAND} -- [options]

  --base-url URL      the pipeline's HTTP(S) base (default: VOICE_PIPELINE_URL,
                      then VOICE_PIPELINE_SERVICE_URL)
  --ws-url URL        the browser-call WebSocket URL (derived from --base-url)
  --voice ID          the demo voice and subject (default: ${DEFAULT_VOICE}, whose
                      committed German caller clip ships in the repo)
  --audio PATH        a caller clip to play twice (default: the committed clip;
                      without it, one short line is synthesized with the key)
  --events-dir PATH   the service's trace directory (default:
                      ${EVENTS_DIR_ENV}, then voice-pipeline/.events)
  --timeout-ms N      per-wait bound (default: 120000)
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

export type RealLegsCheckStatus = "pass" | "fail" | "skip";

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

/** Print every assertion in order, then the one named skip lines and the tally. */
export function formatRealLegsReport(checks: readonly RealLegsCheck[]): string {
  const lines = ["demo-cascade real legs (ticket 22)", ""];
  for (const entry of checks) {
    const mark = entry.status === "pass" ? "PASS" : entry.status === "fail" ? "FAIL" : "SKIP";
    lines.push(`  ${mark.padEnd(6)}${entry.name.padEnd(16)}${entry.detail}`);
  }
  lines.push("");
  for (const entry of checks) {
    if (entry.status === "skip") lines.push(`skipped: ${entry.detail}`);
  }
  const failures = checks.filter((entry) => entry.status === "fail");
  const skips = checks.filter((entry) => entry.status === "skip");
  if (failures.length > 0) {
    lines.push(
      `${failures.length} of ${checks.length} checks failed: ${failures
        .map((entry) => entry.code)
        .join(", ")}`,
    );
  } else if (skips.length > 0) {
    lines.push(
      `${checks.length} checks: ${checks.length - skips.length} passed, ${skips.length} skipped (named above)`,
    );
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
  env: RealLegsEnvironment;
  fetchImpl: typeof fetch;
};

/**
 * The caller's two turns: the committed clip when it exists, otherwise one
 * short line through the real AssemblyAI TTS with the key. Neither is a named
 * failure, never silence.
 */
export async function loadCallerAudio(input: LoadCallerAudioInput): Promise<CallerAudio> {
  const path = input.audioPath ?? defaultCallerClip();
  if (existsSync(path)) {
    if (input.audioPath === undefined && path.toLowerCase().endsWith(".wav")) {
      // The committed clip is already the service's input format; no external
      // tool is needed for the common run.
      return { pcm: decodeWavPcm(readFileSync(path)), source: `committed caller clip ${path}` };
    }
    // An explicit clip may be any format ffmpeg reads; it is transcoded to the
    // wire's one format rather than refused for its container.
    return { pcm: transcodeToPcm(path), source: `caller clip ${path} (ffmpeg)` };
  }
  if (input.audioPath !== undefined) {
    throw new RealLegsError(
      "audio-missing",
      `--audio "${input.audioPath}" does not exist, and no synthesized fallback replaces an explicit clip`,
    );
  }

  const apiKey = input.env.ASSEMBLYAI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new RealLegsError(
      "audio-missing",
      `the committed caller clip "${path}" is missing and ASSEMBLYAI_API_KEY is not set, so no caller line exists`,
    );
  }
  const language = getVoice(input.voice)?.languageCode ?? "en";
  const text = CALLER_LINES[language] ?? CALLER_LINES.en;
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
// The two-turn flow
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
  sleep?: (ms: number) => Promise<void>;
  callId?: string;
};

type CallState = {
  captions: { role: "user" | "agent"; text: string; final: boolean }[];
  audioFrames: number;
  audioBytes: number;
  end: Record<string, unknown> | null;
  error: string | null;
  closed: boolean;
  configKeys: string[] | null;
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
const TURN_FRAME_BYTES = 4_800; // 100 ms of 24 kHz mono PCM16
const TURN_TAIL_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function pcmSilence(ms: number): Uint8Array {
  return new Uint8Array(Math.round((24_000 * 2 * ms) / 1_000));
}

function countAgentFinals(state: CallState): number {
  return state.captions.filter((caption) => caption.role === "agent" && caption.final).length;
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
 * audio frame has arrived for a short quiet window. A caller that talks over
 * the agent would barge in, which is a different test; this check is about two
 * clean turns. Bounded, so a stuck stream still ends the check by name.
 */
async function settleAudio(
  state: CallState,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
  label: string,
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
    if (Date.now() - quietSince >= 800) return;
  }
}

async function sendPaced(
  socket: RealLegsSocket,
  pcm: Uint8Array,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < pcm.length; offset += TURN_FRAME_BYTES) {
    const chunk = pcm.subarray(offset, offset + TURN_FRAME_BYTES);
    socket.send(encodeAudioFrame(chunk.slice().buffer));
    await sleep(100);
  }
  const silence = pcmSilence(TURN_TAIL_MS);
  for (let offset = 0; offset < silence.length; offset += TURN_FRAME_BYTES) {
    socket.send(encodeAudioFrame(silence.slice(offset, offset + TURN_FRAME_BYTES).buffer));
    await sleep(100);
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
  // Operational rows (a breaker transition, a budget crossing) carry `leg`
  // instead of `subject` by design. Every row must name the call; every row
  // that names a subject must name the demo subject, and at least one must.
  const wrongCall = lines.filter((line) => line.callId !== input.callId);
  const namedSubjects = lines.filter((line) => typeof line.subject === "string");
  const wrongSubject = namedSubjects.filter((line) => line.subject !== subject);
  const bindingOk =
    wrongCall.length === 0 && namedSubjects.length > 0 && wrongSubject.length === 0;
  const checks: RealLegsCheck[] = [
    bindingOk
      ? passed(
          "trace",
          "trace",
          `${input.eventsDir}/${input.callId}.jsonl: ${lines.length} lines, every one callId "${input.callId}" and ${namedSubjects.length} with subject "${subject}"`,
        )
      : failed(
          "trace",
          "trace-binding",
          `${wrongCall.length + wrongSubject.length} of ${lines.length} lines do not bind to callId "${input.callId}" and subject "${subject}"${
            namedSubjects.length === 0 ? " (no line names a subject at all)" : ""
          }: ${JSON.stringify(wrongCall[0] ?? wrongSubject[0]).slice(0, 240)}`,
        ),
  ];

  const priced = lines.find((line) => line.type === "cost.priced");
  if (!priced) {
    checks.push(failed("cost row", "cost-missing", "the trace has no cost.priced row"));
    return checks;
  }
  const measured = priced.measured === true;
  const version = priced.rateTableVersion;
  const total = priced.totalUsd;
  if (measured) {
    if (typeof total !== "number" || typeof version !== "string" || version.trim() === "") {
      checks.push(
        failed(
          "cost row",
          "cost-invalid",
          `a measured cost.priced row must carry a numeric totalUsd and its rate table version; got totalUsd=${JSON.stringify(total)}, rateTableVersion=${JSON.stringify(version)}`,
        ),
      );
    } else {
      checks.push(
        passed(
          "cost row",
          "cost",
          `cost.priced measured $${total} with ${version}`,
        ),
      );
    }
    return checks;
  }
  const reason = priced.unmeasuredReason;
  if (priced.measured !== false || typeof reason !== "string" || reason.trim() === "") {
    checks.push(
      failed(
        "cost row",
        "cost-invalid",
        `a cost.priced row must be measured or state an unmeasuredReason; got measured=${JSON.stringify(priced.measured)}, unmeasuredReason=${JSON.stringify(reason)}`,
      ),
    );
  } else {
    checks.push(
      passed("cost row", "cost", `cost.priced unmeasured: ${reason}`),
    );
  }
  return checks;
}

/**
 * Run the two-turn real-legs call and return every assertion in report order.
 *
 * One fatal step (the signed body, the delivery, the caller audio, the socket)
 * returns a single named failure; later checks are not invented. Once the call
 * is running, every assertion is recorded.
 */
export async function runRealLegs(
  options: RealLegsOptions,
  target: RealLegsTarget,
  deps: RealLegsDeps = {},
): Promise<RealLegsCheck[]> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const connect = deps.connect ?? defaultConnect;
  const loadAudio = deps.loadCallerAudio ?? loadCallerAudio;
  const traceExists = deps.traceExists ?? existsSync;
  const readTrace = deps.readTrace ?? ((path: string) => readFileSync(path, "utf8"));
  const callId = deps.callId ?? randomUUID();
  const checks: RealLegsCheck[] = [];

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

  const state: CallState = {
    captions: [],
    audioFrames: 0,
    audioBytes: 0,
    end: null,
    error: null,
    closed: false,
    configKeys: null,
  };
  let socket: RealLegsSocket;
  try {
    socket = connect(target.wsUrl);
  } catch (error) {
    checks.push(
      failed(
        "connect",
        "connect-failed",
        `could not open ${target.wsUrl}: ${(error as Error).message}`,
      ),
    );
    return checks;
  }

  const opened = new Promise<void>((resolvePromise) => socket.onOpen(() => resolvePromise()));
  socket.onMessage((raw) => {
    const audioFrame = decodeAudioMessage(raw);
    if (audioFrame) {
      state.audioFrames += 1;
      state.audioBytes += audioFrame.pcm.length;
      return;
    }
    const event = parseServerMessage(raw);
    if (!event) return;
    switch (event.kind) {
      case "caption":
        state.captions.push({ role: event.role, text: event.text, final: event.final });
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
    state.error = message;
  });
  socket.onClose(() => {
    state.closed = true;
  });

  try {
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
      callToken: call.callToken,
      agentId: call.agentId,
      protocolVersion: CASCADE_PROTOCOL_VERSION,
    });
    const configRecord = JSON.parse(config) as Record<string, unknown>;
    state.configKeys = Object.keys(configRecord).sort();
    socket.send(config);

    await waitFor(
      state,
      () => countAgentFinals(state) >= 1,
      options.timeoutMs,
      sleep,
      "greeting",
    );
    await settleAudio(state, sleep, options.timeoutMs, "greeting");

    const beforeTurnOne = countAgentFinals(state);
    await sendPaced(socket, audio.pcm, sleep);
    await waitFor(
      state,
      () => countAgentFinals(state) > beforeTurnOne,
      options.timeoutMs,
      sleep,
      "turn 1",
    );
    await settleAudio(state, sleep, options.timeoutMs, "turn 1");
    const agentFinalsAfterTurnOne = countAgentFinals(state);

    await sendPaced(socket, audio.pcm, sleep);
    await waitFor(
      state,
      () => countAgentFinals(state) > agentFinalsAfterTurnOne,
      options.timeoutMs,
      sleep,
      "turn 2",
    );
    await settleAudio(state, sleep, options.timeoutMs, "turn 2");

    socket.send(JSON.stringify({ type: "stop" }));
    await waitFor(state, () => state.end !== null, options.timeoutMs, sleep, "end message");
  } catch (error) {
    checks.push(
      failed(
        "call",
        (error as RealLegsError).code ?? "call-failed",
        `${(error as Error).name}: ${(error as Error).message}`,
      ),
    );
    socket.close();
    checks.push(
      ...assessTraceAfterCall(options, target, callId, traceExists, readTrace, null, env),
    );
    return checks;
  } finally {
    socket.close();
  }

  checks.push(
    passed(
      "identity config",
      "identity-config",
      `first frame carried only ${state.configKeys?.join(", ")} for "${call.agentId}"`,
    ),
  );

  const userFinals = state.captions.filter(
    (caption) => caption.role === "user" && caption.final,
  ).length;
  const agentFinals = countAgentFinals(state);
  const agentLines = state.captions
    .filter((caption) => caption.role === "agent" && caption.final)
    .map((caption) => caption.text);
  checks.push(
    userFinals >= 1 && agentFinals >= 3
      ? passed(
          "captions",
          "captions",
          `${userFinals} caller finals and ${agentFinals} agent finals (greeting plus two turns); first agent line: ${JSON.stringify(agentLines[0] ?? "").slice(0, 120)}`,
        )
      : failed(
          "captions",
          "captions",
          `expected at least one caller final and three agent finals (greeting plus two turns); got ${userFinals} caller and ${agentFinals} agent finals`,
        ),
  );

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
          `callId "${callId}" ended after ${endTurns} turns; cost ${endCost?.measured === true ? `measured $${String(endCost.totalUsd)}` : `unmeasured (${String(endCost?.unmeasuredReason ?? "")})`}`,
        )
      : failed(
          "end message",
          "end-message",
          `expected the end message for call "${callId}" with at least two turns and a measured-or-explained cost; got ${JSON.stringify(
            { callId: end.callId, turns: end.turns, cost: end.cost },
          ).slice(0, 300)}`,
        ),
  );

  checks.push(
    ...assessTraceAfterCall(
      options,
      target,
      callId,
      traceExists,
      readTrace,
      typeof end.eventsPath === "string" ? end.eventsPath : null,
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
