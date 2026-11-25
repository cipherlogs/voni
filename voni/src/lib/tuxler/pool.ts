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
 * Ticket 06 adds the refill budget. The relay meters changes per account and client
 * egress IP, so a *bucket* is an address: the root bucket is the runner's own
 * address, and a child bucket is a second relay session dialled through a ready
 * exit, which the relay sees as that exit's address and meters afresh. Depth is how
 * many levels that tree may grow (default three) — a budget for refills, never extra
 * concurrency: the exits still stop at the same target and maximum. Two further
 * rules keep the budget spendable: a session sends at most five changes in a row
 * before it cools down or switches bucket (a burst is what triggers the relay's
 * silence), and a session that stops answering is closed and reconnected through
 * the same parent rather than being counted as thin US supply.
 *
 * The report is read-only by construction: `snapshot()` and `health()` read the
 * sessions' account frames and the pool's maps, and never kick a refill.
 */
import type { TuxlerSession } from "./control";
import { ExitRejectedError, openUsExit, type ExitFailureReason, type TuxlerExit } from "./exit";
import { bucketReport, type HealthBucket, type HealthPool } from "./health";
import type { EndpointResolver } from "./transport";
import { exitTunnelDialer } from "./transport";
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
/** How many child buckets deep the refill tree may grow. */
export const POOL_DEPTH = 3;
/** Changes one session sends in a row before a cooldown or a bucket switch. */
export const POOL_PACE_BURST = 5;
/** How long a session waits after that burst before it may spend again. */
export const POOL_PACE_COOLDOWN_MS = 20_000;
/** Silence after which a session is unhealthy and is reconnected. */
export const POOL_SILENCE_MS = 20_000;

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
  /** The refill budget the pool may grow to. */
  depth: number;
  /** Exits a Click can take right now. */
  ready: number;
  /** Every exit the pool owns, leased included. */
  total: number;
  exits: PoolExitReport[];
  /** Every bucket the pool can spend from; the root bucket first. */
  buckets: HealthBucket[];
  /** Change attempts the pool has made since it started. */
  refills: number;
  /** Sessions replaced after silence or a close. */
  reconnects: number;
  lastReconnect: { at: string; depth: number; reason: string } | null;
  lastError: { reason: string; message: string } | null;
}

export type PoolSession = Pick<TuxlerSession, "requestChange" | "snapshot"> & {
  stop?: () => void;
};

/** What a child bucket's session is dialled through: a ready exit of its parent. */
export interface BucketLink {
  /** The relay host the parent exit lives on. */
  relayHost: string;
  /** The parent exit's address — the relay will meter the child against it. */
  exitIp: string;
  /** The parent exit's relay port. */
  exitPort: number;
  /**
   * Dial any host and port through the parent bucket's exit chain. The returned
   * duplex carries the tunnel's mask, so a caller writes plaintext control frames.
   */
  dial: TunnelDialer;
}

