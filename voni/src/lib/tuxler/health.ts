/**
 * The health report, and the loopback port it is served on.
 *
 * `/health` is the seam the runner and the console read: it says whether the
 * client can be trusted with a Click, what the account itself reported (the limit
 * from `LIMITS_INFO` — never an assumed ten), which reset it is on, and which
 * frames the session actually understood. It is bound to loopback and carries no
 * credential and no full account identifier; the meter is keyed by a hash of
 * (account, client egress IP), which is also how the relay meters it.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { changesRemaining, type TuxlerAccountState } from "./account";
import type { SessionSnapshot } from "./control";
import { POOL_ACQUIRE_WAIT_MS } from "./timing";

export type TuxlerHealthState = "starting" | "connected" | "failed" | "stopped";

export interface HealthBucket {
  /** Hash of (account, client egress IP). Never the account or the address itself. */
  clientIpHash: string | null;
  /** Changes spent since the last reset, as the account reports it. */
  used: number | null;
  /** The account's own limit; `null` when unlimited or not yet reported. */
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  /** 0 is the root bucket; a child bucket is 1 or deeper. Absent outside a pool. */
  depth?: number;
  /** The bucket this one was opened through, by `clientIpHash`. */
  parentId?: string | null;
}

export interface HealthExit {
  exitId: string;
  ip: string;
  /** ISO-3166 alpha-2, from the change reply. Always `US` for a pooled exit. */
  country: string;
  asn: string | null;
  city: string | null;
  /** The US state, from the reply's region. */
  state: string | null;
}

/** What the pool reports about itself. Read, never a reason to refill. */
export interface HealthPool {
  /** Exits a Click can take right now. */
  ready: number;
  exits: HealthExit[];
  /** Every bucket the pool can spend from; the root bucket first. */
  buckets: HealthBucket[];
  /** Change attempts the pool has made since it started. */
  refills: number;
  /** Sessions replaced after silence or a close, since the pool started. */
  reconnects: number;
  /** The last replacement, so health can name the reconnect rather than guess. */
  lastReconnect?: { at: string; depth: number; reason: string } | null;
}

export interface TuxlerHealth {
  ok: boolean;
  /** Whether a Click may use this client. Empty pool means no. */
  ready: boolean;
  /** Exits usable by a Click. Empty until a change reply names a port. */
  pool: HealthExit[];
  buckets: HealthBucket[];
  /** Change attempts the pool has made. The run artifact's refill count. */
  refills: number;
  /** Sessions the pool replaced after silence or a close. */
  reconnects: number;
  lastError: { reason: string; message: string } | null;
  account: {
    tier: TuxlerAccountState["tier"];
    premium: boolean | null;
    clientIp: string | null;
  };
  session: {
    state: TuxlerHealthState;
    controlHost: string | null;
    handshakeMs: number | null;
    heartbeatSeconds: number | null;
    silentForMs: number | null;
    /** Tags the session understood, in first-seen order. */
    frames: string[];
  };
}

export interface HealthInput {
  state: TuxlerHealthState;
  snapshot: SessionSnapshot | null;
  bucketId: string | null;
  lastError: { reason: string; message: string } | null;
  /** The pool's report. Absent while the client has no live session to pool. */
  pool?: HealthPool;
}

/** A stable, non-reversible meter key: the relay meters per account and egress IP. */
export function bucketId(account: string, clientIp: string): string {
  return createHash("sha256").update(`${account}\u0000${clientIp}`).digest("hex").slice(0, 16);
}

/**
 * The buckets the account's own figures describe. Empty until `LIMITS_INFO`
 * arrives, because a limit nobody reported is not a limit of ten. A pool adds its
 * child buckets itself; each one keeps its own `clientIpHash` and its own counts.
 */
export function bucketReport(
  clientIpHash: string | null,
  account: TuxlerAccountState,
): HealthBucket[] {
  if (account.changesLimit === null) return [];
  return [
    {
      clientIpHash,
      used: account.changesUsed,
      limit: account.changesLimit < 0 ? null : account.changesLimit,
      remaining: changesRemaining(account),
      resetAt: account.resetAt,
    },
  ];
}

export function buildHealth(input: HealthInput): TuxlerHealth {
  const snapshot = input.snapshot;
  const account = snapshot?.account ?? null;
  const state = snapshot?.state ?? input.state;
  const pool = input.pool;
  const buckets: HealthBucket[] =
    pool !== undefined
      ? pool.buckets
      : account === null
        ? []
        : bucketReport(input.bucketId, account);
  const failure = input.lastError ?? snapshot?.failure ?? null;
  const ok = state === "connected" && failure === null;
  return {
    ok,
    // A live session alone does not make the client usable: with a pool, a Click
    // needs at least one validated US exit to take.
    ready: pool === undefined ? ok : ok && pool.ready > 0,
    pool: pool?.exits ?? [],
    buckets,
    refills: pool?.refills ?? 0,
    reconnects: pool?.reconnects ?? 0,

    lastError: failure,
    account: {
      tier: account?.tier ?? "unknown",
      premium: account?.premium ?? null,
      clientIp: snapshot?.clientIp ?? null,
    },
    session: {
      state,
      controlHost: snapshot?.host ?? null,
      handshakeMs: snapshot?.handshakeMs ?? null,
      heartbeatSeconds: snapshot?.heartbeatSeconds ?? null,
      silentForMs: snapshot?.silentForMs ?? null,
      frames: snapshot?.frames ?? [],
    },
  };
}

