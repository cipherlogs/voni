/**
 * Ticket 24's Rate core: the blind queue, the blind A/B pair, the seven axes
 * and the attributable rating.
 *
 * The rule this module exists to enforce is that a rater hears the call, not
 * the verdict. The payload built here never carries the certificate's verdict,
 * the call or scenario id, the model/vendor identity, a hash or the answer key;
 * the private session keeps those for gold-label export and the signature.
 *
 * Fail closed: a call without a transcript, a timeline or a sha256 is refused
 * by name, a certificate call without evidence is refused, a failing scenario
 * with no call is refused, and a rating without all seven axes is refused. A
 * default would turn a missing measurement into a clean sample.
 */

import type { Certificate } from "../../src/lib/demo/verification/certificate/types";
import { LOCALES, type AgentEventType, type Locale } from "../../src/lib/demo/verification/scenarios/types";
import { sha256Hex } from "../../src/lib/demo/verification/scenarios/digest";

export const RATING_SESSION_SCHEMA_VERSION = 1;
export const RATING_SCALE_MIN = 1;
export const RATING_SCALE_MAX = 5;

/**
 * The seven axes. The spec requires "seven clear axes" without naming them;
 * this closed vocabulary is the Studio's rubric, grounded in the human-quality
 * table (H1 stay, H3 human, H4 turn-taking) and the visitor stories the panel
 * judges (understanding, language, warmth, pacing). It is data: a missing axis
 * is a refusal, never a default.
 */
export const RATING_AXES = [
  { id: "stayOnCall", label: "Would you stay on this call?", hint: "H1 — the visitor's own decision to stay." },
  { id: "soundsHuman", label: "Sounds human", hint: "H3 — not a paragraph read aloud, not a machine." },
  { id: "turnTaking", label: "Turn-taking feels natural", hint: "H4 — no talk-over, no long wait." },
  { id: "understanding", label: "Understood what I said", hint: "The reply answers the caller's actual point." },
  { id: "languageNaturalness", label: "Language sounds natural", hint: "Idiom, grammar and accent for this Locale." },
  { id: "warmth", label: "Warm and appropriate tone", hint: "Conduct under frustration, confusion or silence." },
  { id: "pacing", label: "Pacing and responsiveness", hint: "The rhythm of the call, including tool waits." },
] as const;

export type RatingAxis = (typeof RATING_AXES)[number]["id"];

export const RATING_AXIS_IDS = RATING_AXES.map((axis) => axis.id);

export const AB_SIDES = ["A", "B"] as const;

export type AbSide = (typeof AB_SIDES)[number];

export type TranscriptTurn = {
  readonly speaker: "caller" | "agent";
  readonly text: string;
  /** Call time the turn starts, when the evidence records it. */
  readonly atMs?: number;
};

export type TimelineEvent = {
  readonly atMs: number;
  readonly type: AgentEventType;
};

/** A local evidence file and the digest it must match. Never exposed to the rater. */
export type RatingAudio = {
  readonly path: string;
  readonly sha256: string;
};

/** One certification call offered to the panel. */
export type RatingCallInput = {
  readonly callId: string;
  readonly scenario: string;
  readonly locale: Locale;
  readonly transcript: readonly TranscriptTurn[];
  readonly timeline: readonly TimelineEvent[];
  readonly audio: RatingAudio;
  /** The human baseline this call is paired against; omitted means no A/B pair. */
  readonly baseline?: RatingAudio;
};

export type RatingSessionInput = {
  readonly certificate: Certificate;
  readonly calls: readonly RatingCallInput[];
  readonly reviewer: string;
  readonly seed: number;
  readonly createdAt: string;
  /** Clean calls sampled per Locale; every failing call is always queued. */
  readonly cleanPerLocale?: number;
};

/** The private answer key for one item's A/B pair. */
export type AbAssignment = {
  readonly agentSide: AbSide;
  readonly baselineSide: AbSide;
};

/** One queued call. `failing`, `callId`, hashes and the answer key are private. */
export type QueueItem = {
  readonly itemId: string;
  readonly position: number;
  readonly callId: string;
  readonly scenario: string;
  readonly locale: Locale;
  readonly failing: boolean;
  readonly transcript: readonly TranscriptTurn[];
  readonly timeline: readonly TimelineEvent[];
  readonly audio: RatingAudio;
  readonly baseline?: RatingAudio;
  readonly ab: AbAssignment | null;
};

