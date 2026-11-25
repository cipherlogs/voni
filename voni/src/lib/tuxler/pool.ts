/**
 * The pool: ready exits, kept at five and replaced when they fail.
 *
 * Three rules decide everything here. Changes are spent on refills only, so an
 * acquire or a release never sends `CHANGE_IP_COUNTRY_CITY`. A refill is paced by
 * need — the pool fills to the target and then waits until fewer than three exits
 * remain, so two spare exits absorb a replacement without a spend. A death is
 * replaced at once (plan §4.3), because an exit that twice failed is gone and the
 * pool below its target serves fewer Clicks. Eight is a hard ceiling: a refusal to
 * exceed it happens before any change is sent or any listener bound.
 *
 * The report is read-only by construction: `snapshot()` and `health()` read the
 * session's account frames and the pool's map, and never kick a refill.
 */
import type { TuxlerSession } from "./control";
import { ExitRejectedError, openUsExit, type ExitFailureReason, type TuxlerExit } from "./exit";
import { bucketReport, type HealthBucket, type HealthPool } from "./health";
import type { EndpointResolver } from "./transport";
import type { TunnelDialer } from "./socks";
import type { AsnLookup } from "./validate";

/** Ready exits the pool aims for. */
export const POOL_TARGET = 5;
/** A refill starts when fewer exits than this are ready. */
export const POOL_REFILL_BELOW = 3;
/** The pool never owns more than this many exits, leased ones included. */
export const POOL_MAX = 8;
/** How long an acquire waits before it fails loudly. */
export const POOL_ACQUIRE_WAIT_MS = 10_000;

/** Why an acquire could not be served. The four reasons the control API names. */
export type PoolUnavailableReason = "no-us-exit" | "quota-spent" | "relay-silent" | "not-ready";

const REASON_TEXT: Record<PoolUnavailableReason, string> = {
  "no-us-exit": "no US exit could be obtained",
  "quota-spent": "the change bucket has nothing left",
  "relay-silent": "the relay stopped answering",
  "not-ready": "the pool is not serving exits yet",
};

export class PoolUnavailableError extends Error {
  constructor(
    readonly reason: PoolUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = "PoolUnavailableError";
  }
}

/** What one Click is given, and what it writes on its row. */
export interface ExitLease {
  /** The relay's `ip:port`; unique while the exit lives. */
  readonly exitId: string;
  /** The relay host the exit lives on. */
  readonly server: string;
  readonly ip: string;
  /** US by construction: nothing else is ever pooled. */
  readonly country: string;
  readonly asn: string;
  readonly city: string | null;
  /** The US state from the change reply's region. */
  readonly state: string | null;
  /** `socks5h://127.0.0.1:<port>` — what a browser context is handed. */
  readonly socksUrl: string;
  readonly localPort: number;
}

export interface PoolExitReport {
  exitId: string;
  ip: string;
  /** The relay's port, from the change reply. */
  port: number;
  country: string;
  state: string | null;
  city: string | null;
  asn: string;
  localPort: number;
  socksUrl: string;
  status: "ready" | "leased";
  /** Consecutive failed releases; the second one kills the exit. */
  strikes: number;
  /** Tunnels this exit has carried. */
  requests: number;
}

export interface PoolSnapshot {
  target: number;
  refillBelow: number;
  max: number;
  /** Exits a Click can take right now. */
  ready: number;
  /** Every exit the pool owns, leased included. */
  total: number;
  exits: PoolExitReport[];
  /** Every bucket the pool can spend from; the root bucket first. */
  buckets: HealthBucket[];
  /** Change attempts the pool has made since it started. */
  refills: number;
  lastError: { reason: string; message: string } | null;
}

export type PoolSession = Pick<TuxlerSession, "requestChange" | "snapshot">;

export interface ExitPoolOptions {
  session: PoolSession;
  /** The relay host the exits live on, e.g. `server3.ipsharkk.com`. */
  relayHost: string;
  /** The meter key for the root bucket; `null` when the address is not known yet. */
  bucketId?: () => string | null;
  target?: number;
  refillBelow?: number;
  max?: number;
  /** Defaults to ten seconds: one refill plus a handshake. */
  acquireWaitMs?: number;
  /** How long to wait before another refill attempt after a supply failure. */
  retryDelayMs?: number;
  changeTimeoutMs?: number;
  lookup?: AsnLookup;
  resolveEndpoint?: EndpointResolver;
  dial?: TunnelDialer;
}

