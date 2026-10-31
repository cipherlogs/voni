/**
 * Dev-only browser call marks: what the visitor actually experienced.
 *
 * The landing demo writes one artifact per call — start requested, mint done,
 * microphone acquired, config sent, socket open, admission or refusal,
 * connected painted, first audible sample, chime, turns, the end receipt and
 * teardown — beside the delivered WAV, under the same call id.
 *
 * The stream exists only when the existing delivered-capture flag is on
 * (`?delivercapture=1`) or in the isolated E2E test build, so ordinary
 * production traffic writes none. It is observation only: a mark is an
 * in-memory append, the artifact is posted once on teardown without being
 * awaited, and a failing or hanging sink warns instead of touching the call.
 */
import { DELIVERED_CAPTURE_DIR, deliveredCaptureRequested } from "./delivered-capture";

/** Dev sink that writes the marks artifact; production never receives a call. */
export const CALL_MARKS_ENDPOINT = "/api/dev/call-marks";
/** Beside the delivered WAV: gitignored working files. */
export const CALL_MARKS_DIR = DELIVERED_CAPTURE_DIR;
export const CALL_MARKS_SCHEMA_VERSION = 1;
/** A dev sink that is gone must not hold up a hang-up. */
const MARKS_UPLOAD_TIMEOUT_MS = 2000;

/**
 * Test-build seam, the same build-time opt-in as the delivered capture:
 * `scripts/e2e-run.mjs` builds its throwaway candidate with this set, so the
 * browser E2E can write real marks from a production-mode build. It is
 * inlined at build time; an ordinary `npm run build` never sees it.
 */
export const CALL_MARKS_TEST_BUILD =
  process.env.NEXT_PUBLIC_VONI_E2E_CAPTURE === "1";

/** The named dev-only refusal a production build answers with. */
export const CALL_MARKS_PRODUCTION_REFUSAL = Object.freeze({
  code: "dev-only",
  error: "call marks sink is dev-only; a production build refuses it by name",
});

/**
 * The lifecycle marks this client can name. A turn repeats by design: each
 * final turn is its own mark, and a second chime is a second mark.
 */
export const CALL_MARK_NAMES = [
  "start_requested",
  "mint_done",
  "ringback_start",
  "ringback_stop",
  "microphone_acquired",
  "config_sent",
  "socket_open",
  "admitted",
  "refused",
  "connected_painted",
  "first_audible",
  "chime",
  "talk_clock_start",
  "turn",
  "end_call_received",
  "end_received",
  "error_received",
  "start_failed",
  "teardown",
  "delivered_capture",
] as const;

export type CallMarkName = (typeof CALL_MARK_NAMES)[number];

export type CallMark = {
  name: CallMarkName;
  /** Wall clock, ISO 8601 UTC. */
  at: string;
  /** Wall clock, epoch milliseconds. */
  epochMs: number;
  /** Call-relative milliseconds, from the moment the marks began. */
  tMs: number;
  detail?: Record<string, unknown>;
};

export type CallMarksArtifact = {
  schemaVersion: typeof CALL_MARKS_SCHEMA_VERSION;
  callId: string;
  startedAt: string;
  endedAt: string | null;
  marks: CallMark[];
};

/** A call id that is a bare, safe component; the same rule the dev sink uses. */
const SAFE_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The call id the mint carries, read from the browser's demo call token.
 *
 * The token is `<callId>.<exp>.<start>.<nonce>[.<tagId>].<hmac>`; the first
 * segment is the call id the mint signed and the pipeline traces. The browser
 * cannot verify the HMAC, and does not need to: it only needs the id to bind
 * the WAV and the marks to the call the service will run. A token that does not
 * begin with a safe id returns null, and the caller keeps its own id rather
 * than inventing one.
 */
export function callIdFromDemoToken(token: string): string | null {
  const first = token.split(".")[0] ?? "";
  if (!SAFE_CALL_ID.test(first) || first.includes("..")) return null;
  return first;
}

/** One artifact write; the dev route by default, a fake in tests. */
export type CallMarksWrite = (artifact: CallMarksArtifact) => void | Promise<void>;

export type CallMarksOptions = {
  callId?: string;
  now?: () => number;
  post?: CallMarksWrite;
  warn?: (line: string) => void;
};

function newCallId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Accumulate one call's marks and post them once. `mark` never does I/O; the
 * caller runs it on the same tick as the event it names, so ordering and
 * call-relative time stay honest.
 */