export type RatingSession = {
  readonly schemaVersion: typeof RATING_SESSION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly reviewer: string;
  readonly createdAt: string;
  /** `YYYY-MM-DD`, the date the certificate's panel signature records. */
  readonly date: string;
  readonly runId: string;
  readonly target: Certificate["target"];
  readonly seed: number;
  readonly cleanPerLocale: number;
  readonly queue: readonly QueueItem[];
};

/** One A/B side as the rater sees it: a label and nothing else. */
export type BlindAbSide = { readonly label: AbSide };

/** The payload the Rate page receives. No verdict, identity, hash or answer key. */
export type BlindQueueItem = {
  readonly itemId: string;
  readonly position: number;
  readonly locale: Locale;
  readonly transcript: readonly TranscriptTurn[];
  readonly timeline: readonly TimelineEvent[];
  readonly ab: readonly BlindAbSide[] | null;
};

export type BlindSession = {
  readonly schemaVersion: typeof RATING_SESSION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly reviewer: string;
  readonly date: string;
  readonly queue: readonly BlindQueueItem[];
};

export type RatingSubmission = {
  readonly itemId: string;
  readonly axes: Readonly<Record<string, number>>;
  readonly freeText?: string;
  readonly defectTags?: readonly string[];
  /** Which side sounds human; required when the item has an A/B pair. */
  readonly humanSide?: AbSide;
  /** Which side the rater would keep; `neither` is a valid answer. */
  readonly preferredSide?: AbSide | "neither";
};

export type RatingPreference = "agent" | "baseline" | "neither";

export type RatingRecord = {
  readonly schemaVersion: typeof RATING_SESSION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly reviewer: string;
  readonly ratedAt: string;
  readonly itemId: string;
  /** Private: gold-label export names the call the rating judged. */
  readonly callId: string;
  readonly axes: Readonly<Record<RatingAxis, number>>;
  readonly freeText: string;
  readonly defectTags: readonly string[];
  readonly humanSide: AbSide | null;
  readonly preferredSide: AbSide | "neither" | null;
  /** True when the rater picked the baseline side as the human. */
  readonly humanDetected: boolean | null;
  readonly preference: RatingPreference | null;
};

export const RATING_ERROR_EXIT_CODE = 2;

export type RatingErrorCode =
  | "missing-reviewer"
  | "invalid-seed"
  | "invalid-created-at"
  | "invalid-clean-sample"
  | "invalid-session"
  | "duplicate-call"
  | "unknown-call"
  | "missing-call-evidence"
  | "missing-transcript"
  | "missing-timeline"
  | "missing-hash"
  | "invalid-hash"
  | "unknown-locale"
  | "missing-failing-evidence"
  | "failing-call-not-queued"
  | "empty-queue"
  | "unknown-item"
  | "missing-axis"
  | "unknown-axis"
  | "invalid-axis-score"
  | "invalid-free-text"
  | "invalid-defect-tag"
  | "missing-ab-answer"
  | "unexpected-ab-answer"
  | "invalid-ab-side"
  | "invalid-rated-at";

export class RatingError extends Error {
  readonly code: RatingErrorCode;
  readonly exitCode = RATING_ERROR_EXIT_CODE;

  constructor(code: RatingErrorCode, message: string) {
    super(message);
    this.name = "RatingError";
    this.code = code;
  }
}

const HASH = /^[0-9a-f]{64}$/;
const SAFE_TEXT_MAX = 4000;
const DEFECT_TAG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function nonEmpty(value: unknown, code: RatingErrorCode, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RatingError(code, `${what} is required; the panel never records a blank ${what}`);
  }
  const trimmed = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new RatingError(code, `${what} must be printable text: ${JSON.stringify(trimmed)}`);
  }
  return trimmed;
}

function parseHash(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RatingError("missing-hash", `${what} has no sha256; a call is never queued without its hash`);
  }
  const hash = value.trim().toLowerCase();
  if (!HASH.test(hash)) {
    throw new RatingError("invalid-hash", `${what} has an invalid sha256 ${JSON.stringify(value)}; expected 64 lowercase hex characters`);
  }
  return hash;
}