export interface HealthServerOptions {
  host?: string;
  port?: number;
  snapshot: () => TuxlerHealth;
  /**
   * The pool's lease contract, when this client has one. Absent means `/acquire`
   * and `/release` answer "not ready" rather than pretending the pool is empty.
   */
  acquire?: (options: { waitMs: number }) => Promise<ControlExit>;
  release?: (exitId: string, outcome: "good" | "failed") => Promise<void>;
}

/** What one Click is handed over the loopback contract. */
export interface ControlExit {
  exitId: string;
  /** The relay host the exit lives on. */
  server: string;
  ip: string;
  /** ISO-3166 alpha-2, from the change reply. Always `US` for a pooled exit. */
  country: string;
  asn: string;
  city: string | null;
  state: string | null;
  /** `socks5h://127.0.0.1:<port>` — the only address a Click may use. */
  socksUrl: string;
  localPort: number;
}

export interface HealthServer {
  /** `http://127.0.0.1:<port>` — the only address the runner is given. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `the control API binds loopback only; refusing to listen on ${host}`,
    );
  }
}

export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const host = options.host ?? "127.0.0.1";
  assertLoopback(host);
  const server: Server = createServer((request, response) => {
    void handle(request, response, options).catch(() => {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson(response, 500, { error: "internal" });
    });
  });
  server.listen(options.port ?? 0, host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the health server has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** A longer wait only holds a Click, and a segment, for no more supply. */
const ACQUIRE_MAX_WAIT_MS = 60_000;
const RELEASE_MAX_BODY_BYTES = 1_024;

/** The four reasons the pool's own acquire names, as the control API relays them. */
const CONTROL_FAILURE_REASONS: readonly string[] = [
  "no-us-exit",
  "quota-spent",
  "relay-silent",
  "not-ready",
];

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.writeHead(405, { "content-type": "application/json", allow });
  response.end(JSON.stringify({ error: "method-not-allowed" }));
}

/** A pool refusal is the pool's named reason; anything else is a real failure. */
function poolFailureReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === "string" && CONTROL_FAILURE_REASONS.includes(reason)
    ? reason
    : null;
}

/** A bounded body read: the release payload is two fields, never a document. */
function readBodyWithinCap(
  request: IncomingMessage,
  cap: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Once the cap is passed the rest is discarded, not buffered; the response
    // still reaches the caller, which is the whole point of a 413.
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > cap) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => finish(null));
  });
}

function parseWait(raw: string | null): number | null {
  if (raw === null) return POOL_ACQUIRE_WAIT_MS;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value <= ACQUIRE_MAX_WAIT_MS ? value : null;
}

async function acquire(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    methodNotAllowed(response, "GET");
    return;
  }
  const waitMs = parseWait(new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("waitMs"));
  if (waitMs === null) {
    sendJson(response, 400, { error: "bad-wait" });
    return;
  }
  if (options.acquire === undefined) {
    sendJson(response, 503, { reason: "not-ready" });
    return;
  }
  try {
    const exit = await options.acquire({ waitMs });
    sendJson(response, 200, exit);
  } catch (error) {
    const reason = poolFailureReason(error);
    if (reason !== null) {
      sendJson(response, 503, { reason });
      return;
    }
    sendJson(response, 500, { error: "acquire-failed" });
  }
}

async function release(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions,
): Promise<void> {
  if (request.method !== "POST") {
    methodNotAllowed(response, "POST");
    return;
  }
  if (options.release === undefined) {
    sendJson(response, 503, { reason: "not-ready" });
    return;
  }
  const body = await readBodyWithinCap(request, RELEASE_MAX_BODY_BYTES);
  if (body === null) {
    sendJson(response, 413, { error: "too-large" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(response, 400, { error: "bad-json" });
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    sendJson(response, 400, { error: "bad-release" });
    return;
  }
  const record = parsed as { exitId?: unknown; ok?: unknown };
  if (
    typeof record.exitId !== "string" ||
    record.exitId.length === 0 ||
    record.exitId.length > 200 ||
    typeof record.ok !== "boolean"
  ) {
    sendJson(response, 400, { error: "bad-release" });
    return;
  }
  try {
    await options.release(record.exitId, record.ok ? "good" : "failed");
    response.writeHead(204);
    response.end();
  } catch {
    sendJson(response, 500, { error: "release-failed" });
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions,
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  const path = (request.url ?? "/").split("?")[0];
  if (path === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      methodNotAllowed(response, "GET");
      return;
    }
    const body = JSON.stringify(options.snapshot());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
    return;
  }
  if (path === "/acquire") {
    await acquire(request, response, options);
    return;
  }
  if (path === "/release") {
    await release(request, response, options);
    return;
  }
  sendJson(response, 404, { error: "not-found" });
}
