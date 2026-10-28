/**
 * One timing run at a time (spec: cut latency rises under parallel load).
 *
 * The demo scoreboard's cut and reply-gap numbers are only comparable when
 * nothing else is loading the machine, so a live (non-dry) score-demo run
 * takes an exclusive lock before it dials. The lock is a JSON file created
 * with O_EXCL: the second run fails fast with a clear message naming the
 * holder instead of producing an inflated number. The holder releases on
 * process exit (and explicitly when the runner unwinds); a lock left by a
 * dead pid is reclaimed so a killed run never blocks forever.
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Machine-wide default: parallel checkouts and worktrees still serialize. */
export const DEFAULT_TIMING_LOCK_PATH = join(tmpdir(), "voni-demo-timing.lock");

type LockFile = { pid: number; at: string; scenario: string };

/** Another timing run currently owns the lock. */
export class TimingLockHeldError extends Error {
  readonly path: string;
  readonly holder: LockFile | null;

  constructor(path: string, holder: LockFile | null) {
    const who = holder
      ? `pid ${holder.pid}, started ${holder.at}${holder.scenario ? `, scenario ${holder.scenario}` : ""}`
      : "unreadable lock file";
    super(
      `another timing run holds the lock at ${path} (${who}); ` +
        "timing runs go one at a time so parallel load never inflates cut latency",
    );
    this.name = "TimingLockHeldError";
    this.path = path;
    this.holder = holder;
  }
}

export type TimingLock = {
  path: string;
  pid: number;
  /** Idempotent; only removes the file while this process still owns it. */
  release: () => void;
};

export type TimingLockOptions = {
  path?: string;
  scenario?: string;
  /** Injectable liveness probe so the lock can be tested offline with a fake holder. */
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  /** An unreadable lock file younger than this may be mid-write, so it is not stolen. */
  corruptGraceMs?: number;
};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): LockFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockFile>;
    return typeof parsed?.pid === "number" ? { pid: parsed.pid, at: String(parsed.at ?? ""), scenario: String(parsed.scenario ?? "") } : null;
  } catch {
    return null;
  }
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Take the exclusive timing lock or throw TimingLockHeldError naming the
 * holder. Stale locks (dead pid, or an unreadable file past the write grace)
 * are reclaimed once; a live holder is never deleted.
 */
export function acquireTimingLock(options: TimingLockOptions = {}): TimingLock {
  const path = options.path ?? DEFAULT_TIMING_LOCK_PATH;
  const scenario = options.scenario ?? "timing";
  const isAlive = options.isAlive ?? pidAlive;
  const now = options.now ?? (() => new Date());
  const corruptGraceMs = options.corruptGraceMs ?? 5_000;
  const payload: LockFile = { pid: process.pid, at: now().toISOString(), scenario };

  const claim = (): boolean => {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(payload));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };

  if (!claim()) {
    const holder = readHolder(path);
    if (holder && isAlive(holder.pid)) throw new TimingLockHeldError(path, holder);
    // A corrupt, half-written lock is only reclaimed once it is old enough
    // that no writer could still be finishing it.
    if (!holder) {
      const age = mtimeMs(path);
      if (age !== null && now().getTime() - age < corruptGraceMs) {
        throw new TimingLockHeldError(path, null);
      }
    }
    rmSync(path, { force: true });
    if (!claim()) throw new TimingLockHeldError(path, readHolder(path));
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    const holder = readHolder(path);
    if (holder === null || holder.pid === process.pid) rmSync(path, { force: true });
  };
  process.once("exit", release);
  return { path, pid: process.pid, release };
}