function parseAudio(value: unknown, what: string): RatingAudio {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RatingError("missing-hash", `${what} has no audio evidence; a call is never queued without its audio and hash`);
  }
  const audio = value as Record<string, unknown>;
  if (typeof audio.path !== "string" || audio.path.trim().length === 0) {
    throw new RatingError("missing-hash", `${what} has no audio path; a call is never queued without its audio`);
  }
  return { path: audio.path.trim(), sha256: parseHash(audio.sha256, what) };
}

function parseTranscript(value: unknown, callId: string): TranscriptTurn[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RatingError(
      "missing-transcript",
      `call "${callId}" has no transcript; the rater needs the words with the playback, never a guess`,
    );
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new RatingError("missing-transcript", `call "${callId}" transcript turn ${index + 1} is not a turn`);
    }
    const turn = raw as Record<string, unknown>;
    if (turn.speaker !== "caller" && turn.speaker !== "agent") {
      throw new RatingError("missing-transcript", `call "${callId}" transcript turn ${index + 1} has no caller/agent speaker`);
    }
    if (typeof turn.text !== "string" || turn.text.trim().length === 0) {
      throw new RatingError("missing-transcript", `call "${callId}" transcript turn ${index + 1} has no text`);
    }
    const atMs = turn.atMs;
    if (atMs !== undefined && (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0)) {
      throw new RatingError("missing-transcript", `call "${callId}" transcript turn ${index + 1} has an invalid atMs`);
    }
    return {
      speaker: turn.speaker,
      text: turn.text.trim(),
      ...(atMs === undefined ? {} : { atMs }),
    };
  });
}

function parseTimeline(value: unknown, callId: string): TimelineEvent[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RatingError(
      "missing-timeline",
      `call "${callId}" has no timeline; the rater needs the call events with the playback, never a guess`,
    );
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new RatingError("missing-timeline", `call "${callId}" timeline event ${index + 1} is not an event`);
    }
    const event = raw as Record<string, unknown>;
    if (typeof event.atMs !== "number" || !Number.isFinite(event.atMs) || event.atMs < 0) {
      throw new RatingError("missing-timeline", `call "${callId}" timeline event ${index + 1} has an invalid atMs`);
    }
    const type = event.type;
    if (
      type !== "call-open" &&
      type !== "agent-speech-start" &&
      type !== "agent-speech-end" &&
      type !== "agent-turn-end" &&
      type !== "call-end"
    ) {
      throw new RatingError(
        "missing-timeline",
        `call "${callId}" timeline event ${index + 1} has an unknown type ${JSON.stringify(type)}`,
      );
    }
    return { atMs: event.atMs, type };
  });
}

function parseLocale(value: unknown, callId: string): Locale {
  if (typeof value !== "string" || !(LOCALES as readonly string[]).includes(value)) {
    throw new RatingError(
      "unknown-locale",
      `call "${callId}" declares Locale ${JSON.stringify(value)}; the panel's Locales are ${LOCALES.join(", ")}`,
    );
  }
  return value as Locale;
}

function parseCall(raw: unknown): RatingCallInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RatingError("invalid-session", "a call must be an object");
  }
  const call = raw as Record<string, unknown>;
  const callId = nonEmpty(call.callId, "invalid-session", "call id");
  const scenario = nonEmpty(call.scenario, "invalid-session", `call "${callId}" scenario`);
  const locale = parseLocale(call.locale, callId);
  const audio = parseAudio(call.audio, `call "${callId}"`);
  const baseline = call.baseline === undefined ? undefined : parseAudio(call.baseline, `call "${callId}" baseline`);
  if (baseline && baseline.sha256 === audio.sha256) {
    throw new RatingError(
      "invalid-session",
      `call "${callId}" pairs itself with an identical baseline; an A/B pair must have two different recordings`,
    );
  }
  return {
    callId,
    scenario,
    locale,
    transcript: parseTranscript(call.transcript, callId),
    timeline: parseTimeline(call.timeline, callId),
    audio,
    ...(baseline === undefined ? {} : { baseline }),
  };
}

