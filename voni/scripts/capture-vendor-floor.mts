/**
 * W0 vendor floor — capture the vendor's own rendering of one line in one
 * voice, and register it as the committed floor every subject must clear.
 *
 *   npm run voice:vendor-floor -- --voice anna --locale en
 *   npm run voice:vendor-floor -- --from-recording ~/playground-anna.wav \
 *     --captured-on 2026-10-29 --produced-by "dashboard TTS playground, Chrome tab capture"
 *
 * Two capture paths, and the sidecar says which one produced the file:
 *
 * - `vendor-tts-http` (default): the vendor's text-to-speech engine over its
 *   HTTP API, buffered PCM16 WAV. No client, platform or model in the path, so
 *   the file is the vendor's rendering and the script can reproduce it.
 * - `playground-recording`: a human capture of the vendor's browser
 *   playground. The owner supplies the file and states how it was made; the
 *   script normalises it to mono 24 kHz PCM16 WAV and records the rest.
 *
 * The floor is committed evidence, never generated during a live run. A
 * recapture is a new evidence record, so an existing floor is refused unless
 * `--force` is passed and the commit message says why. The written pair is
 * loaded back through the same loader the comparison uses before the script
 * reports success.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getVoice } from "../src/lib/agents/voices";
import { VONI_GREETINGS } from "../src/lib/demo/voni-agent";
import {
  VENDOR_FLOOR_DIR,
  VENDOR_FLOOR_LOCALE,
  VENDOR_FLOOR_SCHEMA_VERSION,
  VENDOR_FLOOR_VOICE,
  VendorFloorError,
  formatVendorFloor,
  loadVendorFloor,
  vendorFloorFileName,
  type VendorFloorMethod,
  type VendorFloorProvenance,
} from "../src/lib/audio/vendor-floor";

const SAMPLE_RATE = 24_000;
const VENDOR_HOST = "https://tts.us.assemblyai.com";
const VENDOR = "assemblyai";

/** The vendor's language names, as `/v1/speech` spells them. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "english",
  es: "spanish",
  fr: "french",
  de: "german",
  it: "italian",
  pt: "portuguese",
};

const USAGE = `Usage: npm run voice:vendor-floor -- [options]

  --voice <id>            catalog voice, default ${VENDOR_FLOOR_VOICE}
  --locale <code>         the voice's own language, default ${VENDOR_FLOOR_LOCALE}
  --line <text>           line to speak, default that Locale's Voni greeting
  --out-dir <dir>         evidence directory, default voni/evidence/vendor-floor
  --force                 replace an existing floor (a new evidence record)

Owner-supplied playground capture (the vendor's browser playground):
  --from-recording <file>      audio file to normalise to mono 24 kHz PCM16 WAV
  --captured-on <YYYY-MM-DD>   the day the human captured it
  --produced-by <sentence>     exactly how it was captured

Default path, the vendor's text-to-speech engine over HTTP (needs
ASSEMBLYAI_API_KEY): writes the buffered WAV the engine returns, no client in
the path.`;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function fail(message: string): never {
  console.error(`vendor floor capture failed: ${message}`);
  process.exit(1);
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Capture = {
  bytes: Buffer;
  method: VendorFloorMethod;
  producedBy: string;
  vendor: VendorFloorProvenance["vendor"];
  capturedOn: string;
};

/** The default path: the vendor renders the line over its own HTTP API. */
async function captureFromVendor(input: {
  voice: string;
  locale: string;
  line: string;
}): Promise<Capture> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    fail("ASSEMBLYAI_API_KEY missing: run with --env-file-if-exists=.dev.vars, or pass --from-recording");
  }
  const language = LANGUAGE_NAMES[input.locale];
  if (!language) fail(`no vendor language name for locale ${input.locale}`);

  const voiceId = `aai-${input.voice}`;
  const response = await fetch(`${VENDOR_HOST}/v1/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: input.line,
      voice_id: voiceId,
      language,
      sample_rate: SAMPLE_RATE,
      encoding: "pcm_s16le",
      container: "wav",
      stream: false,
    }),
  });
  if (!response.ok) {
    fail(`/v1/speech ${response.status}: ${await response.text()}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("audio/wav")) {
    fail(`/v1/speech answered ${contentType || "no content type"}, expected audio/wav`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) fail("/v1/speech answered 200 with no audio");

  const requestId = response.headers.get("x-request-id") ?? "unreported";
  return {
    bytes,
    method: "vendor-tts-http",
    producedBy:
      `POST ${VENDOR_HOST}/v1/speech with stream=false, container=wav, encoding=pcm_s16le, ` +
      `sample_rate=${SAMPLE_RATE}, language=${language} (request ${requestId})`,
    vendor: {
      name: VENDOR,
      voiceId: response.headers.get("x-tts-voice-id") ?? voiceId,
      model: response.headers.get("x-tts-model") ?? "unreported",
    },
    capturedOn: today(),
  };
}

