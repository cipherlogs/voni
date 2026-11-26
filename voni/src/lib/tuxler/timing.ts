/**
 * The one number both halves of the exit path wait for.
 *
 * A Click's bounded wait is a contract between three places that must agree: the
 * pool that serves an acquire, the control API that relays it with its own
 * timeout margin, and the runner that gives up and records `not-ready`. It used
 * to be typed out three times; the runner's copy going stale would have turned a
 * slow refill into a failed Click with a reason nobody could explain.
 *
 * Ten seconds is one refill plus a handshake.
 */
export const POOL_ACQUIRE_WAIT_MS = 10_000;