/** The scenarios whose certificate verdict is a failure. */
function failingScenarios(certificate: Certificate): Set<string> {
  const failing = new Set<string>();
  for (const property of certificate.properties ?? []) {
    const scenarios = property.scenarios ?? [];
    const failedRows = scenarios.filter((scenario) => scenario.status === "FAIL");
    if (failedRows.length > 0) {
      for (const scenario of failedRows) failing.add(scenario.scenario);
      continue;
    }
    // A pooled failure that no single scenario row carries still names the
    // scenarios it was judged on; every one of their calls is mandatory.
    if (property.status === "FAIL") {
      for (const scenario of scenarios) failing.add(scenario.scenario);
    }
  }
  return failing;
}

/** Every call the certificate's coverage rows name; the queue may not invent one. */
function certificateCallIds(certificate: Certificate): Set<string> {
  const calls = new Set<string>();
  for (const row of certificate.coverage?.rows ?? []) {
    for (const callId of row.calls ?? []) {
      if (callId.trim().length > 0) calls.add(callId);
    }
  }
  return calls;
}

function parseSeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RatingError("invalid-seed", `the session seed must be an integer 0–4294967295, got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseCreatedAt(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new RatingError("invalid-created-at", `createdAt must be an ISO timestamp, got ${JSON.stringify(value)}`);
  }
  return new Date(value).toISOString();
}

function parseCleanPerLocale(value: unknown): number {
  if (value === undefined) return 2;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 50) {
    throw new RatingError("invalid-clean-sample", `cleanPerLocale must be an integer 0–50, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Mulberry32: small, seedable and identical in the test and the Studio. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/** The clean sample: up to `perLocale` from each Locale, in codepoint order. */
function cleanSample(
  calls: readonly RatingCallInput[],
  perLocale: number,
  random: () => number,
): RatingCallInput[] {
  if (perLocale === 0) return [];
  const byLocale = new Map<Locale, RatingCallInput[]>();
  for (const call of calls) {
    const group = byLocale.get(call.locale);
    if (group) group.push(call);
    else byLocale.set(call.locale, [call]);
  }
  const sample: RatingCallInput[] = [];
  for (const locale of [...byLocale.keys()].sort()) {
    sample.push(...shuffle(byLocale.get(locale)!, random).slice(0, perLocale));
  }
  return sample;
}

/**
 * Build one rating session. Every failing call is queued; the clean sample is
 * drawn per Locale; each group is shuffled separately so failing calls stay
 * ahead of clean calls while no order is the evidence order.
 */
export function buildRatingSession(input: RatingSessionInput): RatingSession {
  const reviewer = nonEmpty(input.reviewer, "missing-reviewer", "a reviewer");
  const seed = parseSeed(input.seed);
  const createdAt = parseCreatedAt(input.createdAt);
  const cleanPerLocale = parseCleanPerLocale(input.cleanPerLocale);
  const certificate = input.certificate;
  if (typeof certificate !== "object" || certificate === null) {
    throw new RatingError("invalid-session", "a rating session needs the certificate it samples");
  }

  const calls = (input.calls ?? []).map(parseCall);
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.callId)) {
      throw new RatingError("duplicate-call", `call "${call.callId}" is offered twice; one call is one queue item`);
    }
    seen.add(call.callId);
  }

  const certificateCalls = certificateCallIds(certificate);
  for (const call of calls) {
    if (!certificateCalls.has(call.callId)) {
      throw new RatingError(
        "unknown-call",
        `call "${call.callId}" is not named by the certificate's coverage; the panel samples the certificate, not the filesystem`,
      );
    }
  }
  for (const callId of certificateCalls) {
    if (!seen.has(callId)) {
      throw new RatingError(
        "missing-call-evidence",
        `the certificate names call "${callId}" but no transcript, timeline, audio or hash was supplied; a missing call is a refusal, not a clean sample`,
      );
    }
  }

  const failing = failingScenarios(certificate);
  const failingCalls = calls.filter((call) => failing.has(call.scenario));
  if (failing.size > 0 && failingCalls.length === 0) {
    throw new RatingError(
      "missing-failing-evidence",
      `the certificate fails scenario(s) ${[...failing].join(", ")} but no call evidence was supplied for them; ` +
        "every failing call is mandatory in the queue, so an empty failure set is a refusal",
    );
  }

  const cleanCalls = calls.filter((call) => !failing.has(call.scenario));
  const random = seededRandom(seed);
  const failingOrder = shuffle(failingCalls, random);
  const cleanOrder = shuffle(cleanSample(cleanCalls, cleanPerLocale, random), random);
  const ordered = [...failingOrder, ...cleanOrder];
  if (ordered.length === 0) {
    throw new RatingError(
      "empty-queue",
      "the session queued no calls; a panel session over zero calls measures nothing (raise cleanPerLocale or supply call evidence)",
    );
  }

  const queue: QueueItem[] = ordered.map((call, index) => {
    let ab: AbAssignment | null = null;
    if (call.baseline) {
      const agentSide: AbSide = random() < 0.5 ? "A" : "B";
      ab = { agentSide, baselineSide: agentSide === "A" ? "B" : "A" };
    }
    return {
      itemId: `item-${String(index + 1).padStart(3, "0")}`,
      position: index + 1,
      callId: call.callId,
      scenario: call.scenario,
      locale: call.locale,
      failing: failing.has(call.scenario),
      transcript: call.transcript,
      timeline: call.timeline,
      audio: call.audio,
      ...(call.baseline === undefined ? {} : { baseline: call.baseline }),
      ab,
    };
  });

  const queuedFailing = new Set(queue.filter((item) => item.failing).map((item) => item.callId));
  for (const call of failingCalls) {
    if (!queuedFailing.has(call.callId)) {
      throw new RatingError("failing-call-not-queued", `failing call "${call.callId}" did not reach the queue`);
    }
  }

  const sessionId = `rating-${sha256Hex(
    JSON.stringify({
      runId: certificate.runId,
      reviewer,
      seed,
      createdAt,
      queue: queue.map((item) => ({ itemId: item.itemId, callId: item.callId, failing: item.failing })),
    }),
  )}`;

  return {
    schemaVersion: RATING_SESSION_SCHEMA_VERSION,
    sessionId,
    reviewer,
    createdAt,
    date: createdAt.slice(0, 10),
    runId: certificate.runId,
    target: certificate.target,
    seed,
    cleanPerLocale,
    queue,
  };
}

