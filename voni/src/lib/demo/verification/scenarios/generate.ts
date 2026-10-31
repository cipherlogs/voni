/**
 * The caller-take generator: real TTS words, committed as WAV plus sha256.
 *
 * The corpus is data plus this tool. A take is generated once, hashed, and
 * committed; running the generator again over a recorded take changes nothing.
 * A byte that no longer matches its declared digest is a refusal that names the
 * scenario, the take and the exact `--retake` that would make the change
 * deliberate, so a certificate can never compare against audio nobody pinned.
 *
 * The vendor seam is injected: tests generate tones without a key, and the
 * script supplies Cartesia. No key is read, logged or written here.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Caller corpus and Studio" and
 * "Scenario corpus and Locale matrix"; prior art for a fixed caller clip is
 * `voni/scripts/eval-demo-agent.mts`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { sha256Hex } from "./digest";
import { ScenarioError } from "./errors";
import { LOCALES, type Locale, type ScenarioDocument, type ScenarioTake } from "./types";

/** A take whose digest has not been recorded yet. It is never a valid commit. */
export const UNHASHED_TAKE_SHA256 = "0".repeat(64);

/** Every take the generator produces is the pipeline's ingress format. */
export const TAKE_SAMPLE_RATE = 24_000;

/** The Cartesia caller voice and model the committed English takes name. */
export const CALLER_VOICE = {
  id: "efa653e5-314d-46ca-9f90-70ac7d6ca71e",
  name: "Kurt - Phone Support",
  modelId: "sonic-3.6",
  language: "en",
} as const;

export const CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/sse";
export const CARTESIA_VERSION = "2024-06-10";

export type TakeState = "missing" | "unhashed" | "recorded" | "drift";

export type TakeGenerationPlan = {
  readonly scenario: string;
  readonly take: string;
  readonly audio: string;
  readonly text: string;
  readonly declaredSha256: string;
  readonly actualSha256: string | null;
  readonly state: TakeState;
  /** What `--retake` must name to replace this take. */
  readonly retake: string;
};