export interface ExitPoolOptions {
  session: PoolSession;
  /** The relay host the exits live on, e.g. `server3.ipsharkk.com`. */
  relayHost: string;
  /** The meter key for a session's client address; `null` when it is not known yet. */
  bucketId?: (clientIp: string | null) => string | null;
  target?: number;
  refillBelow?: number;
  max?: number;
  /** The refill budget: how many child buckets deep the tree may grow. Defaults to three. */
  depth?: number;
  /** Defaults to ten seconds: one refill plus a handshake. */
  acquireWaitMs?: number;
  /** How long to wait before another refill attempt after a supply failure. */
  retryDelayMs?: number;
  changeTimeoutMs?: number;
  /** Changes one session sends in a row before a cooldown. Defaults to five. */
  paceBurst?: number;
  /** How long that cooldown lasts. Defaults to twenty seconds. */
  paceCooldownMs?: number;
  /** Silence after which a session is replaced. Defaults to twenty seconds. */
  silenceMs?: number;
  /** How often an exhausted tree checks for a reset. Defaults to five seconds. */
  resetPollMs?: number;
  lookup?: AsnLookup;
  resolveEndpoint?: EndpointResolver;
  dial?: TunnelDialer;
  /**
   * Open a session for a child bucket (`link`) or to replace a silent root (`null`).
   * Absent means the pool never grows a tree and never reconnects: it reports the
   * reason instead, which is all a diagnostic probe wants.
   */
  openSession?: (link: BucketLink | null) => Promise<PoolSession>;
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

/** One address the relay meters changes against: the root, or a child reached through an exit. */
interface Bucket {
  /** 0 is the root; every child adds one. */
  depth: number;
  session: PoolSession;
  /** The relay this bucket's exits and further children live on. */
  relayHost: string;
  /** The exit this bucket was opened through; `null` for the root. */
  parent: Entry | null;
  /** Dial onward through the ancestors, so a grandchild stays nested. */
  dialBase: TunnelDialer | undefined;
  /** Changes this session has sent in a row. */
  consecutive: number;
  /** Silences this bucket has reconnected from in a row. */
  silences: number;
  /** The relay refused a change: nothing more will come from this address. */
  exhausted: boolean;
  /** The account figures at the last spend, so a reset is visible as a change. */
  watermark: { resetAt: string | null; used: number | null };
}

interface Entry {
  exit: TuxlerExit;
  bucket: Bucket;
  leased: boolean;
  strikes: number;
  /** Dial this exit's relay port to reach any destination (a further hop). */
  dialer: TunnelDialer;
}

interface Waiter {
  resolve: (lease: ExitLease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type FillOutcome = "created" | "retry" | "stop";

type BucketPick =
  | { kind: "spend"; bucket: Bucket }
  | { kind: "cool"; bucket: Bucket }
  | { kind: "wait" }
  | { kind: "quota" };

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

/** A silence is the session's fault, never the supply's: reconnect it. */
function silent(reason: ExitFailureReason): boolean {
  return reason === "relay-silent" || reason === "session-closed";
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

function watermarkOf(session: PoolSession): { resetAt: string | null; used: number | null } {
  const account = session.snapshot().account;
  return { resetAt: account.resetAt, used: account.changesUsed };
}

/** How many silences in a row a bucket may reconnect from before it is left alone. */
const MAX_RECONNECTS_IN_A_ROW = 3;
export function createExitPool(options: ExitPoolOptions): ExitPool {
  const target = bounded(options.target, POOL_TARGET, 1);
  const max = Math.max(target, bounded(options.max, POOL_MAX, 1));
  const refillBelow = Math.min(bounded(options.refillBelow, POOL_REFILL_BELOW, 1), target);
  const acquireWaitMs = bounded(options.acquireWaitMs, POOL_ACQUIRE_WAIT_MS, 0);
  const retryDelayMs = bounded(options.retryDelayMs, 1_000, 0);
  const depth = bounded(options.depth, POOL_DEPTH, 0);
  const paceBurst = bounded(options.paceBurst, POOL_PACE_BURST, 1);
  const paceCooldownMs = bounded(options.paceCooldownMs, POOL_PACE_COOLDOWN_MS, 0);
  const silenceMs = bounded(options.silenceMs, POOL_SILENCE_MS, 1);
  const changeTimeoutMs = bounded(options.changeTimeoutMs, silenceMs, 1);
  const resetPollMs = bounded(options.resetPollMs, 5_000, 1);

  const entries = new Map<string, Entry>();
  const waiters: Waiter[] = [];
  const closing = new Set<Promise<void>>();

  let started = false;
  let pumping = false;
  let running: Promise<void> | null = null;
  let parked = false;
  let parkedFor: "quota" | "hard" | null = null;
  let closed = false;
  let refills = 0;
  let reconnects = 0;
  let watch: ReturnType<typeof setInterval> | null = null;
  let lastReconnect: PoolSnapshot["lastReconnect"] = null;
  let lastFailure: { reason: ExitFailureReason; message: string } | null = null;
  let signalClose: () => void = () => {};
  const closeSignal = new Promise<void>((resolve) => {
    signalClose = resolve;
  });

  /**
   * The exit handed out last. The next acquire starts after it, so a Click that
   * releases good sends its address to the back of the queue instead of being
   * offered to the very next Click: consecutive Clicks never share an address
   * while two exits are ready.
   */
  let lastLeased: string | null = null;

  const buckets: Bucket[] = [];

  const idle = (): Entry | undefined => {
    const ready = [...entries.values()].filter(
      (entry) => !entry.leased && entry.exit.state === "ready",
    );
    if (ready.length === 0) return undefined;
    const at =
      lastLeased === null
        ? -1
        : ready.findIndex((entry) => entry.exit.id === lastLeased);
    return ready[(at + 1) % ready.length];
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

  const hashOf = (bucket: Bucket): string | null =>
    options.bucketId?.(bucket.session.snapshot().clientIp) ?? null;

  const reportBuckets = (): HealthBucket[] => {
    const report: HealthBucket[] = [];
    for (const bucket of buckets) {
      const base = bucketReport(hashOf(bucket), bucket.session.snapshot().account)[0];
      if (base === undefined) continue;
      report.push({
        ...base,
        depth: bucket.depth,
        parentId: bucket.parent === null ? null : hashOf(bucket.parent.bucket),
      });
    }
    return report;
  };

  const leaseOf = (entry: Entry): ExitLease => ({
    exitId: entry.exit.id,
    server: entry.bucket.relayHost,
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
    lastLeased = entry.exit.id;
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
    // An exit a child bucket was opened through is a parent: closing it would
    // close that bucket's session and every exit nested behind it.
    const parents = new Set<string>();
    for (const bucket of buckets) {
      if (bucket.parent !== null) parents.add(bucket.parent.exit.id);
    }
    for (const entry of [...entries.values()]) {
      if (entries.size <= target) return;
      if (entry.leased || parents.has(entry.exit.id)) continue;
      entries.delete(entry.exit.id);
      track(entry.exit);
    }
  }

  /** Dial a child session from the exit it is opened over, or directly as root. */
  const linkOf = (parent: Entry | null): BucketLink | null => {
    if (parent === null) return null;
    return {
      relayHost: parent.bucket.relayHost,
      exitIp: parent.exit.ip,
      exitPort: parent.exit.port,
      dial: parent.dialer,
    };
  };

  async function openChild(): Promise<Bucket | null> {
    const factory = options.openSession;
    if (factory === undefined) return null;

    // A child is metered by the address the relay sees: the parent exit's. Prefer
    // an idle exit whose address is not already a bucket, so the child is fresh.
    const spent = new Set<string>();
    for (const bucket of buckets) {
      const ip = bucket.session.snapshot().clientIp;
      if (ip !== null) spent.add(ip);
    }
    let parent: Entry | undefined;
    for (const entry of entries.values()) {
      if (entry.leased || entry.exit.state !== "ready") continue;
      if (spent.has(entry.exit.ip)) continue;
      parent = entry;
      break;
    }
    if (parent === undefined) return null;

    try {
      const session = await factory(linkOf(parent));
      if (closed) {
        session.stop?.();
        return null;
      }
      const bucket: Bucket = {
        depth: parent.bucket.depth + 1,
        session,
        relayHost: session.snapshot().host || options.relayHost,
        parent,
        dialBase: parent.dialer,
        consecutive: 0,
        silences: 0,
        exhausted: false,
        watermark: watermarkOf(session),
      };
      buckets.push(bucket);
      return bucket;
    } catch (error) {
      const detail = describe(error);
      lastFailure = {
        reason: silent(detail.reason) ? "relay-silent" : detail.reason,
        message: `the child bucket could not be opened: ${detail.message}`,
      };
      return null;
    }
  }

  /** Which bucket may spend next: the deepest live one, a cooldown, or nothing. */
  async function pickBucket(): Promise<BucketPick> {
    let open: Bucket | undefined;
    for (const bucket of buckets) {
      if (bucket.exhausted) continue;
      if (open === undefined || bucket.depth > open.depth) open = bucket;
    }
    if (open !== undefined) {
      if (open.consecutive < paceBurst) return { kind: "spend", bucket: open };
      return { kind: "cool", bucket: open };
    }
    // Every bucket is spent. Grow the tree while the budget allows, or stop loudly.
    if (options.openSession === undefined) return { kind: "quota" };
    if (!linksOpen()) return { kind: "quota" };
    const child = await openChild();
    if (child !== null) return { kind: "spend", bucket: child };
    // Budget remains but no ready exit could carry a child right now: wait for one.
    return { kind: "wait" };
  }

  /** Whether the tree may still grow: the depth budget and a factory both allow it. */
  function linksOpen(): boolean {
    if (options.openSession === undefined || buckets.length === 0) return false;
    const deepest = buckets.reduce((at, bucket) => Math.max(at, bucket.depth), -1);
    return deepest + 1 <= depth;
  }

  async function fillOne(bucket: Bucket): Promise<FillOutcome> {
    refills += 1;
    bucket.consecutive += 1;
    let exit: TuxlerExit;
    try {
      exit = await openUsExit({
        session: bucket.session,
        relayHost: bucket.relayHost,
        lookup: options.lookup,
        resolveEndpoint: options.resolveEndpoint,
        dial: bucket.dialBase,
        changeTimeoutMs,
      });
    } catch (error) {
      const detail = describe(error);
      lastFailure = detail;
      if (detail.reason === "limit" || detail.reason === "not-entitled") {
        // The address has nothing left. The next pick opens a child, or stops.
        bucket.exhausted = true;
        return "retry";
      }
      if (silent(detail.reason)) {
        return (await reconnect(bucket, detail)) ? "retry" : "stop";
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
    const entry: Entry = {
      exit,
      bucket,
      leased: false,
      strikes: 0,
      dialer: exitTunnelDialer({
        relayHost: bucket.relayHost,
        exitPort: exit.port,
        resolve: options.resolveEndpoint,
        dial: bucket.dialBase,
      }),
    };
    entries.set(exit.id, entry);
    lastFailure = null;
    bucket.silences = 0;
    bucket.watermark = watermarkOf(bucket.session);
    if (exit.lastOfBucket) bucket.exhausted = true;
    notify();
    return "created";
  }

  /**
   * A session that stopped answering is the relay's silence, not thin supply:
   * close it and dial a replacement through the same parent, so the bucket keeps
   * its address and the depth budget is not spent on a failure.
   */
  async function reconnect(
    bucket: Bucket,
    detail: { reason: ExitFailureReason; message: string },
  ): Promise<boolean> {
    reconnects += 1;
    bucket.silences += 1;
    lastReconnect = {
      at: new Date().toISOString(),
      depth: bucket.depth,
      reason: publishable(detail.reason),
    };
    bucket.session.stop?.();
    if (options.openSession === undefined || bucket.silences > MAX_RECONNECTS_IN_A_ROW) {
      parked = true;
      parkedFor = "hard";
      lastFailure = detail;
      return false;
    }
    try {
      const session = await options.openSession(linkOf(bucket.parent));
      if (closed) {
        session.stop?.();
        return false;
      }
      bucket.session = session;
      bucket.relayHost = session.snapshot().host || bucket.relayHost;
      bucket.consecutive = 0;
      bucket.watermark = watermarkOf(session);
      lastFailure = detail;
      return true;
    } catch (error) {
      // A failed reconnect is still a silence: it must never read as no supply.
      const again = describe(error);
      lastFailure = { reason: detail.reason, message: `${detail.message}; reconnect failed: ${again.message}` };
      parked = true;
      parkedFor = "hard";
      return false;
    }
  }

  async function pump(): Promise<void> {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (!closed && !parked && entries.size < max && readyCount() < target) {
        const pick = await pickBucket();
        if (pick.kind === "quota") {
          parked = true;
          parkedFor = "quota";
          lastFailure = {
            reason: "limit",
            message:
              depth === 0
                ? "the change bucket is spent and no child bucket is configured"
                : `the change bucket tree is spent at depth ${depth}`,
          };
          watchForReset();
          break;
        }
        if (pick.kind === "wait") {
          if (await pause(retryDelayMs)) break;
          continue;
        }
        if (pick.kind === "cool") {
          // At most `paceBurst` changes in a row: the session cools down, and its
          // burst allowance is whole again afterwards.
          if (await pause(paceCooldownMs)) break;
          pick.bucket.consecutive = 0;
          continue;
        }
        const outcome = await fillOne(pick.bucket);
        if (outcome === "stop") break;
        if (outcome === "retry") {
          if (await pause(retryDelayMs)) break;
        }
      }
    } finally {
      pumping = false;
    }
  }

  /** Waits out a delay; `true` when the close signal cut it short. */
  async function pause(ms: number): Promise<boolean> {
    if (closed) return true;
    if (ms <= 0) return false;
    const which = await Promise.race([
      delay(ms).then(() => "delay" as const),
      closeSignal.then(() => "closed" as const),
    ]);
    return which === "closed" || closed;
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

  /**
   * `RESET_INFO` (and an `ACCOUNT_INFO` whose usage fell) is the only evidence a
   * spent bucket has been restored. Nothing else may re-arm it: a reset is the
   * relay's own statement, not a guess from elapsed time.
   */
  function resetSeen(): boolean {
    const root = buckets[0];
    if (root === undefined) return false;
    const account = root.session.snapshot().account;
    if (
      account.resetAt !== null &&
      root.watermark.resetAt !== null &&
      account.resetAt !== root.watermark.resetAt
    ) {
      return true;
    }
    return (
      account.changesUsed !== null &&
      root.watermark.used !== null &&
      account.changesUsed < root.watermark.used
    );
  }

  function stopWatch(): void {
    if (watch === null) return;
    clearInterval(watch);
    watch = null;
  }

  /** Only a quota park is worth watching: a hard failure will not cure itself. */
  function watchForReset(): void {
    if (watch !== null || closed) return;
    const timer = setInterval(() => {
      if (closed || !parked || parkedFor !== "quota") {
        stopWatch();
        return;
      }
      if (!resetSeen()) return;
      stopWatch();
      for (const bucket of buckets) {
        bucket.exhausted = false;
        bucket.consecutive = 0;
        bucket.watermark = watermarkOf(bucket.session);
      }
      parked = false;
      parkedFor = null;
      lastFailure = null;
      evaluate();
    }, resetPollMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    watch = timer;
  }

  const rootSession = options.session;
  buckets.push({
    depth: 0,
    session: rootSession,
    relayHost: options.relayHost,
    parent: null,
    dialBase: options.dial,
    consecutive: 0,
    silences: 0,
    exhausted: false,
    watermark: watermarkOf(rootSession),
  });

  return {
    start: () => {
      if (closed || started) return;
      started = true;
      evaluate(true);
    },

    snapshot: (): PoolSnapshot => ({
      target,
      refillBelow,
      max,
      depth,
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
      buckets: reportBuckets(),
      refills,
      reconnects,
      lastReconnect,
      lastError: lastFailure === null ? null : { ...lastFailure },
    }),

    health: (): HealthPool => {
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
        buckets: reportBuckets(),
        refills,
        reconnects,
        lastReconnect,
      };
    },

    acquire: (acquireOptions = {}): Promise<ExitLease> => {
      if (closed) {
        return Promise.reject(new PoolUnavailableError("not-ready", "the pool is closed"));
      }
      const entry = idle();
      if (entry !== undefined) {
        entry.leased = true;
        lastLeased = entry.exit.id;
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
      stopWatch();
      const owned = [...entries.values()];
      entries.clear();
      for (const entry of owned) entry.leased = false;
      lastFailure = null;
      await Promise.all(owned.map((entry) => entry.exit.close()));
      await Promise.all([...closing]);
      for (const bucket of buckets.slice(1)) bucket.session.stop?.();
      const root = buckets[0];
      buckets.length = 0;
      buckets.push({
        ...root,
        depth: 0,
        parent: null,
        dialBase: options.dial,
        consecutive: 0,
        silences: 0,
        exhausted: false,
        watermark: watermarkOf(root.session),
      });
      if (closed) return;
      parked = false;
      parkedFor = null;
      started = true;
      kick();
    },

    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      parked = true;
      stopWatch();
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
      for (const bucket of buckets.slice(1)) bucket.session.stop?.();
    },
  };
}

/** A pool that is already filling, for a caller that has a live session. */
export function startExitPool(options: ExitPoolOptions): ExitPool {
  const pool = createExitPool(options);
  pool.start();
  return pool;
}