export class CallMarks {
  private _callId: string;
  private readonly now: () => number;
  private readonly post: CallMarksWrite;
  private readonly warn: (line: string) => void;
  private readonly startEpochMs: number;
  private readonly startedAt: string;
  private readonly entries: CallMark[] = [];
  private endedAt: string | null = null;
  private finished = false;

  constructor(opts: CallMarksOptions = {}) {
    this._callId = opts.callId ?? newCallId();
    this.now = opts.now ?? (() => Date.now());
    this.post = opts.post ?? postCallMarks;
    this.warn = opts.warn ?? ((line) => console.warn(line));
    this.startEpochMs = this.now();
    this.startedAt = new Date(this.startEpochMs).toISOString();
  }

  /** The call id the artifact will carry. */
  get callId(): string {
    return this._callId;
  }

  /**
   * Bind this call's evidence to the call id the mint named. A mark written
   * before the mint (the start request) keeps its own time; only the identity
   * moves, so the WAV and the marks share the trace's call. A finished
   * recorder, or an id that is not a safe path component, refuses the rebind.
   */
  adoptCallId(callId: string): boolean {
    if (this.finished) return false;
    if (!SAFE_CALL_ID.test(callId) || callId.includes("..")) return false;
    this._callId = callId;
    return true;
  }

  /** Append one mark. A late mark after `finish` is dropped, never thrown. */
  mark(name: CallMarkName, detail?: Record<string, unknown>): void {
    if (this.finished) return;
    const epochMs = this.now();
    this.entries.push({
      name,
      at: new Date(epochMs).toISOString(),
      epochMs,
      tMs: Math.max(0, epochMs - this.startEpochMs),
      ...(detail && Object.keys(detail).length > 0 ? { detail } : {}),
    });
  }

  /** The current artifact; a live call has `endedAt: null`. */
  artifact(): CallMarksArtifact {
    return {
      schemaVersion: CALL_MARKS_SCHEMA_VERSION,
      callId: this.callId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      marks: this.entries.map((mark) => ({ ...mark, ...(mark.detail ? { detail: { ...mark.detail } } : {}) })),
    };
  }

  /**
   * Post the one artifact. Never rejects and never blocks the caller: the
   * call path uses `void marks.finish()`, and a failing writer only warns. A
   * second finish is a no-op, so exactly one artifact is written.
   */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.endedAt = new Date(this.now()).toISOString();
    const artifact = this.artifact();
    try {
      await this.post(artifact);
    } catch (e) {
      this.warn(
        `[call-marks] write failed for ${this.callId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** The existing capture flag is the only gate; there is no second switch. */
export function callMarksRequested(
  search: string,
  production: boolean,
  testBuild: boolean = CALL_MARKS_TEST_BUILD,
): boolean {
  return deliveredCaptureRequested(search, production, testBuild);
}

/** Build a recorder only where the capture flag allows one; `null` writes none. */
export function createCallMarks(
  search: string,
  production: boolean,
  testBuild: boolean = CALL_MARKS_TEST_BUILD,
  opts: CallMarksOptions = {},
): CallMarks | null {
  if (!callMarksRequested(search, production, testBuild)) return null;
  return new CallMarks(opts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** The one shape check the dev sink and tests share. */
export function isCallMarksArtifact(value: unknown): value is CallMarksArtifact {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== CALL_MARKS_SCHEMA_VERSION) return false;
  if (typeof value.callId !== "string" || value.callId.length === 0) return false;
  if (!isIsoDate(value.startedAt)) return false;
  if (value.endedAt !== null && !isIsoDate(value.endedAt)) return false;
  if (!Array.isArray(value.marks) || value.marks.length === 0) return false;
  return value.marks.every((mark) => {
    if (!isRecord(mark)) return false;
    if (typeof mark.name !== "string" || mark.name.length === 0) return false;
    if (!isIsoDate(mark.at)) return false;
    if (typeof mark.epochMs !== "number" || !Number.isFinite(mark.epochMs)) return false;
    if (typeof mark.tMs !== "number" || !Number.isFinite(mark.tMs) || mark.tMs < 0) return false;
    return mark.detail === undefined || isRecord(mark.detail);
  });
}

/** Browser sink: hand the artifact to the dev-only route. */
export async function postCallMarks(artifact: CallMarksArtifact): Promise<void> {
  const url = `${CALL_MARKS_ENDPOINT}?callId=${encodeURIComponent(artifact.callId)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(artifact),
    signal: AbortSignal.timeout(MARKS_UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`call marks upload failed: ${response.status}`);
  const saved = (await response.json().catch(() => null)) as { path?: string } | null;
  if (saved?.path) console.info(`[call-marks] ${saved.path}`);
}
