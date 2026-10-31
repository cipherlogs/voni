/**
 * Ticket 23's take store: the one place a Studio take becomes a hash.
 *
 * A take is written once and read back by hash. There is no update method and
 * no delete: re-recording appends a new take that names the one it supersedes,
 * so the earlier hash stays resolvable for ever. Audio is content-addressed by
 * the same digest ticket 10's corpus loader verifies, and every read rehashes
 * the bytes — a changed file is a named refusal, never a quiet re-baseline.
 *
 * The store is local-only working state (`voni/.studio/`, gitignored). A take
 * joins a committed corpus only when a human promotes it deliberately; this
 * module never edits a committed corpus.
 */

import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { sha256Hex } from "../../src/lib/demo/verification/scenarios/digest";

/** The record shape every `take.json` carries. */
export const TAKE_SCHEMA_VERSION = 1;

/** How a take arrived: a one-shot line, a dialogue line, or an uploaded file. */
export const RECORD_MODES = ["one-shot", "dialogue", "upload"] as const;

export type RecordMode = (typeof RECORD_MODES)[number];

/** The three labels the spec requires on every take. */
export const LABEL_FIELDS = ["intent", "emotion", "accent"] as const;

export type LabelField = (typeof LABEL_FIELDS)[number];

export type TakeLabels = Record<LabelField, string>;

/** The card a one-shot line or one dialogue turn is recorded against. */
export type PromptCard = {
  /** The dialogue script's name, for a dialogue turn. */
  readonly dialogue?: string;
  /** The line's id inside that script, for a dialogue turn. */
  readonly line?: string;
  /** 1-based turn position inside that script, for a dialogue turn. */
  readonly turn?: number;
  /** The words the caller is asked to read. */
  readonly text: string;
};

export type TakeSource =
  | { readonly mode: "one-shot"; readonly prompt: PromptCard }
  | { readonly mode: "dialogue"; readonly prompt: PromptCard }
  | {
      readonly mode: "upload";
      readonly upload: { readonly filename: string; readonly contentType?: string };
    };

/** What the Record surface hands the store. */
export type TakeInput = TakeSource & {
  readonly audio: Uint8Array;
  readonly labels: TakeLabels;
  /** The take this one replaces; the earlier record is never touched. */
  readonly supersedes?: string;
  /** ISO timestamp; defaults to the moment the take lands. */
  readonly recordedAt?: string;
};

/** The landed record, immutable by convention and by write-once storage. */
export type TakeRecord = {
  readonly schemaVersion: typeof TAKE_SCHEMA_VERSION;
  readonly takeId: string;
  readonly audioSha256: string;
  readonly audioBytes: number;
  readonly audioFormat: AudioFormat;
  /** Path relative to the store root. */
  readonly audioPath: string;
  readonly labels: TakeLabels;
  readonly source: TakeSource;
  readonly recordedAt: string;
  readonly supersedes?: string;
};

export const AUDIO_FORMATS = ["wav", "webm", "ogg", "mp3", "m4a"] as const;

export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/** `demo:verify`'s refusal exit code; the Studio speaks the same code. */
export const STUDIO_REFUSAL_EXIT_CODE = 2;

export type StudioErrorCode =
  | "invalid-store-root"
  | "missing-label"
  | "unknown-label"
  | "invalid-label"
  | "missing-prompt"
  | "invalid-prompt"
  | "missing-upload"
  | "empty-take"
  | "oversized-take"
  | "unsupported-audio"
  | "unknown-take"
  | "already-superseded"
  | "take-drift"
  | "record-drift"
  | "malformed-take"
  | "malformed-dialogue"
  | "unreadable-dialogue"
  | "studio-not-local"
  | "method-not-allowed"
  | "unknown-route"
  | "invalid-body"
  | "surface-missing"
  | "studio-io";

export class StudioError extends Error {
  readonly code: StudioErrorCode;
  readonly exitCode = STUDIO_REFUSAL_EXIT_CODE;

  constructor(code: StudioErrorCode, message: string) {
    super(message);
    this.name = "StudioError";
    this.code = code;
  }
}

/** One take may not be larger than this; the Record surface records speech, not sessions. */
const MAX_TAKE_BYTES = 25 * 1024 * 1024;

const TAKE_ID = /^take-(\d{6})$/;
const TAKES_DIR = "takes";
const BLOBS_DIR = "blobs";
const RECORD_FILE = "take.json";

const FORMAT_CONTENT_TYPE: Record<AudioFormat, string> = {
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
};

export function contentTypeFor(format: AudioFormat): string {
  return FORMAT_CONTENT_TYPE[format];
}

