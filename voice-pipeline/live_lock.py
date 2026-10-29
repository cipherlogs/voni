"""The live timing lock, serialized with the demo scoreboard's lock (ticket 151).

The spec keeps every live timing run one at a time ("live measurement runs stay
one at a time under the existing timing lock"). The existing lock is
``voni/src/lib/demo/timing-lock.ts``; the nightly live smoke is Python, so this
is a port, not a second policy: same file, same JSON holder record, same
stale-holder reclaim rule. A Node demo run and the nightly smoke therefore
cannot overlap, which is the property the spec actually needs.
"""

from __future__ import annotations

import atexit
import json
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

#: Machine-wide default, byte-identical to the JS lock's filename.
DEFAULT_TIMING_LOCK_PATH = Path(tempfile.gettempdir()) / "voni-demo-timing.lock"

#: An unreadable lock file younger than this may be mid-write, so it is not stolen.
CORRUPT_GRACE_S = 5.0


class TimingLockHeldError(RuntimeError):
    """Another live run currently owns the lock."""

    def __init__(self, path: Path, holder: dict | None) -> None:
        self.path = path
        self.holder = holder
        if holder:
            who = (
                f"pid {holder.get('pid')}, started {holder.get('at')}"
                f", scenario {holder.get('scenario')}"
            )
        else:
            who = "unreadable lock file"
        super().__init__(
            f"another timing run holds the lock at {path} ({who}); "
            "timing runs go one at a time so parallel load never inflates cut latency"
        )


@dataclass
class TimingLock:
    path: Path
    pid: int
    _released: bool = False

    def release(self) -> None:
        """Idempotent; only removes the file while this process still owns it."""
        if self._released:
            return
        self._released = True
        holder = _read_holder(self.path)
        if holder is None or holder.get("pid") == self.pid:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass


def _pid_alive(pid: int) -> bool:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _read_holder(path: Path) -> dict | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("pid"), int):
        return None
    return {
        "pid": parsed["pid"],
        "at": str(parsed.get("at", "")),
        "scenario": str(parsed.get("scenario", "")),
    }


def _claim(path: Path, payload: dict) -> bool:
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    try:
        os.write(fd, json.dumps(payload).encode("utf-8"))
    finally:
        os.close(fd)
    return True


def acquire_timing_lock(
    *,
    path: Path | str | None = None,
    scenario: str = "timing",
    is_alive: Callable[[int], bool] | None = None,
    now: Callable[[], float] | None = None,
    corrupt_grace_s: float = CORRUPT_GRACE_S,
) -> TimingLock:
    """Take the exclusive lock or raise :class:`TimingLockHeldError` by name."""
    lock_path = Path(path) if path is not None else DEFAULT_TIMING_LOCK_PATH
    alive = is_alive or _pid_alive
    clock = now or time.time
    payload = {
        "pid": os.getpid(),
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(clock())),
        "scenario": scenario,
    }

    if not _claim(lock_path, payload):
        holder = _read_holder(lock_path)
        if holder is not None and alive(holder["pid"]):
            raise TimingLockHeldError(lock_path, holder)
        if holder is None:
            try:
                age = clock() - lock_path.stat().st_mtime
            except FileNotFoundError:
                age = None
            if age is not None and age < corrupt_grace_s:
                raise TimingLockHeldError(lock_path, None)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
        if not _claim(lock_path, payload):
            raise TimingLockHeldError(lock_path, _read_holder(lock_path))

    lock = TimingLock(path=lock_path, pid=os.getpid())
    atexit.register(lock.release)
    return lock
