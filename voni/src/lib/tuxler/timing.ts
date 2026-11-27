/**
 * The one number both halves of the exit path wait for.
 *
 * A Click's bounded wait is a contract between three places that must agree: the
 * pool that serves an acquire, the control API that relays it with its own
 * timeout margin, and the runner that gives up and records `not-ready`. It used
 * to be typed out three times; the runner's copy going stale would have turned a
 * slow refill into a failed Click with a reason nobody could explain.
 *
 * Now that a good release retires the exit, an acquire usually waits for a whole
 * rotation: one change (up to 20 s when the relay goes silent for a change), the
 * registry lookup, and the SOCKS listener. Ten seconds covered a refill of a pool
 * that already held five exits; it no longer covers the rotation that replaced
 * them. A Click that waits is worth more than a Click refused `no-us-exit` while
 * its replacement was in flight — one run lost a pass exactly that way.
 */
export const POOL_ACQUIRE_WAIT_MS = 45_000;
