/**
 * Where a Click's bytes leave from, in one place.
 *
 * Two settings decide whether a browser reaches the internet through its exit
 * or around it, and both were the runner's alone until the leak check needed
 * the same ones:
 *
 *   - the launch flags, because QUIC and non-proxied WebRTC outlive an
 *     otherwise correct per-context proxy;
 *   - the context proxy, because a pool exit belongs to one context rather than
 *     to a whole segment.
 *
 * A copy in the check would let the check pass while the runner drifted, so the
 * runner and `tuxler-exit-leak.mjs` both import from here.
 */

/** The paths around a proxy that survive a correct `context.proxy`. */
export const EGRESS_LAUNCH_ARGS = [
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

/**
 * Playwright launch options for a segment.
 *
 * @param {object} [options]
 * @param {{ server: string, username?: string, password?: string } | undefined} [options.proxy]
 *   the manual override; a pool exit is a context proxy instead, never this.
 * @param {string | undefined} [options.channel] `chrome` for the runner, a
 *   bundled Chromium for a check that must not depend on a desktop install.
 * @param {boolean} [options.headless]
 * @param {string[]} [options.extraArgs] harness-only flags, added after the
 *   egress flags so they cannot replace one.
 * @returns {{ channel?: string, headless: boolean, args: string[],
 *   proxy?: { server: string, username?: string, password?: string } }}
 */
export function launchOptionsFor({
  proxy,
  channel = "chrome",
  headless = true,
  extraArgs = [],
} = {}) {
  const options = { headless, args: [...EGRESS_LAUNCH_ARGS, ...extraArgs] };
  if (channel !== undefined) options.channel = channel;
  if (proxy !== undefined) options.proxy = proxy;
  return options;
}

/**
 * The proxy a browser context must carry so that this Click leaves from its
 * exit. No exit means no proxy, which is the pre-pool behaviour and a leak the
 * caller is responsible for not asking for.
 *
 * @param {{ socksUrl: string } | undefined} exit
 */
export function exitContextProxy(exit) {
  return exit === undefined ? {} : { proxy: { server: exit.socksUrl } };
}
