/**
 * The Studio's local HTTP surface: one loopback server, no Next route.
 *
 * The Studio is deliberately not a page in the deployed app. It is a script
 * process that binds 127.0.0.1 (or ::1), serves `record.html` and accepts takes
 * over the same take store the tests drive. A production environment refuses
 * to start; a request whose Host names anything but loopback is refused by name
 * before a take is read or written. That is the whole reachability story: a
 * deployed build contains no Studio code, and the local process cannot be
 * reached from off the machine.
 *
 * The surface is the only caller; the store is the only writer. This module
 * decodes and validates transport, never invents a take.
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDialogues } from "./dialogues";
import { RATING_AXES, RatingError, type RatingSubmission } from "./rate";
import {
  RATING_ROOT_DIR,
  RatingStoreError,
  openRatingStore,
  type RatingStore,
} from "./rating-store";
import {
  RECORD_MODES,
  StudioError,
  contentTypeFor,
  openTakeStore,
  type RecordMode,
  type RetirementInput,
  type TakeInput,
  type PromptCard,
  type TakeLabels,
  type TakeStore,
} from "./take-store";

/** The named refusal a production environment or a non-loopback host receives. */
export const STUDIO_NOT_LOCAL = "studio-not-local";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const BODY_LIMIT = 40 * 1024 * 1024;
const TAKE_AUDIO_ROUTE = /^\/api\/takes\/(take-\d{6})\/audio$/;
const TAKE_RETIRE_ROUTE = /^\/api\/takes\/(take-\d{6})\/retire$/;
const RATE_SESSION_ROUTE = /^\/api\/rate\/sessions\/(rating-[0-9a-f]{64})$/;
const RATE_ITEM_AUDIO_ROUTE = /^\/api\/rate\/sessions\/(rating-[0-9a-f]{64})\/items\/(item-\d{3})\/(call|ab\/a|ab\/b)$/;
const RATE_RATINGS_ROUTE = /^\/api\/rate\/sessions\/(rating-[0-9a-f]{64})\/ratings$/;
const RATE_EXPORT_ROUTE = /^\/api\/rate\/sessions\/(rating-[0-9a-f]{64})\/export$/;
const BODY_FIELDS = ["mode", "audioBase64", "labels", "prompt", "upload", "supersedes", "recordedAt", "baseline"] as const;
const RETIRE_BODY_FIELDS = ["reviewer", "reason", "retiredAt"] as const;
const RATE_SESSION_BODY_FIELDS = ["reviewer", "certificate", "calls", "seed", "cleanPerLocale"] as const;
const RATING_BODY_FIELDS = ["itemId", "axes", "freeText", "defectTags", "humanSide", "preferredSide"] as const;

/**
 * Refuse a production environment by name. The Studio is an owner's local
 * tool: if the process believes it is a deployed build, it does not start.
 */
export type StudioEnv = Record<string, string | undefined>;

export function assertLocalOnly(env: StudioEnv = process.env): void {
  const marker = env.NODE_ENV === "production"
    ? "NODE_ENV=production"
    : env.VONI_STUDIO_TARGET === "production"
      ? "VONI_STUDIO_TARGET=production"
      : env.STUDIO_TARGET === "production"
        ? "STUDIO_TARGET=production"
        : null;
  if (marker) {
    throw new StudioError(
      STUDIO_NOT_LOCAL,
      `the Studio is local-only and is absent from the deployed build; refused to start under ${marker}. ` +
        "Run it from the repository with `npm run demo:studio` on the machine that records the takes.",
    );
  }
}

/** Is this Host header a loopback name? A port is allowed; a deploy host is not. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (typeof host !== "string" || host.trim().length === 0) return false;
  try {
    const { hostname } = new URL(`http://${host.trim()}`);
    const name = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return LOOPBACK_NAMES.has(name);
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > BODY_LIMIT) {
      throw new StudioError("invalid-body", `the request body exceeds ${BODY_LIMIT} bytes; a take is caller audio, not a session`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch (error) {
    throw new StudioError("invalid-body", `the request body is not valid JSON: ${errorText(error)}`);
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StudioError("invalid-body", `${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function refuseUnknownFields(body: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new StudioError("invalid-body", `${what} carries unknown field "${key}"; allowed: ${allowed.join(", ")}`);
    }
  }
}

function isBase64(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** Decode the Record surface's POST body. Unknown fields are refused, never ignored. */
function parseTakeBody(raw: unknown): TakeInput {
  const body = asObject(raw, "a take body");
  refuseUnknownFields(body, BODY_FIELDS, "a take body");
  const mode = body.mode;
  if (typeof mode !== "string" || !(RECORD_MODES as readonly string[]).includes(mode)) {
    throw new StudioError("invalid-body", `a take's mode must be one of ${RECORD_MODES.join(", ")}, got ${JSON.stringify(mode)}`);
  }
  if (!isBase64(body.audioBase64)) {
    throw new StudioError("invalid-body", "a take body needs base64 audio in audioBase64");
  }
  if (body.labels === undefined) {
    throw new StudioError("missing-label", "a take body needs labels: intent, emotion and accent are never defaulted");
  }
  const audio = Buffer.from(body.audioBase64, "base64");
  const common = {
    audio,
    labels: body.labels as TakeLabels,
    ...(typeof body.supersedes === "string" ? { supersedes: body.supersedes } : {}),
    ...(typeof body.recordedAt === "string" ? { recordedAt: body.recordedAt } : {}),
    ...(body.baseline === undefined ? {} : { baseline: body.baseline as TakeInput["baseline"] }),
  };
  if (mode === "upload") {
    return { ...common, mode: "upload", upload: body.upload as { filename: string; contentType?: string } };
  }
  if (mode === "dialogue") {
    return { ...common, mode: "dialogue", prompt: body.prompt as PromptCard };
  }
  return { ...common, mode: "one-shot", prompt: body.prompt as PromptCard };
}

