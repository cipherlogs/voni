/**
 * "Was this file run, or was it imported?"
 *
 * Every runner script here is both a command and a module: the tests import it
 * for its exported rules, and the workflow runs it to do the work. The guard that
 * tells the two apart used to be
 *
 * ```js
 * if (import.meta.url === `file://${process.argv[1]}`)
 * ```
 *
 * which is true on Linux and never true on Windows: `process.argv[1]` there is
 * `D:\a\voni\voni\scripts\browser-pool-gate.mjs`, so the string is
 * `file://D:\a\…` while `import.meta.url` is
 * `file:///D:/a/voni/voni/scripts/browser-pool-gate.mjs`. The gate therefore ran
 * nothing, waited for nothing, wrote no report — and exited 0, which the workflow
 * read as "the pool is ready". Clicks started 320 ms after the client had, and
 * every one of them met a client that had no session yet: `503 not-ready`.
 *
 * The comparison is between two file URLs, so it is done in URL space, and the
 * path is encoded the way Node encodes it (`%20` for a space, `C:` kept as a
 * drive). `pathToFileURL` is host-aware and cannot be asked for a Windows path on
 * a POSIX host; the explicit encoding below can, which is also what lets a POSIX
 * test prove the Windows case.
 */
import { pathToFileURL } from "node:url";

/** A path the host does not have to resolve: POSIX absolute, drive letter, or a share. */
const ABSOLUTE_OR_WINDOWS = /^([A-Za-z]:[\\/]|[\\/])/;

/**
 * The `file:` URL Node would give this path. `null` when there is no path.
 *
 * @param {string | undefined} path
 * @returns {string | null}
 */
export function fileUrlOfPath(path) {
  if (typeof path !== "string" || path === "") return null;
  if (!ABSOLUTE_OR_WINDOWS.test(path)) {
    // Relative: the host decides what it is relative to, which is the cwd.
    return pathToFileURL(path).href;
  }
  const forward = path.replace(/\\/g, "/");
  // A UNC share (`//server/share/file`) keeps its host; everything else is local.
  return new URL(
    forward.startsWith("//") ? `file:${forward}` : `file:///${forward.replace(/^\/+/, "")}`,
  ).href;
}

/**
 * Whether `argv1` names the module that is asking — i.e. this file is the entry
 * point and its `main()` may run.
 *
 * @param {string | undefined} argv1 usually `process.argv[1]`
 * @param {string} moduleUrl the caller's own `import.meta.url`
 * @returns {boolean}
 */
export function isEntryPoint(argv1, moduleUrl) {
  const entry = fileUrlOfPath(argv1);
  return entry !== null && typeof moduleUrl === "string" && entry === moduleUrl;
}