/** Strip every private field before the payload crosses to the Rate page. */
export function blindSession(session: RatingSession): BlindSession {
  return {
    schemaVersion: RATING_SESSION_SCHEMA_VERSION,
    sessionId: session.sessionId,
    reviewer: session.reviewer,
    date: session.date,
    queue: session.queue.map((item) => ({
      itemId: item.itemId,
      position: item.position,
      locale: item.locale,
      transcript: item.transcript,
      timeline: item.timeline,
      ab: item.ab === null ? null : AB_SIDES.map((label) => ({ label })),
    })),
  };
}

/** The session facts a certificate signature (ticket 27) signs over. */
export function signatureReference(session: RatingSession): {
  sessionId: string;
  reviewer: string;
  signedAt: string;
} {
  return { sessionId: session.sessionId, reviewer: session.reviewer, signedAt: session.date };
}

function parseAxes(value: unknown): Record<RatingAxis, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RatingError("missing-axis", `a rating needs all seven axes; got ${JSON.stringify(value)}`);
  }
  const axes = value as Record<string, unknown>;
  for (const key of Object.keys(axes)) {
    if (!(RATING_AXIS_IDS as readonly string[]).includes(key)) {
      throw new RatingError("unknown-axis", `unknown rating axis "${key}"; the rubric is ${RATING_AXIS_IDS.join(", ")}`);
    }
  }
  const parsed = {} as Record<RatingAxis, number>;
  for (const axis of RATING_AXES) {
    const score = axes[axis.id];
    if (score === undefined) {
      throw new RatingError("missing-axis", `rating axis "${axis.id}" is missing; all seven axes are required, never defaulted`);
    }
    if (typeof score !== "number" || !Number.isInteger(score) || score < RATING_SCALE_MIN || score > RATING_SCALE_MAX) {
      throw new RatingError(
        "invalid-axis-score",
        `rating axis "${axis.id}" must be an integer ${RATING_SCALE_MIN}–${RATING_SCALE_MAX}, got ${JSON.stringify(score)}`,
      );
    }
    parsed[axis.id] = score;
  }
  return parsed;
}