function parseRetireBody(raw: unknown): RetirementInput {
  const body = asObject(raw, "a retirement body");
  refuseUnknownFields(body, RETIRE_BODY_FIELDS, "a retirement body");
  if (body.retiredAt !== undefined && typeof body.retiredAt !== "string") {
    throw new StudioError("invalid-body", "a retirement's retiredAt must be an ISO timestamp string");
  }
  return {
    reviewer: body.reviewer as string,
    reason: body.reason as string,
    ...(typeof body.retiredAt === "string" ? { retiredAt: body.retiredAt } : {}),
  };
}

function parseRateSessionBody(raw: unknown): {
  reviewer: string;
  certificate: Parameters<RatingStore["create"]>[0]["certificate"];
  calls: Parameters<RatingStore["create"]>[0]["calls"];
  seed?: number;
  cleanPerLocale?: number;
} {
  const body = asObject(raw, "a rating session body");
  refuseUnknownFields(body, RATE_SESSION_BODY_FIELDS, "a rating session body");
  if (body.certificate === undefined) {
    throw new StudioError("invalid-body", "a rating session needs the certificate it samples");
  }
  if (!Array.isArray(body.calls)) {
    throw new StudioError("invalid-body", "a rating session needs a calls array");
  }
  if (body.seed !== undefined && typeof body.seed !== "number") {
    throw new StudioError("invalid-body", "a rating session's seed must be a number");
  }
  if (body.cleanPerLocale !== undefined && typeof body.cleanPerLocale !== "number") {
    throw new StudioError("invalid-body", "a rating session's cleanPerLocale must be a number");
  }
  return {
    reviewer: body.reviewer as string,
    certificate: body.certificate as Parameters<RatingStore["create"]>[0]["certificate"],
    calls: body.calls as Parameters<RatingStore["create"]>[0]["calls"],
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
    ...(typeof body.cleanPerLocale === "number" ? { cleanPerLocale: body.cleanPerLocale } : {}),
  };
}

function parseRatingBody(raw: unknown): RatingSubmission {
  const body = asObject(raw, "a rating body");
  refuseUnknownFields(body, RATING_BODY_FIELDS, "a rating body");
  if (body.freeText !== undefined && typeof body.freeText !== "string") {
    throw new StudioError("invalid-body", "a rating's freeText must be a string");
  }
  if (body.defectTags !== undefined && !Array.isArray(body.defectTags)) {
    throw new StudioError("invalid-body", "a rating's defectTags must be an array of tags");
  }
  return {
    itemId: body.itemId as string,
    axes: body.axes as RatingSubmission["axes"],
    ...(typeof body.freeText === "string" ? { freeText: body.freeText } : {}),
    ...(Array.isArray(body.defectTags) ? { defectTags: body.defectTags as string[] } : {}),
    ...(body.humanSide !== undefined ? { humanSide: body.humanSide as RatingSubmission["humanSide"] } : {}),
    ...(body.preferredSide !== undefined ? { preferredSide: body.preferredSide as RatingSubmission["preferredSide"] } : {}),
  };
}

function statusFor(error: StudioError, fallback: number): number {
  if (error.code === "unknown-route" || error.code === "unknown-take") return 404;
  if (error.code === "method-not-allowed") return 405;
  if (error.code === "already-retired") return 409;
  if (error.code === "studio-not-local") return 403;
  if (error.code === "surface-missing" || error.code === "malformed-dialogue" || error.code === "unreadable-dialogue") return 500;
  return fallback;
}