/** Sniff the container by its magic bytes; an unknown container is refused by name. */
export function sniffAudioFormat(bytes: Uint8Array): AudioFormat {
  const ascii = (start: number, length: number): string =>
    Buffer.from(bytes.subarray(start, start + length)).toString("ascii");
  if (bytes.byteLength >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (bytes.byteLength >= 4 && ascii(0, 4) === "OggS") return "ogg";
  if (bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "webm";
  }
  if (bytes.byteLength >= 12 && ascii(4, 4) === "ftyp") return "m4a";
  if (bytes.byteLength >= 3 && ascii(0, 3) === "ID3") return "mp3";
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3";
  throw new StudioError(
    "unsupported-audio",
    `the take is not a WAV, WebM, Ogg, MP3 or M4A file (first bytes ${Buffer.from(bytes.subarray(0, 8)).toString("hex") || "none"}); ` +
      "record or upload caller audio in a supported container",
  );
}

function trimmedLabel(labels: Record<string, unknown>, field: LabelField): string {
  if (!(field in labels)) {
    throw new StudioError("missing-label", `the take has no "${field}" label; every take is labelled at landing, never defaulted`);
  }
  const value = labels[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StudioError("invalid-label", `the take's "${field}" label must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 120 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new StudioError("invalid-label", `the take's "${field}" label must be 1–120 printable characters: ${JSON.stringify(trimmed)}`);
  }
  return trimmed;
}

function parseLabels(value: unknown): TakeLabels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StudioError("invalid-label", "labels must be an object with intent, emotion and accent");
  }
  const labels = value as Record<string, unknown>;
  for (const key of Object.keys(labels)) {
    if (!(LABEL_FIELDS as readonly string[]).includes(key)) {
      throw new StudioError("unknown-label", `unknown label "${key}"; a take carries exactly ${LABEL_FIELDS.join(", ")}`);
    }
  }
  return {
    intent: trimmedLabel(labels, "intent"),
    emotion: trimmedLabel(labels, "emotion"),
    accent: trimmedLabel(labels, "accent"),
  };
}

function parsePrompt(value: unknown, mode: "one-shot" | "dialogue"): PromptCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StudioError("missing-prompt", `a ${mode} take needs its prompt card: the words the caller is asked to read`);
  }
  const prompt = value as Record<string, unknown>;
  if (typeof prompt.text !== "string" || prompt.text.trim().length === 0) {
    throw new StudioError("missing-prompt", `a ${mode} take's prompt card has no text`);
  }
  const card: PromptCard = { text: prompt.text.trim() };
  if (mode === "dialogue") {
    for (const field of ["dialogue", "line"] as const) {
      const fieldValue = prompt[field];
      if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
        throw new StudioError("invalid-prompt", `a dialogue take's prompt card has no "${field}"`);
      }
    }
    if (typeof prompt.turn !== "number" || !Number.isInteger(prompt.turn) || prompt.turn < 1) {
      throw new StudioError("invalid-prompt", "a dialogue take's prompt card has no 1-based turn number");
    }
    return {
      dialogue: String(prompt.dialogue).trim(),
      line: String(prompt.line).trim(),
      turn: prompt.turn,
      text: card.text,
    };
  }
  return card;
}

function parseSource(value: unknown, mode: RecordMode): TakeSource {
  if (mode === "upload") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new StudioError("missing-upload", "an uploaded take needs the file's name");
    }
    const upload = value as Record<string, unknown>;
    if (typeof upload.filename !== "string" || upload.filename.trim().length === 0) {
      throw new StudioError("missing-upload", "an uploaded take needs the file's name");
    }
    const source: TakeSource = {
      mode: "upload",
      upload: {
        filename: basename(upload.filename.trim()),
        ...(typeof upload.contentType === "string" && upload.contentType.trim()
          ? { contentType: upload.contentType.trim() }
          : {}),
      },
    };
    return source;
  }
  return { mode, prompt: parsePrompt(value, mode) };
}

function parseRecordedAt(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new StudioError("malformed-take", `recordedAt must be an ISO timestamp, got ${JSON.stringify(value)}`);
  }
  return new Date(value).toISOString();
}