function parseFreeText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new RatingError("invalid-free-text", "free text must be a string");
  }
  const text = value.trim();
  if (text.length > SAFE_TEXT_MAX) {
    throw new RatingError("invalid-free-text", `free text is ${text.length} characters; the limit is ${SAFE_TEXT_MAX}`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new RatingError("invalid-free-text", "free text carries control characters");
  }
  return text;
}

function parseDefectTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RatingError("invalid-defect-tag", "defect tags must be an array of kebab-case tags");
  }
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new RatingError("invalid-defect-tag", `a defect tag must be a string, got ${JSON.stringify(raw)}`);
    }
    const tag = raw.trim().toLowerCase();
    if (!DEFECT_TAG.test(tag)) {
      throw new RatingError(
        "invalid-defect-tag",
        `"${raw}" is not a defect tag; use lowercase kebab-case, 1–64 characters (letters, digits, hyphen)`,
      );
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function parseAbSide(value: unknown, code: RatingErrorCode, what: string): AbSide {
  if (value !== "A" && value !== "B") {
    throw new RatingError(code, `${what} must be A or B, got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseRatedAt(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new RatingError("invalid-rated-at", `ratedAt must be an ISO timestamp, got ${JSON.stringify(value)}`);
  }
  return new Date(value).toISOString();
}

/**
 * File one rating against one queued item. The caller supplies the clock so a
 * session's date is reproducible in tests and the certificate's date is not
 * inferred from a file's mtime.
 */
export function fileRating(session: RatingSession, submission: RatingSubmission, ratedAt: string): RatingRecord {
  if (typeof submission !== "object" || submission === null) {
    throw new RatingError("invalid-session", "a rating submission must be an object");
  }
  const item = session.queue.find((entry) => entry.itemId === submission.itemId);
  if (!item) {
    throw new RatingError(
      "unknown-item",
      `"${String(submission.itemId)}" is not an item in session ${session.sessionId}; the queue is fixed when the session opens`,
    );
  }
  const axes = parseAxes(submission.axes);
  const freeText = parseFreeText(submission.freeText);
  const defectTags = parseDefectTags(submission.defectTags);

  let humanSide: AbSide | null = null;
  let preferredSide: AbSide | "neither" | null = null;
  let humanDetected: boolean | null = null;
  let preference: RatingPreference | null = null;

  if (item.ab) {
    if (submission.humanSide === undefined) {
      throw new RatingError("missing-ab-answer", `item ${item.itemId} has an A/B pair; which side sounds human is required`);
    }
    if (submission.preferredSide === undefined) {
      throw new RatingError("missing-ab-answer", `item ${item.itemId} has an A/B pair; which side you prefer is required`);
    }
    humanSide = parseAbSide(submission.humanSide, "invalid-ab-side", "humanSide");
    if (submission.preferredSide !== "A" && submission.preferredSide !== "B" && submission.preferredSide !== "neither") {
      throw new RatingError(
        "invalid-ab-side",
        `preferredSide must be A, B or neither, got ${JSON.stringify(submission.preferredSide)}`,
      );
    }
    preferredSide = submission.preferredSide;
    humanDetected = humanSide === item.ab.baselineSide;
    preference =
      preferredSide === "neither" ? "neither" : preferredSide === item.ab.agentSide ? "agent" : "baseline";
  } else if (submission.humanSide !== undefined || submission.preferredSide !== undefined) {
    throw new RatingError(
      "unexpected-ab-answer",
      `item ${item.itemId} has no A/B pair; an A/B answer cannot be recorded against a single recording`,
    );
  }

  return {
    schemaVersion: RATING_SESSION_SCHEMA_VERSION,
    sessionId: session.sessionId,
    reviewer: session.reviewer,
    ratedAt: parseRatedAt(ratedAt),
    itemId: item.itemId,
    callId: item.callId,
    axes,
    freeText,
    defectTags,
    humanSide,
    preferredSide,
    humanDetected,
    preference,
  };
}