function containment(scenarioDir: string, audio: string): string {
  const path = resolve(scenarioDir, audio);
  if (path !== scenarioDir && !path.startsWith(`${scenarioDir}${sep}`)) {
    throw new ScenarioError(
      "unsafe-take-path",
      `take audio "${audio}" resolves outside its scenario directory: ${path}`,
    );
  }
  return path;
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ScenarioError(
      "unreadable-corpus",
      `cannot read take ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Classify every declared take without writing anything. */
export async function planTakeGeneration(
  scenarioDir: string,
  document: ScenarioDocument,
): Promise<readonly TakeGenerationPlan[]> {
  const plan: TakeGenerationPlan[] = [];
  for (const take of document.takes) {
    const path = containment(scenarioDir, take.audio);
    const bytes = await readIfPresent(path);
    const actualSha256 = bytes === null ? null : sha256Hex(bytes);
    const state: TakeState =
      bytes === null
        ? take.sha256 === UNHASHED_TAKE_SHA256
          ? "unhashed"
          : "missing"
        : take.sha256 === UNHASHED_TAKE_SHA256
          ? "unhashed"
          : actualSha256 === take.sha256
            ? "recorded"
            : "drift";
    plan.push({
      scenario: document.name,
      take: take.id,
      audio: take.audio,
      text: take.text ?? "",
      declaredSha256: take.sha256,
      actualSha256,
      state,
      retake: `${document.name}/${take.id}`,
    });
  }
  return plan;
}

/** A PCM16LE mono 24 kHz WAV around raw vendor bytes. */
export function wavFromPcm(pcm: Uint8Array, sampleRate = TAKE_SAMPLE_RATE): Buffer {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new ScenarioError(
      "invalid-audio",
      `the synthesized take is ${pcm.byteLength} bytes; PCM16 needs a non-empty, even byte count`,
    );
  }
  const bytes = Buffer.alloc(44 + pcm.byteLength);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + pcm.byteLength, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm).copy(bytes, 44);
  return bytes;
}

/**
 * Cartesia's SSE body: `data: {"data": "<base64 PCM>", ...}` chunk events,
 * `[DONE]`, and error events. A malformed body is a refusal, never silence.
 */
export function parseCartesiaSse(body: string): Uint8Array {
  const chunks: Buffer[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof payload !== "object" || payload === null) continue;
    const record = payload as Record<string, unknown>;
    if (record.error !== undefined) {
      throw new ScenarioError(
        "tts-failed",
        `Cartesia returned an error: ${String(record.error)}`,
      );
    }
    if (record.done === true) continue;
    const audio = record.data;
    if (typeof audio !== "string" || audio === "") continue;
    try {
      chunks.push(Buffer.from(audio, "base64"));
    } catch {
      throw new ScenarioError("tts-failed", "Cartesia returned audio that is not base64");
    }
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.byteLength === 0) {
    throw new ScenarioError(
      "tts-failed",
      "Cartesia returned no audio for the take; an empty take is never committed",
    );
  }
  return pcm;
}

export type TakeGenerator = (text: string) => Promise<Uint8Array>;

export type TakeGenerationResult = {
  readonly document: ScenarioDocument;
  readonly plan: readonly TakeGenerationPlan[];
  readonly wrote: number;
  /** True when a previously recorded take was deliberately replaced. */
  readonly retaken: boolean;
  /** The manifest version move a retake carries, so comparability is explicit. */
  readonly versionBump: number;
};

function validateText(document: ScenarioDocument): void {
  for (const take of document.takes) {
    if (take.text === undefined || take.text.trim() === "") {
      throw new ScenarioError(
        "missing-field",
        `scenario "${document.name}" take "${take.id}" has no text; a take with nothing to say ` +
          "is not synthesized. Add the words the caller speaks.",
      );
    }
  }
}

/**
 * Synthesize and record the takes that are new or explicitly retaken.
 *
 * Two phases, deliberately: every clip is synthesized before any file is
 * written, so a vendor failure cannot leave a scenario half-retaken. A drift
 * with no `--retake` writes nothing at all.
 */
export async function applyTakeGeneration(input: {
  readonly scenarioDir: string;
  readonly document: ScenarioDocument;
  readonly synthesize: TakeGenerator;
  readonly retake?: ReadonlySet<string>;
  readonly write?: boolean;
}): Promise<TakeGenerationResult> {
  validateText(input.document);
  const plan = await planTakeGeneration(input.scenarioDir, input.document);
  const requested = input.retake ?? new Set<string>();
  const known = new Set(plan.map((entry) => entry.retake));
  for (const key of requested) {
    if (!known.has(key)) {
      throw new ScenarioError(
        "unknown-take",
        `--retake names "${key}", which is not a take in scenario "${input.document.name}"; ` +
          `takes: ${plan.map((entry) => entry.retake).join(", ")}`,
      );
    }
  }

  const toRecord = plan.filter(
    (entry) =>
      entry.state === "unhashed" ||
      requested.has(entry.retake) ||
      (entry.state === "drift" && requested.has(entry.retake)),
  );

  for (const entry of plan) {
    if (entry.state === "drift" && !requested.has(entry.retake)) {
      throw new ScenarioError(
        "take-drift",
        `scenario "${entry.scenario}" take "${entry.take}" changed: declared sha256 ` +
          `${entry.declaredSha256}, file is ${entry.actualSha256}. ` +
          `Retaking a line means running with --retake ${entry.retake} deliberately.`,
      );
    }
    if (entry.state === "missing") {
      if (requested.has(entry.retake)) continue;
      throw new ScenarioError(
        "missing-take",
        `scenario "${entry.scenario}" take "${entry.take}" is missing at ${entry.audio} but ` +
          `declares sha256 ${entry.declaredSha256}; restore the committed take or ` +
          `--retake ${entry.retake}`,
      );
    }
  }

  const synthesized: { entry: TakeGenerationPlan; wav: Buffer }[] = [];
  for (const entry of toRecord) {
    // A requested retake of a take already recorded is the only case that moves
    // comparability; recording a take for the first time is the corpus being
    // created, not a retake.
    const pcm = await input.synthesize(entry.text);
    synthesized.push({ entry, wav: wavFromPcm(pcm) });
  }

  if (input.write !== false) {
    for (const { entry, wav } of synthesized) {
      const path = containment(input.scenarioDir, entry.audio);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, wav);
    }
  }

  const digests = new Map(synthesized.map(({ entry, wav }) => [entry.take, sha256Hex(wav)]));
  const takes: ScenarioTake[] = input.document.takes.map((take) => {
    const digest = digests.get(take.id);
    return digest === undefined ? take : { ...take, sha256: digest };
  });
  const previous = new Set(
    plan.filter((entry) => requested.has(entry.retake) && entry.declaredSha256 !== UNHASHED_TAKE_SHA256)
      .map((entry) => entry.take),
  );
  const retaken = synthesized.some(({ entry }) => previous.has(entry.take));

  return {
    document: { ...input.document, takes },
    plan,
    wrote: synthesized.length,
    retaken,
    versionBump: retaken ? 1 : 0,
  };
}

/** The one Cartesia request the generator makes; the key is never logged. */
export async function synthesizeCartesia(input: {
  readonly text: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  /** The Locale the words are spoken in; omitted keeps the English caller voice. */
  readonly language?: Locale;
}): Promise<Uint8Array> {
  if (input.apiKey.trim() === "") {
    throw new ScenarioError("tts-failed", "CARTESIA_API_KEY is not set; no take is synthesized");
  }
  const language = input.language ?? CALLER_VOICE.language;
  if (!(LOCALES as readonly string[]).includes(language)) {
    throw new ScenarioError(
      "tts-failed",
      `"${String(language)}" is not a caller Locale; known: ${LOCALES.join(", ")}`,
    );
  }
  const request = input.fetch ?? globalThis.fetch;
  const response = await request(CARTESIA_TTS_URL, {
    method: "POST",
    headers: {
      "X-API-Key": input.apiKey,
      "Cartesia-Version": CARTESIA_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model_id: CALLER_VOICE.modelId,
      transcript: input.text,
      voice: { mode: "id", id: CALLER_VOICE.id },
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: TAKE_SAMPLE_RATE,
      },
      language,
    }),
  });
  if (!response.ok) {
    throw new ScenarioError(
      "tts-failed",
      `Cartesia returned ${response.status} ${response.statusText} for take "${input.text}"`,
    );
  }
  return parseCartesiaSse(await response.text());
}
