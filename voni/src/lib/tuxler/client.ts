/**
 * The client the runner starts: one relay session, one loopback health port.
 *
 * It attempts a session exactly once. A missing credential, a rejected login or a
 * dropped socket each become a health state with a reason — never a crash and
 * never a retry loop, because a client that quietly retries looks healthy while it
 * spends nothing and serves nothing.
 */
import { startSession, TuxlerSessionError, type SessionSnapshot, type TuxlerSession } from "./control";
import { tunneledTransport, type EndpointResolver } from "./transport";
import type { AsnLookup } from "./validate";
import type { TunnelDialer } from "./socks";
import {
  PoolUnavailableError,
  startExitPool,
  type BucketLink,
  type ExitLease,
  type ExitPool,
} from "./pool";
import {
  bucketId,
  buildHealth,
  startHealthServer,
  type HealthServer,
  type TuxlerHealth,
  type TuxlerHealthState,
} from "./health";

export type { TuxlerHealth } from "./health";

/** The pool's tuning, as the client exposes it. Defaults are the ticket's. */
export interface TuxlerPoolOptions {
  target?: number;
  refillBelow?: number;
  max?: number;
  /** Child buckets the refill tree may grow through, defaulting to three. */
  depth?: number;
  acquireWaitMs?: number;
  retryDelayMs?: number;
  changeTimeoutMs?: number;
  /** Changes one session sends in a row before a cooldown, defaulting to five. */
  paceBurst?: number;
  paceCooldownMs?: number;
  /** Silence after which a session is reconnected, defaulting to twenty seconds. */
  silenceMs?: number;
  /** The ASN classifier; defaults to the real Team Cymru lookup. */
  lookup?: AsnLookup;
  /** Override the tunnel to an exit — a parent-exit dial, for example. */
  dial?: TunnelDialer;
}

export interface TuxlerClientOptions {
  email?: string;
  password?: string;
  /** Defaults to `server1.ipsharkk.com`, the relay's entry point. */
  controlHost?: string;
  controlPort?: number;
  /** Where host names resolve. Identity in production; loopback in tests. */
  resolveEndpoint?: EndpointResolver;
  /** Loopback bind for the control API. Any other host is refused. */
  health?: { host?: string; port?: number };
  /** The pool fills itself as soon as the session is connected. `false` runs the
   *  session alone, for a diagnostic probe that must not spend a change. */
  pool?: TuxlerPoolOptions | false;
  silenceMs?: number;
  heartbeatSeconds?: number;
  stageTimeoutMs?: number;
}

export interface TuxlerClient {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  health: () => TuxlerHealth;
  /** Resolves when the first (and only) connection attempt has settled. */
  settled: () => Promise<TuxlerHealth>;
  /** The pool, once a session is live. `null` before the first login. */
  pool: () => ExitPool | null;
  /** Take an exit for one Click, or fail with a reason after the bounded wait. */
  acquire: (options?: { waitMs?: number }) => Promise<ExitLease>;
  /** Give the exit back: `good` keeps it, `failed` counts a strike. */
  release: (exitId: string, outcome: "good" | "failed") => Promise<void>;
  close: () => Promise<void>;
}

const ACCOUNT_REPORT_GRACE_MS = 2_000;

