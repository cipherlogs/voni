/**
 * Proxy secrets, kept out of every sentence a human reads.
 *
 * `readProxy` accepts a proxy server with `user:pass@` inline, and Playwright's
 * launch failure can quote the options it was given — including that server
 * string. `browser-click.mjs` therefore passes any diagnostic text through this
 * module before printing it. The module is separate so a test can run the
 * redaction itself rather than trusting a regex over the runner's source.
 */

/**
 * `scheme://userinfo@` in any text, for the schemes Playwright can drive. The
 * userinfo is replaced whole, so a password appears neither raw nor raw inside
 * a URL.
 */
const USERINFO = /(\b(?:https?|socks5):\/\/)[^/\s?#@]*@/gi;

/**
 * Remove proxy credentials from `text`:
 *
 *   - every `user:pass@` inside a URL becomes `[redacted]@`, so a quoted
 *     server URL keeps its scheme and host but loses who was in it;
 *   - the configured password, when it appears on its own, is replaced too.
 *
 * The host is deliberately kept: a launch failure without it names no cause.
 * `proxy` may be undefined (no proxy configured), which leaves only the URL
 * rule — the text never came from a credential we hold in that case.
 */
export function redactProxyText(text, proxy) {
  let redacted = String(text).replace(USERINFO, "$1[redacted]@");
  const password = proxy?.password;
  if (typeof password === "string" && password !== "") {
    redacted = redacted.split(password).join("[redacted]");
  }
  return redacted;
}
