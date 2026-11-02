/**
 * A run id is one path component: `--resume` names a directory, the journal
 * lives inside it and a certificate file is named after it. The argv parser
 * and the journal reader refuse the same values, so the rule lives here once.
 */

/** One safe run id: letters, digits, dot, dash or underscore, never a path. */
export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** True when the value may name a run; `..` is never a run id. */
export function isSafeRunId(value: string): boolean {
  return SAFE_RUN_ID.test(value) && !value.includes("..");
}
