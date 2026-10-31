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
import {
  RECORD_MODES,
  StudioError,
  contentTypeFor,
  openTakeStore,
  type RecordMode,
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
const BODY_FIELDS = ["mode", "audioBase64", "labels", "prompt", "upload", "supersedes", "recordedAt"] as const;

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

function isBase64(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** Decode the Record surface's POST body. Unknown fields are refused, never ignored. */
function parseTakeBody(raw: unknown): TakeInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StudioError("invalid-body", "a take body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!(BODY_FIELDS as readonly string[]).includes(key)) {
      throw new StudioError("invalid-body", `a take body carries unknown field "${key}"; allowed: ${BODY_FIELDS.join(", ")}`);
    }
  }
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
  };
  if (mode === "upload") {
    return { ...common, mode: "upload", upload: body.upload as { filename: string; contentType?: string } };
  }
  if (mode === "dialogue") {
    return { ...common, mode: "dialogue", prompt: body.prompt as PromptCard };
  }
  return { ...common, mode: "one-shot", prompt: body.prompt as PromptCard };
}

function statusFor(error: StudioError, fallback: number): number {
  if (error.code === "unknown-route") return 404;
  if (error.code === "method-not-allowed") return 405;
  if (error.code === "studio-not-local") return 403;
  if (error.code === "surface-missing" || error.code === "malformed-dialogue" || error.code === "unreadable-dialogue") return 500;
  return fallback;
}

export type StudioHandlerOptions = {
  readonly store: TakeStore;
  readonly dialoguesDir: string;
  readonly surfacePath: string;
};

/** The route table, exported for the server entry and the tests. */
export function createStudioHandler(options: StudioHandlerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const { store, dialoguesDir, surfacePath } = options;

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
      let html: string;
      try {
        html = await readFile(surfacePath, "utf8");
      } catch (error) {
        throw new StudioError("surface-missing", `cannot read the record page ${surfacePath}: ${errorText(error)}`);
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }

    if (path === "/api/health") {
      if (method !== "GET") {
        sendJson(response, 405, { error: "method-not-allowed", message: `${method} /api/health is not a route` });
        return;
      }
      sendJson(response, 200, { ok: true, localOnly: true, takes: (await store.list()).length });
      return;
    }

    if (path === "/api/takes") {
      if (method === "GET") {
        sendJson(response, 200, { takes: await store.list() });
        return;
      }
      if (method === "POST") {
        const body = await readBody(request);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8")) as unknown;
        } catch (error) {
          throw new StudioError("invalid-body", `the take body is not valid JSON: ${errorText(error)}`);
        }
        const take = await store.land(parseTakeBody(parsed));
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
  const handler = createStudioHandler({
    store,
    dialoguesDir: options.dialoguesDir ?? join(HERE, "dialogues"),
    surfacePath: options.surfacePath ?? join(HERE, "record.html"),
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