/** Strict reader: a record that carries a field this schema did not write is refused. */
function parseTakeRecord(raw: unknown, from: string): TakeRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StudioError("malformed-take", `${from} is not a take record`);
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== TAKE_SCHEMA_VERSION) {
    throw new StudioError("malformed-take", `${from} has schema version ${String(record.schemaVersion)}; this store writes ${TAKE_SCHEMA_VERSION}`);
  }
  const takeId = record.takeId;
  if (typeof takeId !== "string" || !TAKE_ID.test(takeId)) {
    throw new StudioError("malformed-take", `${from} has an invalid take id ${JSON.stringify(takeId)}`);
  }
  const audioSha256 = record.audioSha256;
  if (typeof audioSha256 !== "string" || !/^[0-9a-f]{64}$/.test(audioSha256)) {
    throw new StudioError("malformed-take", `${from} has an invalid sha256 ${JSON.stringify(audioSha256)}`);
  }
  if (typeof record.audioBytes !== "number" || !Number.isInteger(record.audioBytes) || record.audioBytes <= 0) {
    throw new StudioError("malformed-take", `${from} has an invalid byte count`);
  }
  if (!(AUDIO_FORMATS as readonly unknown[]).includes(record.audioFormat)) {
    throw new StudioError("malformed-take", `${from} has an unknown audio format ${JSON.stringify(record.audioFormat)}`);
  }
  if (typeof record.audioPath !== "string" || record.audioPath !== `${BLOBS_DIR}/${audioSha256}.${record.audioFormat}`) {
    throw new StudioError("malformed-take", `${from} names an audio path that is not its content address`);
  }
  if (typeof record.source !== "object" || record.source === null) {
    throw new StudioError("malformed-take", `${from} has no source`);
  }
  const source = record.source as Record<string, unknown>;
  if (!(RECORD_MODES as readonly unknown[]).includes(source.mode)) {
    throw new StudioError("malformed-take", `${from} has an unknown record mode ${JSON.stringify(source.mode)}`);
  }
  const mode = source.mode as RecordMode;
  const parsedSource =
    mode === "upload"
      ? parseSource({ filename: (source.upload as Record<string, unknown> | undefined)?.filename, contentType: (source.upload as Record<string, unknown> | undefined)?.contentType }, "upload")
      : parseSource(source.prompt, mode);
  const supersedes = record.supersedes;
  if (supersedes !== undefined && (typeof supersedes !== "string" || !TAKE_ID.test(supersedes))) {
    throw new StudioError("malformed-take", `${from} has an invalid supersedes id ${JSON.stringify(supersedes)}`);
  }
  return {
    schemaVersion: TAKE_SCHEMA_VERSION,
    takeId,
    audioSha256,
    audioBytes: record.audioBytes,
    audioFormat: record.audioFormat as AudioFormat,
    audioPath: record.audioPath,
    labels: parseLabels(record.labels),
    source: parsedSource,
    recordedAt: parseRecordedAt(record.recordedAt),
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}