/** The owner's path: a browser capture, normalised to what the comparison reads. */
function captureFromRecording(input: {
  recording: string;
  voice: string;
  capturedOn: string | undefined;
  producedBy: string | undefined;
}): Capture {
  const capturedOn = input.capturedOn;
  if (!capturedOn) fail("--captured-on YYYY-MM-DD is required with --from-recording");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(capturedOn)) {
    fail(`--captured-on must be YYYY-MM-DD, got ${capturedOn}`);
  }
  const producedBy = input.producedBy;
  if (!producedBy) {
    fail(
      "--produced-by is required with --from-recording: state exactly how the file was captured " +
        "(browser, tab capture, date, who did it)",
    );
  }

  const source = resolve(input.recording);
  if (!existsSync(source)) fail(`--from-recording file not found: ${source}`);

  const scratch = mkdtempSync(join(tmpdir(), "vendor-floor-capture-"));
  const normalised = join(scratch, "normalised.wav");
  try {
    execFileSync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", normalised],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const bytes = readFileSync(normalised);
    return {
      bytes,
      method: "playground-recording",
      producedBy,
      vendor: { name: VENDOR, voiceId: `aai-${input.voice}`, model: "not reported by the recording" },
      capturedOn,
    };
  } catch (error) {
    fail(
      `could not normalise ${source} with ffmpeg: ${error instanceof Error ? error.message : String(error)}. ` +
        "Supply a file ffmpeg can read, or convert it to mono 24 kHz PCM16 WAV first.",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (flag("--help")) {
    console.log(USAGE);
    return;
  }

  const voice = arg("--voice") ?? VENDOR_FLOOR_VOICE;
  const locale = arg("--locale") ?? VENDOR_FLOOR_LOCALE;
  const directory = resolve(arg("--out-dir") ?? VENDOR_FLOOR_DIR);
  const fileName = vendorFloorFileName(voice, locale);
  const audioPath = join(directory, fileName);
  const sidecarPath = join(directory, fileName.replace(/\.wav$/, ".json"));

  const entry = getVoice(voice);
  if (!entry) fail(`unknown voice ${voice}: not in the catalog (src/lib/agents/voices.ts)`);
  if (entry.languageCode !== locale) {
    fail(`voice ${voice} speaks ${entry.language}, not ${locale}: a voice speaks exactly one Locale`);
  }
  const line = arg("--line") ?? VONI_GREETINGS[locale];
  if (!line) fail(`no greeting for locale ${locale}: pass --line`);

  if (!flag("--force") && (existsSync(audioPath) || existsSync(sidecarPath))) {
    fail(
      `vendor floor already recorded at ${audioPath}. A recapture is a new evidence record: ` +
        "pass --force and say why in the commit message.",
    );
  }

  const recording = arg("--from-recording");
  const capture = recording
    ? captureFromRecording({
        recording,
        voice,
        capturedOn: arg("--captured-on"),
        producedBy: arg("--produced-by"),
      })
    : await captureFromVendor({ voice, locale, line });

  const provenance: VendorFloorProvenance = {
    schemaVersion: VENDOR_FLOOR_SCHEMA_VERSION,
    voice,
    locale,
    line,
    capturedOn: capture.capturedOn,
    producedBy: capture.producedBy,
    method: capture.method,
    vendor: capture.vendor,
    audio: {
      file: fileName,
      sha256: sha256(capture.bytes),
      container: "wav",
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
    },
  };

  mkdirSync(directory, { recursive: true });
  writeFileSync(audioPath, capture.bytes);
  writeFileSync(sidecarPath, `${JSON.stringify(provenance, null, 2)}\n`);

  try {
    const floor = loadVendorFloor({ directory, voice, locale });
    console.log(formatVendorFloor(floor));
  } catch (error) {
    const reason =
      error instanceof VendorFloorError ? `${error.code}: ${error.message}` : String(error);
    fail(`wrote ${audioPath} but it does not load: ${reason}`);
  }

  console.log(`\ncommit both files with the capture:\n  ${audioPath}\n  ${sidecarPath}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
