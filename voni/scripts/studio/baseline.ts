/**
 * Ticket 25's human-baseline verifier: the owner records, this command proves
 * the record is complete and still the one that was hashed.
 *
 * The baseline is three to five consenting people, two calls of four to six
 * minutes each, used only as blind comparison audio. No agent can record it, so
 * this module checks what a human produced:
 *
 * - every active baseline take has a consent reference filed beside the takes,
 *   and the file names the participant and the consent date;
 * - every participant has exactly call 1 and call 2, and there are 3–5
 *   participants;
 * - every call is inside the 4–6 minute band, measured from the audio bytes;
 * - every take still rehashes to the digest in its record *and* to the digest
 *   pinned in the baseline manifest, so an edited blob or an edited record is a
 *   named refusal;
 * - no baseline take is selectable by a scenario and no baseline take id or
 *   digest appears in a committed certification artifact.
 *
 * A pinned manifest is written once with `--record` and never overwritten: a
 * second baseline is a deliberate human act, not a retry of the same command.
 * The verifier reads local-only working state under `voni/.studio/` (gitignored)
 * and writes no participant data outside it.
 */

import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { AudioFormat, TakeRecord, TakeStore } from "./take-store";
import { openTakeStore, StudioError } from "./take-store";

/** The spec's baseline shape: three to five people, two calls each. */
export const BASELINE_MIN_PARTICIPANTS = 3;
export const BASELINE_MAX_PARTICIPANTS = 5;
export const BASELINE_CALLS_PER_PARTICIPANT = 2;

/** Four to six minutes, inclusive. */
export const BASELINE_MIN_DURATION_MS = 4 * 60 * 1000;
export const BASELINE_MAX_DURATION_MS = 6 * 60 * 1000;

export const BASELINE_MANIFEST_SCHEMA_VERSION = 1;

/** `demo:verify`'s refusal exit code; the baseline command speaks the same one. */
export const BASELINE_REFUSAL_EXIT_CODE = 2;

export type BaselineErrorCode =
  | "invalid-argument"
  | "missing-take"
  | "participant-count"
  | "missing-baseline-call"
  | "duplicate-baseline-call"
  | "missing-consent-reference"
  | "consent-mismatch"
  | "unsafe-consent-path"
  | "wrong-duration-band"
  | "duration-unmeasurable"
  | "edited-take"
  | "baseline-as-certification-input"
  | "missing-manifest"
  | "manifest-exists"
  | "malformed-manifest"
  | "manifest-drift"
  | "unreadable-manifest"
  | "unreadable-artifact";

export class BaselineError extends Error {
  readonly code: BaselineErrorCode;
  readonly exitCode = BASELINE_REFUSAL_EXIT_CODE;

  constructor(code: BaselineErrorCode, message: string) {
    super(message);
    this.name = "BaselineError";
    this.code = code;
  }
}

/** One pinned baseline call: the pseudonym, the call number and the exact bytes. */
export type BaselineTakeEntry = {
  readonly participantId: string;
  readonly call: 1 | 2;
  readonly takeId: string;
  readonly audioSha256: string;
  readonly audioBytes: number;
  readonly durationMs: number;
  readonly consentRef: string;
  readonly consentedAt: string;
};

/** The committed-once hash list this command reproduces. */
export type BaselineManifest = {
  readonly schemaVersion: typeof BASELINE_MANIFEST_SCHEMA_VERSION;
  readonly use: "blind-comparison-only";
  readonly takes: readonly BaselineTakeEntry[];
};

export type BaselineReport = {
  readonly participants: number;
  readonly takes: readonly BaselineTakeEntry[];
  readonly manifestPath: string;
  readonly pinned: boolean;
};

export type MeasureDuration = (record: TakeRecord, bytes: Buffer) => number | Promise<number>;

