/**
 * The Rate store: session persistence, evidence loading and the audio the
 * blind page plays.
 *
 * A session is written once under `voni/.studio/rating/`; a rating is written
 * once per item beside it. Evidence is read from a contained root, rehashed on
 * creation and again on every serving, so a changed recording is a named
 * refusal rather than a different call under the same blind id.
 */

import { randomInt } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { sha256Hex } from "../../src/lib/demo/verification/scenarios/digest";
import type { Certificate } from "../../src/lib/demo/verification/certificate/types";
import {
  RATING_SESSION_SCHEMA_VERSION,
  blindSession,
  buildRatingSession,
  fileRating,
  type BlindSession,
  type RatingCallInput,
  type RatingRecord,
  type RatingSession,
  type RatingSubmission,
} from "./rate";
import { contentTypeFor, sniffAudioFormat } from "./take-store";

export const RATING_ROOT_DIR = "rating";
export const RATING_SESSIONS_DIR = "sessions";
export const RATING_SESSION_FILE = "session.json";
export const RATING_RATINGS_DIR = "ratings";
export const RATING_SESSION_ID = /^rating-[0-9a-f]{64}$/;
export const RATING_ITEM_ID = /^item-\d{3}$/;

export type RatingStoreErrorCode =
  | "invalid-store-root"
  | "invalid-evidence-root"
  | "unknown-session"
  | "malformed-session"
  | "session-exists"
  | "missing-audio"
  | "audio-drift"
  | "evidence-outside-root"
  | "unsupported-audio"
  | "unknown-side"
  | "no-ab-pair"
  | "rating-already-filed"
  | "session-io";

export class RatingStoreError extends Error {
  readonly code: RatingStoreErrorCode;
  readonly exitCode = 2;

  constructor(code: RatingStoreErrorCode, message: string) {
    super(message);
    this.name = "RatingStoreError";
    this.code = code;
  }
}

export type OpenRatingStoreOptions = {
  /** Session root; `voni/.studio/rating` in normal use. */
  readonly root: string;
  /** Audio evidence; a path outside this root is refused. */
  readonly evidenceRoot: string;
  readonly now?: () => Date;
};

export type CreateRatingSessionInput = {
  readonly certificate: Certificate;
  readonly calls: readonly RatingCallInput[];
  readonly reviewer: string;
  readonly seed?: number;
  readonly cleanPerLocale?: number;
  readonly createdAt?: string;
};

export type RatingStore = {
  readonly root: string;
  readonly evidenceRoot: string;
  create(input: CreateRatingSessionInput): Promise<{ session: RatingSession; blind: BlindSession }>;
  get(sessionId: string): Promise<RatingSession>;
  blind(sessionId: string): Promise<BlindSession>;
  list(): Promise<BlindSession[]>;
  fileRating(sessionId: string, submission: RatingSubmission): Promise<RatingRecord>;
  ratings(sessionId: string): Promise<RatingRecord[]>;
  audio(
    sessionId: string,
    itemId: string,
    side: "call" | "A" | "B",
  ): Promise<{ bytes: Buffer; contentType: string }>;
  goldLabels(sessionId: string): Promise<{
    sessionId: string;
    reviewer: string;
    signedAt: string;
    ratings: readonly RatingRecord[];
  }>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mkdirp(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    throw new RatingStoreError("session-io", `cannot create the rating directory ${path}: ${errorText(error)}`);
  }
}

/** Write a file that must not exist; a session and a rating are written once. */
async function writeNew(path: string, text: string): Promise<void> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RatingStoreError("session-exists", `${path} already exists; a rating session is written once and never rewritten`);
    }
    throw new RatingStoreError("session-io", `cannot write ${path}: ${errorText(error)}`);
  }
}

function parseStoredSession(raw: unknown, from: string, expectedId?: string): RatingSession {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RatingStoreError("malformed-session", `${from} is not a rating session`);
  }
  const session = raw as Record<string, unknown>;
  if (session.schemaVersion !== RATING_SESSION_SCHEMA_VERSION) {
    throw new RatingStoreError("malformed-session", `${from} has schema version ${String(session.schemaVersion)}`);
  }
  if (typeof session.sessionId !== "string" || !RATING_SESSION_ID.test(session.sessionId)) {
    throw new RatingStoreError("malformed-session", `${from} has an invalid session id`);
  }
  if (expectedId !== undefined && session.sessionId !== expectedId) {
    throw new RatingStoreError("malformed-session", `${from} names ${session.sessionId}; the directory names ${expectedId}`);
  }
  if (!Array.isArray(session.queue)) {
    throw new RatingStoreError("malformed-session", `${from} has no queue`);
  }
  for (const item of session.queue) {
    if (typeof item !== "object" || item === null) {
      throw new RatingStoreError("malformed-session", `${from} has a malformed queue item`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.itemId !== "string" || !RATING_ITEM_ID.test(entry.itemId)) {
      throw new RatingStoreError("malformed-session", `${from} has an invalid item id`);
    }
    if (typeof entry.callId !== "string" || entry.callId.trim().length === 0) {
      throw new RatingStoreError("malformed-session", `${from} item ${entry.itemId} has no call id`);
    }
    if (typeof entry.audio !== "object" || entry.audio === null) {
      throw new RatingStoreError("malformed-session", `${from} item ${entry.itemId} has no audio`);
    }
  }
  return session as unknown as RatingSession;
}

