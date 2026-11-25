/**
 * The client the runner starts: one relay session, one loopback health port.
 *
 * It attempts a session exactly once. A missing credential, a rejected login or a
 * dropped socket each become a health state with a reason — never a crash and
 * never a retry loop, because a client that quietly retries looks healthy while it
 * spends nothing and serves nothing.
 */
import { startSession, TuxlerSessionError, type SessionSnapshot, type TuxlerSession } from "./control";
import type { EndpointResolver } from "./transport";
import {
  bucketId,
  buildHealth,
  startHealthServer,
  type HealthServer,
  type TuxlerHealth,
  type TuxlerHealthState,
} from "./health";

export type { TuxlerHealth } from "./health";

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
  lastError: { reason: string; message: string } | null;
  closed: boolean;
}

export async function startTuxlerClient(options: TuxlerClientOptions = {}): Promise<TuxlerClient> {
  const state: State = { phase: "starting", session: null, lastError: null, closed: false };
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
    });
  };

  const server: HealthServer = await startHealthServer({
    host: options.health?.host,
    port: options.health?.port ?? 41000,
    snapshot: current,
  });

  let settle: (health: TuxlerHealth) => void = () => {};
  const settled = new Promise<TuxlerHealth>((resolve) => {
    settle = resolve;
  });

  const attempt = async (): Promise<void> => {
    try {
      const session = await startSession({
        host: options.controlHost ?? "server1.ipsharkk.com",
        port: options.controlPort ?? 29_990,
        email,
        password,
        resolveEndpoint: options.resolveEndpoint,
        silenceMs: options.silenceMs,
        heartbeatSeconds: options.heartbeatSeconds,
        stageTimeoutMs: options.stageTimeoutMs,
      });
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
    close: async () => {
      state.closed = true;
      state.session?.stop();
      state.phase = state.phase === "failed" ? "failed" : "stopped";
      await server.close();
    },
  };
}