export type VerifyBaselineOptions = {
  /** The Studio store root holding `takes/` and `blobs/`. */
  readonly root: string;
  /** Where the pinned hash list lives; defaults to `<root>/baseline-hashes.json`. */
  readonly manifestPath?: string;
  /** Where signed consent references are filed; defaults to `<root>/consent`. */
  readonly consentRoot?: string;
  /** Committed certification artifacts to scan for a baseline id or digest. */
  readonly certificationRoots?: readonly string[];
  /** Pin the current list; refuses if a manifest already exists. */
  readonly record?: boolean;
  /** Injectable duration reader; tests pin it, production measures the bytes. */
  readonly measureDuration?: MeasureDuration;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byParticipant(left: BaselineTakeEntry, right: BaselineTakeEntry): number {
  if (left.participantId !== right.participantId) {
    return left.participantId < right.participantId ? -1 : 1;
  }
  return left.call - right.call;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(2)} min`;
}

/**
 * Duration of a RIFF/WAVE file, from its `fmt ` byte rate and its `data` size.
 * Returns `null` rather than guessing when the header is not readable.
 */
export function wavDurationMs(bytes: Buffer): number | null {
  if (bytes.byteLength < 44) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 12 <= bytes.byteLength) {
      byteRate = bytes.readUInt32LE(start + 8);
    } else if (id === "data") {
      dataBytes = Math.min(size, bytes.byteLength - start);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!byteRate || dataBytes === null) return null;
  return Math.round((dataBytes / byteRate) * 1000);
}

/**
 * Duration of any container ffprobe can decode, from audio packet timestamps.
 * A MediaRecorder WebM often carries no container duration, so packets are the
 * source that survives; an unreadable file is a refusal, never a zero.
 */
function ffprobeDurationMs(path: string): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time,duration_time", "-of", "json", path],
    { encoding: "utf8" },
  );
  return readFfprobe(result, path);
}

/** The same measurement for bytes that have not landed yet (the save gate). */
function ffprobeBytesDurationMs(bytes: Buffer): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time,duration_time", "-of", "json", "pipe:0"],
    // A six-minute WebM is well under this; the default 1 MiB spawn buffer is
    // not, and a full-size call would fail with ENOBUFS before ffprobe saw it.
    { input: bytes, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return readFfprobe(result, "the recorded take");
}

function readFfprobe(
  result: { error?: Error; status: number | null; stdout: string; stderr: string },
  what: string,
): number {
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BaselineError(
        "duration-unmeasurable",
        `cannot measure ${what}: ffprobe is not on PATH (${errorText(result.error)}); ` +
          "install ffmpeg or supply a WAV baseline take",
      );
    }
    throw new BaselineError("duration-unmeasurable", `cannot measure ${what}: ${errorText(result.error)}`);
  }
  if (result.status !== 0) {
    throw new BaselineError(
      "duration-unmeasurable",
      `cannot measure ${what}: ffprobe exited ${String(result.status)}: ${result.stderr.trim() || "no detail"}`,
    );
  }
  let packets: { pts_time?: string; duration_time?: string }[];
  try {
    packets = (JSON.parse(result.stdout) as { packets?: typeof packets }).packets ?? [];
  } catch (error) {
    throw new BaselineError("duration-unmeasurable", `cannot measure ${what}: ffprobe output is not JSON (${errorText(error)})`);
  }
  let end = -1;
  for (const packet of packets) {
    const start = Number(packet.pts_time);
    const length = Number(packet.duration_time);
    if (Number.isFinite(start) && Number.isFinite(length)) {
      end = Math.max(end, start + length);
    }
  }
  if (end < 0) {
    throw new BaselineError(
      "duration-unmeasurable",
      `cannot measure ${what}: ffprobe found no audio packet timestamps; the file may be empty or not audio`,
    );
  }
  return Math.round(end * 1000);
}

/**
 * Duration of bytes that have not been stored: the WAV header when there is
 * one, ffprobe's packets for every other container. The Studio's save gate and
 * the verifier share this reading, so a take is refused at landing for the same
 * reason it would later fail the pin.
 */
export function audioDurationMs(bytes: Buffer, format: AudioFormat): number {
  if (format === "wav") {
    const duration = wavDurationMs(bytes);
    if (duration === null) {
      throw new BaselineError(
        "duration-unmeasurable",
        "cannot read the WAV header of the recorded take; a baseline take is a whole call, not a snippet",
      );
    }
    return duration;
  }
  return ffprobeBytesDurationMs(bytes);
}

/** The production durater: WAV from its header, every other container from ffprobe. */
export function measureDurationFromBytes(root: string): MeasureDuration {
  return (record, bytes) => {
    if (record.audioFormat === "wav") {
      const duration = wavDurationMs(bytes);
      if (duration === null) {
        throw new BaselineError(
          "duration-unmeasurable",
          `cannot read the WAV header of take ${record.takeId} (${record.audioPath}); ` +
            "a baseline take is a whole call, not a snippet",
        );
      }
      return duration;
    }
    return ffprobeDurationMs(join(root, record.audioPath));
  };
}

/** Read a pinned manifest and refuse anything this command did not write. */
export async function readBaselineManifest(path: string): Promise<BaselineManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BaselineError(
        "missing-manifest",
        `no baseline hash list at ${path}; record the baseline with --record once the participants have finished`,
      );
    }
    throw new BaselineError("unreadable-manifest", `cannot read ${path}: ${errorText(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BaselineError("malformed-manifest", `${path} is not valid JSON: ${errorText(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BaselineError("malformed-manifest", `${path} is not a baseline manifest`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.schemaVersion !== BASELINE_MANIFEST_SCHEMA_VERSION) {
    throw new BaselineError(
      "malformed-manifest",
      `${path} has schema version ${String(manifest.schemaVersion)}; this command writes ${BASELINE_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (manifest.use !== "blind-comparison-only") {
    throw new BaselineError("malformed-manifest", `${path} must declare "use": "blind-comparison-only"`);
  }
  if (!Array.isArray(manifest.takes)) {
    throw new BaselineError("malformed-manifest", `${path} has no takes list`);
  }
  const takes: BaselineTakeEntry[] = manifest.takes.map((rawTake, index) => {
    if (typeof rawTake !== "object" || rawTake === null || Array.isArray(rawTake)) {
      throw new BaselineError("malformed-manifest", `${path} take ${index + 1} is not an object`);
    }
    const take = rawTake as Record<string, unknown>;
    const call = take.call;
    if (call !== 1 && call !== 2) {
      throw new BaselineError("malformed-manifest", `${path} take ${index + 1} has an invalid call ${JSON.stringify(call)}`);
    }
    for (const field of ["participantId", "takeId", "consentRef", "consentedAt", "audioSha256"] as const) {
      if (typeof take[field] !== "string" || take[field].trim().length === 0) {
        throw new BaselineError("malformed-manifest", `${path} take ${index + 1} has no "${field}"`);
      }
    }
    if (typeof take.audioSha256 !== "string" || !/^[0-9a-f]{64}$/.test(take.audioSha256)) {
      throw new BaselineError("malformed-manifest", `${path} take ${index + 1} has an invalid sha256`);
    }
    for (const field of ["audioBytes", "durationMs"] as const) {
      if (typeof take[field] !== "number" || !Number.isInteger(take[field])) {
        throw new BaselineError("malformed-manifest", `${path} take ${index + 1} has an invalid ${field}`);
      }
    }
    return {
      participantId: take.participantId as string,
      call,
      takeId: take.takeId as string,
      audioSha256: take.audioSha256,
      audioBytes: take.audioBytes as number,
      durationMs: take.durationMs as number,
      consentRef: take.consentRef as string,
      consentedAt: take.consentedAt as string,
    };
  });
  return { schemaVersion: BASELINE_MANIFEST_SCHEMA_VERSION, use: "blind-comparison-only", takes: takes.sort(byParticipant) };
}

async function readConsent(
  consentRoot: string,
  entry: { participantId: string; consentRef: string; consentedAt: string; takeId: string },
): Promise<void> {
  if (entry.consentRef.trim().length === 0) {
    throw new BaselineError(
      "missing-consent-reference",
      `baseline take ${entry.takeId} has no consent reference; a baseline take without recorded consent is never comparison audio`,
    );
  }
  const path = resolve(consentRoot, entry.consentRef);
  if (path !== consentRoot && !path.startsWith(`${consentRoot}${sep}`)) {
    throw new BaselineError(
      "unsafe-consent-path",
      `baseline take ${entry.takeId} names consent ${JSON.stringify(entry.consentRef)}, which resolves outside ${consentRoot}`,
    );
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BaselineError(
        "missing-consent-reference",
        `baseline take ${entry.takeId} cites consent ${JSON.stringify(entry.consentRef)}, but ${path} does not exist; ` +
          "file the signed consent beside the takes before pinning",
      );
    }
    throw new BaselineError("missing-consent-reference", `cannot read consent ${path}: ${errorText(error)}`);
  }
  if (text.trim().length === 0) {
    throw new BaselineError("missing-consent-reference", `consent ${path} is empty`);
  }
  if (!text.includes(entry.participantId) || !text.includes(entry.consentedAt)) {
    throw new BaselineError(
      "consent-mismatch",
      `consent ${path} does not name participant ${entry.participantId} and date ${entry.consentedAt}; ` +
        "the reference and the file disagree",
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new BaselineError("unreadable-artifact", `cannot stat ${path}: ${errorText(error)}`);
  }
}

/** Every `.json` under a certification root, recursively; dot entries are skipped. */
async function jsonFiles(root: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new BaselineError("unreadable-artifact", `cannot read ${root}: ${errorText(error)}`);
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await jsonFiles(path, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(path);
    }
  }
}

/**
 * A baseline take id or digest in a committed certification artifact means a
 * human reference was used as an input to certifying, which the spec forbids.
 */
async function assertNotCertificationInput(
  entries: readonly BaselineTakeEntry[],
  roots: readonly string[],
): Promise<void> {
  const files: string[] = [];
  for (const root of roots) await jsonFiles(root, files);
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new BaselineError("unreadable-artifact", `cannot read ${file}: ${errorText(error)}`);
    }
    for (const entry of entries) {
      if (text.includes(entry.audioSha256) || text.includes(entry.takeId)) {
        throw new BaselineError(
          "baseline-as-certification-input",
          `baseline take ${entry.takeId} (${entry.audioSha256}) appears in certification artifact ${file}; ` +
            "the baseline is blind comparison audio only, never a certification input",
        );
      }
    }
  }
}

async function writeManifest(path: string, manifest: BaselineManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new BaselineError(
        "manifest-exists",
        `${path} is already pinned; a pinned baseline is never re-written. ` +
          "Delete it deliberately if the owner has decided to replace the baseline.",
      );
    }
    throw new BaselineError("invalid-argument", `cannot write ${path}: ${errorText(error)}`);
  }
}

