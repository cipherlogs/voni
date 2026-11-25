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
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { changesRemaining, type TuxlerAccountState } from "./account";
import type { SessionSnapshot } from "./control";

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
}

export interface TuxlerHealth {
  ok: boolean;
  /** Whether a Click may use this client. Empty pool means no. */
  ready: boolean;
  /** Exits usable by a Click. Empty until a change reply names a port. */
  pool: HealthExit[];
  buckets: HealthBucket[];
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
 * arrives, because a limit nobody reported is not a limit of ten. Ticket 06 adds
 * child buckets; each one keeps its own `clientIpHash` and its own counts.
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
    const url = request.url ?? "/";
    const path = url.split("?")[0];
    response.setHeader("cache-control", "no-store");
    if (path !== "/health") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not-found" }));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "application/json", allow: "GET" });
      response.end(JSON.stringify({ error: "method-not-allowed" }));
      return;
    }
    const body = JSON.stringify(options.snapshot());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
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