function ratingStatusFor(error: RatingError | RatingStoreError): number {
  if (error instanceof RatingError) {
    return error.code === "unknown-item" ? 404 : 400;
  }
  if (error.code === "unknown-session") return 404;
  if (error.code === "session-exists" || error.code === "rating-already-filed") return 409;
  if (error.code === "malformed-session" || error.code === "session-io") return 500;
  return 400;
}

export type StudioHandlerOptions = {
  readonly store: TakeStore;
  readonly ratingStore: RatingStore;
  readonly dialoguesDir: string;
  readonly surfacePath: string;
  readonly rateSurfacePath: string;
  readonly corpusSurfacePath: string;
};

/** The route table, exported for the server entry and the tests. */
export function createStudioHandler(options: StudioHandlerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const { store, ratingStore, dialoguesDir, surfacePath, rateSurfacePath, corpusSurfacePath } = options;

  async function serveSurface(response: ServerResponse, path: string, label: string): Promise<void> {
    let html: string;
    try {
      html = await readFile(path, "utf8");
    } catch (error) {
      throw new StudioError("surface-missing", `cannot read the ${label} page ${path}: ${errorText(error)}`);
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host;
    if (!isLoopbackHost(host)) {
      sendJson(response, 403, {
        error: STUDIO_NOT_LOCAL,
        message:
          `the Studio is local-only and absent from the deployed build; refused a request for host ${JSON.stringify(host ?? "")}. ` +
          "Open the loopback URL printed by `npm run demo:studio` on the recording machine.",
      });
      return;
    }
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, {
        error: STUDIO_NOT_LOCAL,
        message: `the Studio is local-only; refused a connection from ${request.socket.remoteAddress ?? "an unknown address"}`,
      });
      return;
    }

    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/") {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} / is not a route; the record page is a GET` });
        return;
      }
      await serveSurface(response, surfacePath, "record");
      return;
    }

    if (path === "/rate") {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} /rate is not a route; the rate page is a GET` });
        return;
      }
      await serveSurface(response, rateSurfacePath, "rate");
      return;
    }

    if (path === "/corpus") {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} /corpus is not a route; the corpus page is a GET` });
        return;
      }
      await serveSurface(response, corpusSurfacePath, "corpus");
      return;
    }

    if (path === "/api/health") {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} /api/health is not a route` });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        localOnly: true,
        takes: (await store.list()).length,
        ratingSessions: (await ratingStore.list()).length,
      });
      return;
    }

    if (path === "/api/takes") {
      if (method === "GET") {
        sendJson(response, 200, { takes: await store.list() });
        return;
      }
      if (method === "POST") {
        const take = await store.land(parseTakeBody(await readJsonBody(request)));
        sendJson(response, 201, { take });
        return;
      }
      sendJson(response, 405, { error: "method-not-allowed", message: `${method} /api/takes is not a route; use GET or POST` });
      return;
    }

    const audioMatch = TAKE_AUDIO_ROUTE.exec(path);
    if (audioMatch) {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} is not a route; take audio is a GET` });
        return;
      }
      const { record, bytes } = await store.read(audioMatch[1]);
      response.writeHead(200, {
        "content-type": contentTypeFor(record.audioFormat),
        "content-length": bytes.byteLength,
        "cache-control": "no-store",
        "x-take-sha256": record.audioSha256,
      });
      response.end(bytes);
      return;
    }

    const retireMatch = TAKE_RETIRE_ROUTE.exec(path);
    if (retireMatch) {
      if (method !== "POST") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} is not a route; retiring a take is a POST` });
        return;
      }
      const retirement = await store.retire(retireMatch[1], parseRetireBody(await readJsonBody(request)));
      sendJson(response, 201, { retirement });
      return;
    }

    if (path === "/api/corpus") {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} /api/corpus is not a route; the corpus is a GET` });
        return;
      }
      sendJson(response, 200, { takes: await store.corpus() });
      return;
    }

    if (path === "/api/rate/axes") {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} /api/rate/axes is not a route` });
        return;
      }
      sendJson(response, 200, { axes: RATING_AXES });
      return;
    }

    if (path === "/api/rate/sessions") {
      if (method === "GET") {
        sendJson(response, 200, { sessions: await ratingStore.list() });
        return;
      }
      if (method === "POST") {
        const created = await ratingStore.create(parseRateSessionBody(await readJsonBody(request)));
        sendJson(response, 201, { session: created.blind });
        return;
      }
      sendJson(response, 405, { error: "method-not-allowed", message: `${method} /api/rate/sessions is not a route; use GET or POST` });
      return;
    }

    const rateSessionMatch = RATE_SESSION_ROUTE.exec(path);
    if (rateSessionMatch) {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} is not a route; a blind session is a GET` });
        return;
      }
      sendJson(response, 200, { session: await ratingStore.blind(rateSessionMatch[1]) });
      return;
    }

    const rateAudioMatch = RATE_ITEM_AUDIO_ROUTE.exec(path);
    if (rateAudioMatch) {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} is not a route; rate audio is a GET` });
        return;
      }
      const rawSide = rateAudioMatch[3];
      const side = rawSide === "call" ? "call" : rawSide === "ab/a" ? "A" : "B";
      const audio = await ratingStore.audio(rateAudioMatch[1], rateAudioMatch[2], side);
      response.writeHead(200, {
        "content-type": audio.contentType,
        "content-length": audio.bytes.byteLength,
        "cache-control": "no-store",
      });
      response.end(audio.bytes);
      return;
    }

    const rateRatingsMatch = RATE_RATINGS_ROUTE.exec(path);
    if (rateRatingsMatch) {
      if (method === "GET") {
        sendJson(response, 200, { ratings: await ratingStore.ratings(rateRatingsMatch[1]) });
        return;
      }
      if (method === "POST") {
        const rating = await ratingStore.fileRating(rateRatingsMatch[1], parseRatingBody(await readJsonBody(request)));
        sendJson(response, 201, { rating });
        return;
      }
      sendJson(response, 405, { error: "method-not-allowed", message: `${method} is not a route; ratings are GET or POST` });
      return;
    }

    const rateExportMatch = RATE_EXPORT_ROUTE.exec(path);
    if (rateExportMatch) {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} is not a route; gold labels are a GET` });
        return;
      }
      sendJson(response, 200, await ratingStore.goldLabels(rateExportMatch[1]));
      return;
    }

    if (path === "/api/dialogues") {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} /api/dialogues is not a route; scripts are authored as files` });
        return;
      }
      sendJson(response, 200, { dialogues: await loadDialogues(dialoguesDir) });
      return;
    }

    throw new StudioError("unknown-route", `${method} ${path} is not a Studio route`);
  }

  return (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof RatingError) {
        sendJson(response, ratingStatusFor(error), { error: error.code, message: error.message });
        return;
      }
      if (error instanceof RatingStoreError) {
        sendJson(response, ratingStatusFor(error), { error: error.code, message: error.message });
        return;
      }
      if (error instanceof StudioError) {
        sendJson(response, statusFor(error, 400), { error: error.code, message: error.message });
        return;
      }
      sendJson(response, 500, {
        error: "studio-io",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type StudioOptions = {
  /** Store root; `voni/.studio` in normal use. */
  readonly root: string;
  /** Must be loopback; defaults to 127.0.0.1. */
  readonly host?: string;
  /** 0 asks the OS for a free port; the printed URL is the truth. */
  readonly port?: number;
  /** Authored dialogue scripts; defaults to `./dialogues` beside this module. */
  readonly dialoguesDir?: string;
  /** The record page; defaults to `./record.html` beside this module. */
  readonly surfacePath?: string;
  /** The rate page; defaults to `./rate.html` beside this module. */
  readonly rateSurfacePath?: string;
  /** The corpus page; defaults to `./corpus.html` beside this module. */
  readonly corpusSurfacePath?: string;
  /** Audio evidence root; a call path outside it is refused. Defaults to `voni/evidence`. */
  readonly evidenceRoot?: string;
  /** Rating session root; defaults to `<root>/rating`. */
  readonly ratingRoot?: string;
  readonly env?: StudioEnv;
  readonly now?: () => Date;
};

export type RunningStudio = {
  readonly server: Server;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** Start the local Studio. Bind loopback only; refuse a production environment. */
export async function startStudio(options: StudioOptions): Promise<RunningStudio> {
  const env = options.env ?? process.env;
  assertLocalOnly(env);
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new StudioError(
      STUDIO_NOT_LOCAL,
      `the Studio binds loopback only; refused host ${JSON.stringify(host)}. ` +
        "A Studio reachable from the network is a Studio reachable from production.",
    );
  }
  const store = await openTakeStore({ root: options.root, ...(options.now ? { now: options.now } : {}) });
  const ratingStore = await openRatingStore({
    root: options.ratingRoot ?? join(options.root, RATING_ROOT_DIR),
    evidenceRoot: options.evidenceRoot ?? join(HERE, "../../evidence"),
    ...(options.now ? { now: options.now } : {}),
  });
  const handler = createStudioHandler({
    store,
    ratingStore,
    dialoguesDir: options.dialoguesDir ?? join(HERE, "dialogues"),
    surfacePath: options.surfacePath ?? join(HERE, "record.html"),
    rateSurfacePath: options.rateSurfacePath ?? join(HERE, "rate.html"),
    corpusSurfacePath: options.corpusSurfacePath ?? join(HERE, "corpus.html"),
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return {
    server,
    url,
    host,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Re-exported so the entry script and tests agree on the mode vocabulary. */
export type { RecordMode };