function compareManifests(pinned: BaselineManifest, current: readonly BaselineTakeEntry[], path: string): void {
  const pinnedJson = JSON.stringify(pinned.takes);
  const currentJson = JSON.stringify(current);
  if (pinnedJson === currentJson) return;
  const pinnedById = new Map(pinned.takes.map((take) => [take.takeId, take]));
  const currentById = new Map(current.map((take) => [take.takeId, take]));
  for (const take of current) {
    const before = pinnedById.get(take.takeId);
    if (!before) {
      throw new BaselineError("manifest-drift", `take ${take.takeId} is in the store but not in ${path}; the baseline changed after pinning`);
    }
    if (before.audioSha256 !== take.audioSha256 || before.audioBytes !== take.audioBytes) {
      throw new BaselineError(
        "edited-take",
        `baseline take ${take.takeId} changed after pinning: ${path} pins ${before.audioSha256} (${before.audioBytes} bytes), ` +
          `the store has ${take.audioSha256} (${take.audioBytes} bytes). A take is never edited in place.`,
      );
    }
    if (
      before.durationMs !== take.durationMs ||
      before.consentRef !== take.consentRef ||
      before.consentedAt !== take.consentedAt ||
      before.participantId !== take.participantId ||
      before.call !== take.call
    ) {
      throw new BaselineError("manifest-drift", `baseline take ${take.takeId} no longer matches its pinned record in ${path}`);
    }
  }
  for (const take of pinned.takes) {
    if (!currentById.has(take.takeId)) {
      throw new BaselineError("manifest-drift", `take ${take.takeId} is pinned in ${path} but no longer active in the store`);
    }
  }
  throw new BaselineError("manifest-drift", `the baseline hash list does not match ${path}`);
}

