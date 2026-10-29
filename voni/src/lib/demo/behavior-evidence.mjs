/**
 * Shared candidate-behavior evidence contract (ticket 29).
 *
 * Plain ESM so both the TypeScript scorer (`../scoreboard`, run through tsx)
 * and the plain-Node isolated E2E runner (`scripts/e2e-run.mjs`) read one
 * definition. The evidence file is written on green and red, so the exit
 * claim can never silently omit the browser run.
 */
import { createHash } from "node:crypto";

/** @type {"voni-behavior-run"} */
export const BEHAVIOR_RUN_EVIDENCE_KIND = "voni-behavior-run";

/** @type {1} */
export const BEHAVIOR_RUN_EVIDENCE_SCHEMA_VERSION = 1;

/**
 * @typedef {{ head: string, dirty: boolean, dirtyHash: string }} CodeFingerprint
 */

/**
 * Pure fingerprint from git's three outputs (HEAD, porcelain status, full
 * `git diff HEAD`). The same helper serves score-demo's artifact fingerprint
 * and the behavior runner's evidence, so the two can never drift in shape.
 *
 * @param {{ head?: string | null, status?: string | null, diff?: string | null } | null | undefined} input
 * @returns {CodeFingerprint | null}
 */
export function codeFingerprintFromGit(input) {
  const head = input?.head?.trim();
  if (!head) return null;
  const status = input?.status ?? "";
  const diff = input?.diff ?? "";
  return {
    head,
    dirty: status.trim() !== "" || diff.trim() !== "",
    dirtyHash: createHash("sha256").update(`${status}\n${diff}`).digest("hex"),
  };
}