function parseStoredRating(raw: unknown, from: string, sessionId: string): RatingRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RatingStoreError("malformed-session", `${from} is not a rating`);
  }
  const rating = raw as Record<string, unknown>;
  if (rating.schemaVersion !== RATING_SESSION_SCHEMA_VERSION || rating.sessionId !== sessionId) {
    throw new RatingStoreError("malformed-session", `${from} does not belong to session ${sessionId}`);
  }
  if (typeof rating.itemId !== "string" || !RATING_ITEM_ID.test(rating.itemId)) {
    throw new RatingStoreError("malformed-session", `${from} has an invalid item id`);
  }
  return rating as unknown as RatingRecord;
}

export async function openRatingStore(options: OpenRatingStoreOptions): Promise<RatingStore> {
  if (typeof options.root !== "string" || options.root.trim().length === 0) {
    throw new RatingStoreError("invalid-store-root", "the rating store needs a root directory");
  }
  if (typeof options.evidenceRoot !== "string" || options.evidenceRoot.trim().length === 0) {
    throw new RatingStoreError("invalid-evidence-root", "the rating store needs an evidence root");
  }
  const root = resolve(options.root);
  const evidenceRoot = resolve(options.evidenceRoot);
  const sessionsDir = join(root, RATING_SESSIONS_DIR);
  await mkdirp(sessionsDir);
  const now = options.now ?? (() => new Date());

  function sessionDir(sessionId: string): string {
    if (typeof sessionId !== "string" || !RATING_SESSION_ID.test(sessionId)) {
      throw new RatingStoreError(
        "unknown-session",
        `"${String(sessionId)}" is not a Studio rating session; sessions are named rating-<sha256>`,
      );
    }
    return join(sessionsDir, sessionId);
  }

  function evidencePath(path: string): string {
    const candidate = isAbsolute(path) ? resolve(path) : resolve(evidenceRoot, path);
    if (candidate !== evidenceRoot && !candidate.startsWith(`${evidenceRoot}${sep}`)) {
      throw new RatingStoreError(
        "evidence-outside-root",
        `${candidate} is outside the evidence root ${evidenceRoot}; the Rate surface reads only the run's evidence, never an arbitrary file`,
      );
    }
    return candidate;
  }

  async function readEvidence(audio: { path: string; sha256: string }, what: string): Promise<{
    path: string;
    bytes: Buffer;
    contentType: string;
  }> {
    const path = evidencePath(audio.path);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new RatingStoreError(
        missing ? "missing-audio" : "session-io",
        `${what} audio is ${missing ? "missing" : "unreadable"}: ${path}`,
      );
    }
    const actual = sha256Hex(bytes);
    if (actual !== audio.sha256) {
      throw new RatingStoreError(
        "audio-drift",
        `${what} audio changed: expected sha256 ${audio.sha256}, file ${path} is ${actual}. ` +
          "A call is never re-baselined silently; re-run the certification.",
      );
    }
    let contentType: string;
    try {
      contentType = contentTypeFor(sniffAudioFormat(bytes));
    } catch (error) {
      throw new RatingStoreError("unsupported-audio", `${what} audio is not a supported container: ${errorText(error)}`);
    }
    return { path, bytes, contentType };
  }

  async function loadCalls(calls: readonly RatingCallInput[]): Promise<RatingCallInput[]> {
    const loaded: RatingCallInput[] = [];
    for (const call of calls) {
      if (typeof call !== "object" || call === null || typeof call.audio !== "object" || call.audio === null) {
        throw new RatingStoreError(
          "missing-audio",
          `call ${JSON.stringify((call as { callId?: unknown } | null)?.callId ?? "")} has no audio evidence; a call is never queued without its audio and hash`,
        );
      }
      const audio = await readEvidence(call.audio, `call "${String(call.callId)}"`);
      const baseline =
        call.baseline === undefined
          ? undefined
          : await readEvidence(call.baseline, `call "${String(call.callId)}" baseline`);
      loaded.push({
        ...call,
        audio: { path: audio.path, sha256: call.audio.sha256 },
        ...(baseline === undefined
          ? {}
          : { baseline: { path: baseline.path, sha256: call.baseline!.sha256 } }),
      });
    }
    return loaded;
  }

  async function create(input: CreateRatingSessionInput): Promise<{ session: RatingSession; blind: BlindSession }> {
    const seed = input.seed ?? randomInt(0, 0x100000000);
    const createdAt = input.createdAt ?? now().toISOString();
    const calls = await loadCalls(input.calls ?? []);
    const session = buildRatingSession({
      certificate: input.certificate,
      calls,
      reviewer: input.reviewer,
      seed,
      createdAt,
      ...(input.cleanPerLocale === undefined ? {} : { cleanPerLocale: input.cleanPerLocale }),
    });
    const dir = sessionDir(session.sessionId);
    await mkdirp(join(dir, RATING_RATINGS_DIR));
    await writeNew(join(dir, RATING_SESSION_FILE), `${JSON.stringify(session, null, 2)}\n`);
    return { session, blind: blindSession(session) };
  }

  async function get(sessionId: string): Promise<RatingSession> {
    const path = join(sessionDir(sessionId), RATING_SESSION_FILE);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new RatingStoreError(
        missing ? "unknown-session" : "session-io",
        `${path} is ${missing ? "not a Studio rating session" : `unreadable: ${errorText(error)}`}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new RatingStoreError("malformed-session", `${path} is not valid JSON: ${errorText(error)}`);
    }
    return parseStoredSession(parsed, path, sessionId);
  }

  async function blind(sessionId: string): Promise<BlindSession> {
    return blindSession(await get(sessionId));
  }

  async function list(): Promise<BlindSession[]> {
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = await readdir(sessionsDir, { withFileTypes: true });
    } catch (error) {
      throw new RatingStoreError("session-io", `cannot read ${sessionsDir}: ${errorText(error)}`);
    }
    const sessions: BlindSession[] = [];
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (!entry.isDirectory() || !RATING_SESSION_ID.test(entry.name)) continue;
      sessions.push(await blind(entry.name));
    }
    return sessions;
  }

  async function fileOne(sessionId: string, submission: RatingSubmission): Promise<RatingRecord> {
    const session = await get(sessionId);
    const rating = fileRating(session, submission, now().toISOString());
    const dir = join(sessionDir(sessionId), RATING_RATINGS_DIR);
    await mkdirp(dir);
    const path = join(dir, `${rating.itemId}.json`);
    try {
      await writeNew(path, `${JSON.stringify(rating, null, 2)}\n`);
    } catch (error) {
      if (error instanceof RatingStoreError && error.code === "session-exists") {
        throw new RatingStoreError(
          "rating-already-filed",
          `item ${rating.itemId} was already filed in session ${sessionId}; a rating is written once and never rewritten`,
        );
      }
      throw error;
    }
    return rating;
  }

  async function ratings(sessionId: string): Promise<RatingRecord[]> {
    await get(sessionId);
    const dir = join(sessionDir(sessionId), RATING_RATINGS_DIR);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RatingStoreError("session-io", `cannot read ${dir}: ${errorText(error)}`);
    }
    const records: RatingRecord[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const path = join(dir, entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        throw new RatingStoreError("malformed-session", `${path} is unreadable: ${errorText(error)}`);
      }
      records.push(parseStoredRating(parsed, path, sessionId));
    }
    return records;
  }

  async function audio(
    sessionId: string,
    itemId: string,
    side: "call" | "A" | "B",
  ): Promise<{ bytes: Buffer; contentType: string }> {
    const session = await get(sessionId);
    const item = session.queue.find((entry) => entry.itemId === itemId);
    if (!item) {
      throw new RatingStoreError("unknown-session", `"${itemId}" is not an item in session ${sessionId}`);
    }
    let evidence: { path: string; sha256: string };
    if (side === "call") {
      evidence = item.audio;
    } else if (side === "A" || side === "B") {
      if (!item.ab) {
        throw new RatingStoreError("no-ab-pair", `item ${itemId} has no A/B pair; there is no baseline to play`);
      }
      const agent = side === item.ab.agentSide;
      const chosen = agent ? item.audio : item.baseline;
      if (!chosen) {
        throw new RatingStoreError("no-ab-pair", `item ${itemId} has no baseline side recorded`);
      }
      evidence = chosen;
    } else {
      throw new RatingStoreError("unknown-side", `${String(side)} is not a side; use call, A or B`);
    }
    const read = await readEvidence(evidence, `item ${itemId} side ${side}`);
    return { bytes: read.bytes, contentType: read.contentType };
  }

  async function goldLabels(sessionId: string): Promise<{
    sessionId: string;
    reviewer: string;
    signedAt: string;
    ratings: readonly RatingRecord[];
  }> {
    const session = await get(sessionId);
    return {
      sessionId: session.sessionId,
      reviewer: session.reviewer,
      signedAt: session.date,
      ratings: await ratings(sessionId),
    };
  }

  return { root, evidenceRoot, create, get, blind, list, fileRating: fileOne, ratings, audio, goldLabels };
}