function assertComplete(entries: readonly BaselineTakeEntry[]): number {
  const byParticipant = new Map<string, BaselineTakeEntry[]>();
  for (const entry of entries) {
    byParticipant.set(entry.participantId, [...(byParticipant.get(entry.participantId) ?? []), entry]);
  }
  if (byParticipant.size < BASELINE_MIN_PARTICIPANTS || byParticipant.size > BASELINE_MAX_PARTICIPANTS) {
    throw new BaselineError(
      "participant-count",
      `the baseline has ${byParticipant.size} participant${byParticipant.size === 1 ? "" : "s"}; ` +
        `the spec records ${BASELINE_MIN_PARTICIPANTS}–${BASELINE_MAX_PARTICIPANTS}`,
    );
  }
  for (const [participantId, takes] of [...byParticipant.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const calls = takes.map((take) => take.call).sort((left, right) => left - right);
    const duplicate = calls.find((call, index) => index > 0 && calls[index - 1] === call);
    if (duplicate !== undefined) {
      throw new BaselineError(
        "duplicate-baseline-call",
        `participant ${participantId} has more than one active call ${duplicate}; retire a superseded take before pinning`,
      );
    }
    for (const call of [1, 2] as const) {
      if (!calls.includes(call)) {
        throw new BaselineError(
          "missing-baseline-call",
          `participant ${participantId} is missing call ${call}; every participant records two calls`,
        );
      }
    }
  }
  return byParticipant.size;
}

/** Check the whole baseline and return its canonical hash list. */
export async function verifyBaseline(options: VerifyBaselineOptions): Promise<BaselineReport> {
  const root = resolve(options.root);
  if (!(await exists(root))) {
    throw new BaselineError("missing-take", `no Studio store at ${root}; record the baseline before verifying it`);
  }
  const manifestPath = resolve(options.manifestPath ?? join(root, "baseline-hashes.json"));
  const consentRoot = resolve(options.consentRoot ?? join(root, "consent"));
  const measure = options.measureDuration ?? measureDurationFromBytes(root);

  let store: TakeStore;
  try {
    store = await openTakeStore({ root });
  } catch (error) {
    if (error instanceof StudioError) {
      throw new BaselineError("missing-take", `cannot open the Studio store at ${root}: ${error.message}`);
    }
    throw error;
  }

  const active = await store.baselineTakes();
  if (active.length === 0) {
    throw new BaselineError(
      "missing-take",
      `the Studio store at ${root} has no active baseline take; the human baseline is not captured`,
    );
  }

  const entries: BaselineTakeEntry[] = [];
  for (const record of active) {
    const baseline = record.baseline!;
    await readConsent(consentRoot, {
      participantId: baseline.participantId,
      consentRef: baseline.consentRef,
      consentedAt: baseline.consentedAt,
      takeId: record.takeId,
    });

    let bytes: Buffer;
    try {
      bytes = (await store.read(record.takeId)).bytes;
    } catch (error) {
      if (error instanceof StudioError && error.code === "take-drift") {
        throw new BaselineError("edited-take", error.message);
      }
      throw new BaselineError(
        "missing-take",
        `cannot read baseline take ${record.takeId}: ${errorText(error)}`,
      );
    }

    const durationMs = await measure(record, bytes);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new BaselineError("duration-unmeasurable", `baseline take ${record.takeId} has no measurable duration`);
    }
    if (durationMs < BASELINE_MIN_DURATION_MS || durationMs > BASELINE_MAX_DURATION_MS) {
      throw new BaselineError(
        "wrong-duration-band",
        `baseline take ${record.takeId} is ${minutes(durationMs)}; a baseline call is ` +
          `${minutes(BASELINE_MIN_DURATION_MS)}–${minutes(BASELINE_MAX_DURATION_MS)}`,
      );
    }

    try {
      await store.assertSelectable(record.takeId);
      throw new BaselineError(
        "baseline-as-certification-input",
        `baseline take ${record.takeId} is selectable by a scenario; baseline audio is blind comparison only`,
      );
    } catch (error) {
      if (error instanceof BaselineError) throw error;
      if (!(error instanceof StudioError) || error.code !== "baseline-take") {
        throw new BaselineError(
          "baseline-as-certification-input",
          `baseline take ${record.takeId} is not refused by the store as baseline audio: ${errorText(error)}`,
        );
      }
    }

    entries.push({
      participantId: baseline.participantId,
      call: baseline.call,
      takeId: record.takeId,
      audioSha256: record.audioSha256,
      audioBytes: record.audioBytes,
      durationMs,
      consentRef: baseline.consentRef,
      consentedAt: baseline.consentedAt,
    });
  }
  entries.sort(byParticipant);
  const participants = assertComplete(entries);

  const certificationRoots = (options.certificationRoots ?? []).map((path) => resolve(path));
  await assertNotCertificationInput(entries, certificationRoots);

  if (options.record) {
    const manifest: BaselineManifest = {
      schemaVersion: BASELINE_MANIFEST_SCHEMA_VERSION,
      use: "blind-comparison-only",
      takes: entries,
    };
    await writeManifest(manifestPath, manifest);
  } else {
    const pinned = await readBaselineManifest(manifestPath);
    compareManifests(pinned, entries, manifestPath);
  }

  return {
    participants,
    takes: entries,
    manifestPath,
    pinned: options.record === true,
  };
}
