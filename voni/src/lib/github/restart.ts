/**
 * A Restart is two acts in a fixed order: stop the Segment, then start its
 * replacement.
 *
 * The order is the whole safety property. `browser-check.yml` uses a per-OS
 * concurrency group with `cancel-in-progress: false`, so a re-dispatch alone
 * queues behind the running Segment and the operator's "restart" changes
 * nothing until the old window ends. Cancelling first is what makes it a
 * replacement, and observing the stop is what keeps two browsers off the same
 * target at the same moment.
 *
 * The anti-thrash throttle (`DISPATCH_THROTTLE_SECONDS`, consulted by
 * `decideDue`) is deliberately not read here. It exists to stop a *ticker*
 * from respawning a failing source every minute; an operator pressing Restart
 * is the opposite of thrash, so the throttle must not swallow the request.
 * The caller still records the replacement, so the ticker's own throttle
 * starts from the restart and cannot immediately dispatch a second Segment.
 *
 * Every dependency is injected: the cancel client, the dispatcher, and — in
 * the action — the reads of targets and schedule. That is what lets the tests
 * prove "one Restart leaves one run" against a fake GitHub instead of a real
 * account.
 */

import type {
  BrowserCheckInput,
  CancelOutcome,
  DispatchOutcome,
} from "./dispatch";

export type RestartDeps = {
  /** Cancel the OS's active Segment and report only an observed stop. */
  cancel: (os: BrowserCheckInput["os"]) => Promise<CancelOutcome>;
  /** Start exactly one replacement. */
  dispatch: (input: BrowserCheckInput) => Promise<DispatchOutcome>;
};

/**
 * `replaced` means something was running and stopped; `started` means nothing
 * was running. `manual` is a dispatch with no token — unreachable in practice
 * because the cancel needs the same token, but an honest shape if it happens.
 */
export type RestartOutcome =
  | {
      ok: true;
      mode: "replaced" | "started" | "manual";
      message: string;
      runUrl?: string;
      fallback?: { command: string };
      cancelledRunIds: number[];
    }
  | { ok: false; step: "cancel" | "dispatch"; error: string };

/** The sentence both successes carry, so the bypass is stated, not implied. */
function throttleNote(): string {
  return (
    "A restart bypasses the ticker's anti-thrash throttle on purpose, and the " +
    "dispatch is recorded, so the ticker will not dispatch again for ten minutes."
  );
}

export async function restartSegment(
  request: BrowserCheckInput,
  deps: RestartDeps,
): Promise<RestartOutcome> {
  const stop = await deps.cancel(request.os);

  // No dispatch until the stop is observed. A cancel failure includes the
  // bounded wait: the old Segment may still be clicking, and a second one
  // would click every target twice.
  if (!stop.ok) {
    return { ok: false, step: "cancel", error: stop.error };
  }

  const result = await deps.dispatch(request);

  if (!result.ok) {
    return { ok: false, step: "dispatch", error: result.error };
  }

  if (result.mode === "manual") {
    // Nothing was queued (no token), so nothing is recorded by the caller.
    return {
      ok: true,
      mode: "manual",
      message:
        "No dispatch token is configured, so nothing was queued — run this line yourself:",
      fallback: result.fallback,
      cancelledRunIds: stop.runIds,
    };
  }

  return {
    ok: true,
    mode: stop.runIds.length > 0 ? "replaced" : "started",
    message:
      stop.runIds.length > 0
        ? `Restart cancelled the running ${request.os} segment and dispatched one replacement. ${throttleNote()}`
        : `Nothing was running for ${request.os}, so Restart dispatched one segment. ${throttleNote()}`,
    runUrl: result.runUrl,
    cancelledRunIds: stop.runIds,
  };
}
