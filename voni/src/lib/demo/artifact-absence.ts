/**
 * The named N/A a gap an engine cannot produce records (M13, ticket 117).
 *
 * These strings live apart from `scoreboard.ts` so the artifact reader can name
 * them without a module cycle: the reader imports the scoreboard for its types
 * and validators, and the scoreboard re-exports these names for every existing
 * caller.
 */

export const MANAGED_NO_PARTIALS_ABSENCE = "N/A — no partials";
export const MANAGED_NO_TOKEN_STREAM_ABSENCE = "N/A — no token stream";
export const MANAGED_NO_COMMIT_MARK_ABSENCE = "N/A — no commit mark on the managed artifact";
export const CASCADE_NO_COMMIT_MARK_ABSENCE = "N/A — the cascade has no commit mark";
