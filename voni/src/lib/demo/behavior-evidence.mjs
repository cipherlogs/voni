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
 * One deterministic material string for a set of untracked files: path, NUL,
 * sha256 of its bytes, newline; sorted by path. Porcelain collapses an
 * untracked directory to `?? dir/`, so this is the only way a content change
 * inside it moves the dirty hash. It is appended only when the tree is
 * already dirty, which keeps every clean hash exactly as earlier runs recorded.
 *
 * @param {readonly { path: string, bytes: Buffer | string }[]} entries
 * @returns {string}
 */
export function untrackedMaterial(entries) {
  return [...entries]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(
      (entry) =>
        `${entry.path}\0${createHash("sha256").update(entry.bytes).digest("hex")}\n`,
    )
    .join("");
}

/**
 * Pure fingerprint from git's outputs (HEAD, porcelain status, full
 * `git diff HEAD`, and untracked file material). The same helper serves
 * score-demo's artifact fingerprint and the behavior runner's evidence, so the
 * two can never drift in shape.
 *
 * @param {{ head?: string | null, status?: string | null, diff?: string | null, untracked?: string | null } | null | undefined} input
 * @returns {CodeFingerprint | null}
 */
export function codeFingerprintFromGit(input) {
  const head = input?.head?.trim();
  if (!head) return null;
  const status = input?.status ?? "";
  const diff = input?.diff ?? "";
  const untracked = input?.untracked ?? "";
  const dirty = status.trim() !== "" || diff.trim() !== "" || untracked.trim() !== "";
  // A clean tree (and a dirty tree with no untracked files) keeps the exact
  // material earlier fingerprints used. Only an untracked set changes it.
  const material =
    untracked.trim() === "" ? `${status}\n${diff}` : `${status}\n${diff}\n${untracked}`;
  return {
    head,
    dirty,
    dirtyHash: createHash("sha256").update(material).digest("hex"),
  };
}