async function waitForAccountReport(session: TuxlerSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = session.snapshot();
    const reported =
      snapshot.account.changesLimit !== null && snapshot.clientIp !== null;
    if (reported || snapshot.state !== "connected" || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface State {
  phase: TuxlerHealthState;
  session: TuxlerSession | null;
  pool: ExitPool | null;
  lastError: { reason: string; message: string } | null;
  closed: boolean;
}

export async function startTuxlerClient(options: TuxlerClientOptions = {}): Promise<TuxlerClient> {
  const state: State = {
    phase: "starting",
    session: null,
    pool: null,
    lastError: null,
    closed: false,
  };
  const email = options.email ?? "";
  const password = options.password ?? "";

  const current = (): TuxlerHealth => {
    const snapshot: SessionSnapshot | null = state.session?.snapshot() ?? null;
    const clientIp = snapshot?.clientIp ?? null;
    return buildHealth({
      state: snapshot?.state ?? state.phase,
      snapshot,
      bucketId: clientIp === null ? null : bucketId(email, clientIp),
      lastError: state.lastError,
      pool: state.pool?.health(),
    });
  };

  const requirePool = (): ExitPool => {
    if (state.pool === null) {
      throw new PoolUnavailableError(
        "not-ready",
        state.lastError === null
          ? "the client has no live session yet"
          : `the client has no live session: ${state.lastError.message}`,
      );
    }
    return state.pool;
  };

  const server: HealthServer = await startHealthServer({
    host: options.health?.host,
    port: options.health?.port ?? 41000,
    snapshot: current,
    // The runner's only way in: the same bounded acquire and the same release
    // the pool exposes, never a second copy of the pool behind the port.
    acquire: async ({ waitMs }) => requirePool().acquire({ waitMs }),
    release: (exitId, outcome) => requirePool().release(exitId, outcome),
  });

  let settle: (health: TuxlerHealth) => void = () => {};
  const settled = new Promise<TuxlerHealth>((resolve) => {
    settle = resolve;
  });

  /** Every session this client dials, direct for the root and through an exit for a child. */
  const dialSession = async (link: BucketLink | null): Promise<TuxlerSession> =>
    startSession({
      host: options.controlHost ?? "server1.ipsharkk.com",
      port: options.controlPort ?? 29_990,
      email,
      password,
      resolveEndpoint: options.resolveEndpoint,
      silenceMs: options.silenceMs,
      heartbeatSeconds: options.heartbeatSeconds,
      stageTimeoutMs: options.stageTimeoutMs,
      transport: link === null ? undefined : tunneledTransport(link.dial),
    });

  const attempt = async (): Promise<void> => {
    try {
      const session = await dialSession(null);
      if (state.closed) {
        session.stop();
        return;
      }
      state.session = session;
      state.phase = "connected";
      // The account's own figures arrive right after LOGIN_FINISHED; settling once
      // they are in means a caller that awaits `settled()` never reads a report
      // that has no limit or no client address yet. Bounded, so a quiet relay
      // cannot hold the answer hostage.
      await waitForAccountReport(session, ACCOUNT_REPORT_GRACE_MS);
      if (!state.closed && options.pool !== false) {
        // Exits live on the relay this session was redirected to, and the pool
        // fills itself: nothing has to ask it for the first five.
        state.pool = startExitPool({
          session,
          relayHost: session.snapshot().host,
          resolveEndpoint: options.resolveEndpoint,
          bucketId: (clientIp) => (clientIp === null ? null : bucketId(email, clientIp)),
          target: options.pool?.target,
          refillBelow: options.pool?.refillBelow,
          max: options.pool?.max,
          depth: options.pool?.depth,
          acquireWaitMs: options.pool?.acquireWaitMs,
          retryDelayMs: options.pool?.retryDelayMs,
          changeTimeoutMs: options.pool?.changeTimeoutMs,
          paceBurst: options.pool?.paceBurst,
          paceCooldownMs: options.pool?.paceCooldownMs,
          silenceMs: options.pool?.silenceMs,
          lookup: options.pool?.lookup,
          dial: options.pool?.dial,
          // A child is dialled through the exit it is opened over; a silent root is
          // replaced here, so the pool's replacement is the client's session too.
          openSession: async (link) => {
            const replacement = await dialSession(link);
            if (link === null) state.session = replacement;
            return replacement;
          },
        });
      }
    } catch (error) {
      state.phase = "failed";
      state.lastError =
        error instanceof TuxlerSessionError
          ? { reason: error.reason, message: error.message }
          : {
              reason: "connect-failed",
              message: error instanceof Error ? error.message : String(error),
            };
    }
    settle(current());
  };
  void attempt();

  return {
    url: server.url,
    health: current,
    settled: () => settled,
    pool: () => state.pool,
    acquire: (acquireOptions) => {
      try {
        return requirePool().acquire(acquireOptions);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    release: async (exitId, outcome) => {
      await requirePool().release(exitId, outcome);
    },
    close: async () => {
      state.closed = true;
      const pool = state.pool;
      state.pool = null;
      // Stop the session first: a refill in flight rejects at once instead of
      // holding shutdown open until the relay's change timeout.
      state.session?.stop();
      await pool?.close();
      state.phase = state.phase === "failed" ? "failed" : "stopped";
      await server.close();
    },
  };
}