async function mkdirp(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    throw new StudioError("studio-io", `cannot create the Studio directory ${path}: ${errorText(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write a file that must not already exist; never truncate an existing take. */
async function writeNew(path: string, bytes: Uint8Array | string): Promise<void> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StudioError("take-drift", `${path} already exists; a take is written once and never overwritten`);
    }
    throw new StudioError("studio-io", `cannot write ${path}: ${errorText(error)}`);
  }
}

export type TakeStore = {
  readonly root: string;
  /** Write one take and return its immutable record. */
  land(input: TakeInput): Promise<TakeRecord>;
  /** Every landed take, newest id first. */
  list(): Promise<TakeRecord[]>;
  /** One take by id, or `null`; never a guess. */
  get(takeId: string): Promise<TakeRecord | null>;
  /** The record and the exact bytes, rehashed before they are returned. */
  read(takeId: string): Promise<{ record: TakeRecord; bytes: Buffer }>;
  /** Rehash every take; a changed blob or record is a named refusal. */
  verify(): Promise<{ takes: number; bytes: number }>;
};

export type OpenTakeStoreOptions = {
  /** Directory holding `takes/` and `blobs/`; `voni/.studio` in normal use. */
  readonly root: string;
  /** Injectable clock; tests pin it and production uses the wall clock. */
  readonly now?: () => Date;
};

export async function openTakeStore(options: OpenTakeStoreOptions): Promise<TakeStore> {
  if (typeof options.root !== "string" || options.root.trim().length === 0) {
    throw new StudioError("invalid-store-root", "the Studio store needs a root directory");
  }
  const root = resolve(options.root);
  const takesDir = join(root, TAKES_DIR);
  const blobsDir = join(root, BLOBS_DIR);
  await mkdirp(takesDir);
  await mkdirp(blobsDir);

  const now = options.now ?? (() => new Date());

  async function takeIds(): Promise<string[]> {
    const entries = await readdir(takesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && TAKE_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  async function readRecord(takeId: string): Promise<TakeRecord | null> {
    if (!TAKE_ID.test(takeId)) {
      throw new StudioError("unknown-take", `"${takeId}" is not a take id; takes are named take-000001 and upward`);
    }
    const path = join(takesDir, takeId, RECORD_FILE);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StudioError("studio-io", `cannot read ${path}: ${errorText(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new StudioError("record-drift", `${path} is not valid JSON: ${errorText(error)}`);
    }
    const record = parseTakeRecord(parsed, path);
    if (record.takeId !== takeId) {
      throw new StudioError("record-drift", `${path} is recorded as ${record.takeId}; the directory and the record disagree`);
    }
    return record;
  }

  async function list(): Promise<TakeRecord[]> {
    const records: TakeRecord[] = [];
    for (const takeId of (await takeIds()).reverse()) {
      const record = await readRecord(takeId);
      if (record) records.push(record);
    }
    return records;
  }

  async function get(takeId: string): Promise<TakeRecord | null> {
    return readRecord(takeId);
  }

  async function read(takeId: string): Promise<{ record: TakeRecord; bytes: Buffer }> {
    const record = await readRecord(takeId);
    if (!record) {
      throw new StudioError("unknown-take", `take "${takeId}" is not in the store; an earlier take is never silently dropped`);
    }
    const path = join(root, record.audioPath);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw new StudioError("take-drift", `take "${takeId}" names ${path}, which cannot be read: ${errorText(error)}`);
    }
    const actual = sha256Hex(bytes);
    if (actual !== record.audioSha256 || bytes.byteLength !== record.audioBytes) {
      throw new StudioError(
        "take-drift",
        `take "${takeId}" changed on disk: recorded sha256 ${record.audioSha256} (${record.audioBytes} bytes), ` +
          `file ${path} is ${actual} (${bytes.byteLength} bytes). A take is never edited in place; record a new take.`,
      );
    }
    return { record, bytes };
  }

  async function land(input: TakeInput): Promise<TakeRecord> {
    const { audio } = input;
    if (audio.byteLength === 0) {
      throw new StudioError("empty-take", "the take is empty; there is nothing to speak and no hash to keep");
    }
    if (audio.byteLength > MAX_TAKE_BYTES) {
      throw new StudioError("oversized-take", `the take is ${audio.byteLength} bytes; the Studio keeps takes up to ${MAX_TAKE_BYTES}`);
    }
    const format = sniffAudioFormat(audio);
    const labels = parseLabels(input.labels);
    const source = parseSource(
      input.mode === "upload" ? input.upload : input.prompt,
      input.mode,
    );
    const recordedAt = parseRecordedAt(input.recordedAt ?? now().toISOString());
    const sha256 = sha256Hex(audio);

    if (input.supersedes !== undefined) {
      const prior = await readRecord(input.supersedes);
      if (!prior) {
        throw new StudioError("unknown-take", `cannot re-record "${input.supersedes}": no such take in the store`);
      }
      for (const record of await list()) {
        if (record.supersedes === input.supersedes) {
          throw new StudioError(
            "already-superseded",
            `take "${input.supersedes}" was already re-recorded as ${record.takeId}; re-record the latest take so the lineage stays one line`,
          );
        }
      }
    }

    const ids = await takeIds();
    const next = ids.length === 0 ? 1 : Number(TAKE_ID.exec(ids[ids.length - 1])![1]) + 1;
    const takeId = `take-${String(next).padStart(6, "0")}`;

    const audioPath = `${BLOBS_DIR}/${sha256}.${format}`;
    const record: TakeRecord = {
      schemaVersion: TAKE_SCHEMA_VERSION,
      takeId,
      audioSha256: sha256,
      audioBytes: audio.byteLength,
      audioFormat: format,
      audioPath,
      labels,
      source,
      recordedAt,
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    };

    const blobPath = join(root, audioPath);
    try {
      // Same bytes already landed: the content address exists, so verify it
      // rather than rewriting it.
      await stat(blobPath);
      const existing = await readFile(blobPath);
      if (sha256Hex(existing) !== sha256 || existing.byteLength !== audio.byteLength) {
        throw new StudioError("take-drift", `${blobPath} is named by its hash but its bytes no longer match it`);
      }
    } catch (error) {
      if (error instanceof StudioError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new StudioError("studio-io", `cannot read ${blobPath}: ${errorText(error)}`);
      }
      await writeNew(blobPath, audio);
    }

    const takeDir = join(takesDir, takeId);
    await mkdirp(takeDir);
    await writeNew(join(takeDir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  async function verify(): Promise<{ takes: number; bytes: number }> {
    const records = await list();
    let bytes = 0;
    for (const record of records) {
      const taken = await read(record.takeId);
      bytes += taken.bytes.byteLength;
    }
    return { takes: records.length, bytes };
  }

  return { root, land, list, get, read, verify };
}