export interface ExitPool {
  /** Start filling. Idempotent; the pool reaches the target without a request. */
  start: () => void;
  /** Read-only. Reading it never spends a change or starts a refill. */
  snapshot: () => PoolSnapshot;
  /** Read-only, shaped for `/health`. */
  health: () => HealthPool;
  /** Take one exit, or fail with a reason after `waitMs`. Never spends a change. */
  acquire: (options?: { waitMs?: number }) => Promise<ExitLease>;
  /** Give an exit back. `failed` counts a strike; the second one kills it. */
  release: (exitId: string, outcome: "good" | "failed") => Promise<void>;
  /** Close every listener the pool owns, then fill a fresh pool. */
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

interface Entry {
  exit: TuxlerExit;
  leased: boolean;
  strikes: number;
}

interface Waiter {
  resolve: (lease: ExitLease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type FillOutcome = "created" | "retry" | "stop";

function bounded(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

/** Each failure reason lands on exactly one reason the control API publishes. */
function publishable(reason: ExitFailureReason): PoolUnavailableReason {
  switch (reason) {
    case "limit":
    case "not-entitled":
      return "quota-spent";
    case "relay-silent":
    case "session-closed":
      return "relay-silent";
    case "not-us":
    case "hosting":
    case "lookup-failed":
    case "no-change":
    case "not-available":
    case "overloaded":
    case "exit-unavailable":
    case "incomplete":
    case "unrecognised":
    case "listener-failed":
      return "no-us-exit";
  }
}

/** A refusal the pool will not retry: nothing will change without new supply. */
function terminal(reason: ExitFailureReason): boolean {
  return (
    reason === "limit" ||
    reason === "not-entitled" ||
    reason === "relay-silent" ||
    reason === "session-closed"
  );
}

function describe(error: unknown): { reason: ExitFailureReason; message: string } {
  if (error instanceof ExitRejectedError) return { reason: error.reason, message: error.message };
  return {
    reason: "unrecognised",
    message: error instanceof Error ? error.message : String(error),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createExitPool(options: ExitPoolOptions): ExitPool {
  const target = bounded(options.target, POOL_TARGET, 1);
  const max = Math.max(target, bounded(options.max, POOL_MAX, 1));
  const refillBelow = Math.min(bounded(options.refillBelow, POOL_REFILL_BELOW, 1), target);
  const acquireWaitMs = bounded(options.acquireWaitMs, POOL_ACQUIRE_WAIT_MS, 0);
  const retryDelayMs = bounded(options.retryDelayMs, 1_000, 0);

  const entries = new Map<string, Entry>();
  const waiters: Waiter[] = [];
  const closing = new Set<Promise<void>>();

  let started = false;
  let pumping = false;
  let running: Promise<void> | null = null;
  let parked = false;
  let closed = false;
  let refills = 0;
  let lastFailure: { reason: ExitFailureReason; message: string } | null = null;
  let signalClose: () => void = () => {};
  const closeSignal = new Promise<void>((resolve) => {
    signalClose = resolve;
  });

  const idle = (): Entry | undefined => {
    for (const entry of entries.values()) {
      if (!entry.leased && entry.exit.state === "ready") return entry;
    }
    return undefined;
  };

  const readyCount = (): number => {
    let count = 0;
    for (const entry of entries.values()) {
      if (!entry.leased && entry.exit.state === "ready") count += 1;
    }
    return count;
  };

  const track = (exit: TuxlerExit): void => {
    const done: Promise<void> = exit.close();
    closing.add(done);
    void done.then(() => closing.delete(done));
  };

  const leaseOf = (entry: Entry): ExitLease => ({
    exitId: entry.exit.id,
    server: options.relayHost,
    ip: entry.exit.ip,
    country: entry.exit.countryIso || "US",
    asn: String(entry.exit.asn.asn),
    city: entry.exit.city,
    state: entry.exit.location.region,
    socksUrl: entry.exit.socksUrl,
    localPort: entry.exit.localPort,
  });

  const failure = (): PoolUnavailableError => {
    if (lastFailure === null) {
      return new PoolUnavailableError(
        "not-ready",
        started ? "no exit became ready in time" : "the pool has not started",
      );
    }
    const reason = publishable(lastFailure.reason);
    return new PoolUnavailableError(reason, `${REASON_TEXT[reason]}: ${lastFailure.message}`);
  };

  function takeWaiter(entry: Entry): void {
    entry.leased = true;
    const waiter = waiters.shift();
    if (waiter === undefined) {
      entry.leased = false;
      return;
    }
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.resolve(leaseOf(entry));
  }

  function notify(): void {
    for (;;) {
      if (waiters.length === 0) return;
      const entry = idle();
      if (entry === undefined) return;
      takeWaiter(entry);
    }
  }

  /** Close idle exits above the target so a burst of leases drains back to five. */
  function trim(): void {
    if (entries.size <= target) return;
    for (const entry of [...entries.values()]) {
      if (entries.size <= target) return;
      if (entry.leased) continue;
      entries.delete(entry.exit.id);
      track(entry.exit);
    }
  }

  async function fillOne(): Promise<FillOutcome> {
    refills += 1;
    let exit: TuxlerExit;
    try {
      exit = await openUsExit({
        session: options.session,
        relayHost: options.relayHost,
        lookup: options.lookup,
        resolveEndpoint: options.resolveEndpoint,
        dial: options.dial,
        changeTimeoutMs: options.changeTimeoutMs,
      });
    } catch (error) {
      lastFailure = describe(error);
      if (terminal(lastFailure.reason)) {
        parked = true;
        return "stop";
      }
      return "retry";
    }
    if (closed) {
      await exit.close();
      return "stop";
    }
    if (entries.has(exit.id)) {
      // The relay answered with an exit the pool already serves; a second
      // listener on it would be a duplicate, not a new exit.
      await exit.close();
      lastFailure = { reason: "no-change", message: "the relay offered an exit the pool holds" };
      return "retry";
    }
    entries.set(exit.id, { exit, leased: false, strikes: 0 });
    lastFailure = null;
    notify();
    return "created";
  }

  async function pump(): Promise<void> {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (!closed && !parked && entries.size < max && readyCount() < target) {
        const outcome = await fillOne();
        if (outcome === "stop") break;
        if (outcome === "retry") await Promise.race([delay(retryDelayMs), closeSignal]);
      }
    } finally {
      pumping = false;
    }
  }

  /** One pump at a time; `settled()` waits for the run in flight. */
  function kick(): void {
    if (running !== null || closed) return;
    running = pump().finally(() => {
      running = null;
    });
  }

  const settled = async (): Promise<void> => {
    while (running !== null) await running;
  };

  /** A refill is gate-blocked while at least `refillBelow` exits are ready. */
  function evaluate(force = false): void {
    if (closed || parked) return;
    if (entries.size >= max) return;
    if (!force && readyCount() >= refillBelow) return;
    kick();
  }

  return {
    start: () => {
      if (closed || started) return;
      started = true;
      evaluate(true);
    },

    snapshot: (): PoolSnapshot => {
      const account = options.session.snapshot().account;
      return {
        target,
        refillBelow,
        max,
        ready: readyCount(),
        total: entries.size,
        exits: [...entries.values()].map((entry) => ({
          exitId: entry.exit.id,
          ip: entry.exit.ip,
          port: entry.exit.port,
          country: entry.exit.countryIso || "US",
          state: entry.exit.location.region,
          city: entry.exit.city,
          asn: String(entry.exit.asn.asn),
          localPort: entry.exit.localPort,
          socksUrl: entry.exit.socksUrl,
          status: entry.leased ? "leased" : "ready",
          strikes: entry.strikes,
          requests: entry.exit.requests,
        })),
        buckets: bucketReport(options.bucketId?.() ?? null, account),
        refills,
        lastError: lastFailure === null ? null : { ...lastFailure },
      };
    },

    health: (): HealthPool => {
      const current = options.session.snapshot().account;
      const exits = [...entries.values()]
        .filter((entry) => !entry.leased && entry.exit.state === "ready")
        .map((entry) => ({
          exitId: entry.exit.id,
          ip: entry.exit.ip,
          country: entry.exit.countryIso || "US",
          asn: String(entry.exit.asn.asn),
          city: entry.exit.city,
          state: entry.exit.location.region,
        }));
      return {
        ready: readyCount(),
        exits,
        buckets: bucketReport(options.bucketId?.() ?? null, current),
      };
    },

    acquire: (acquireOptions = {}): Promise<ExitLease> => {
      if (closed) {
        return Promise.reject(new PoolUnavailableError("not-ready", "the pool is closed"));
      }
      const entry = idle();
      if (entry !== undefined) {
        entry.leased = true;
        evaluate();
        return Promise.resolve(leaseOf(entry));
      }
      const waitMs = acquireOptions.waitMs ?? acquireWaitMs;
      if (!(waitMs > 0)) return Promise.reject(failure());
      return new Promise<ExitLease>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          reject(failure());
        }, waitMs);
        waiters.push(waiter);
      });
    },

    release: async (exitId, outcome): Promise<void> => {
      const entry = entries.get(exitId);
      if (entry === undefined) {
        throw new Error(`the pool does not hold exit ${exitId}`);
      }
      entry.leased = false;
      entry.strikes = outcome === "good" ? 0 : entry.strikes + 1;
      if (entry.strikes < 2) {
        trim();
        notify();
        return;
      }
      entries.delete(exitId);
      await entry.exit.close();
      // Plan §4.3: an exit that failed twice is dead and is replaced, at the cost
      // of one change, rather than leaving the pool a Click short.
      evaluate(true);
    },

    restart: async (): Promise<void> => {
      parked = true;
      await settled();
      const owned = [...entries.values()];
      entries.clear();
      for (const entry of owned) entry.leased = false;
      lastFailure = null;
      await Promise.all(owned.map((entry) => entry.exit.close()));
      await Promise.all([...closing]);
      if (closed) return;
      parked = false;
      started = true;
      kick();
    },

    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      parked = true;
      signalClose();
      const waiting = waiters.splice(0);
      for (const waiter of waiting) {
        if (waiter.timer !== null) clearTimeout(waiter.timer);
        waiter.reject(new PoolUnavailableError("not-ready", "the pool is closed"));
      }
      await settled();
      const owned = [...entries.values()];
      entries.clear();
      await Promise.all(owned.map((entry) => entry.exit.close()));
      await Promise.all([...closing]);
    },
  };
}

/** A pool that is already filling, for a caller that has a live session. */
export function startExitPool(options: ExitPoolOptions): ExitPool {
  const pool = createExitPool(options);
  pool.start();
  return pool;
}
