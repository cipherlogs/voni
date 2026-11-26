/**
 * The pool's operator-configured sizes, read once when the client starts.
 *
 * Two numbers reach the client this way:
 *
 *   - `TUXLER_POOL_TARGET` (default 5, 3–8) — the size the pool fills to. It is
 *     the console's saved `proxy_pool_target`, carried on the dispatch and
 *     mapped to this variable by `browser-check.yml`.
 *   - `TUXLER_POOL_DEPTH` (default 3, 0–3) — how many child buckets deep the
 *     refill tree may grow. `0` means the root bucket only, so no child is ever
 *     dialled. It is a client-side setting, not a dispatch input: a change costs
 *     changes, and the operator turns the budget down on the runner.
 *
 * Both are validated rather than clamped. A pool that silently becomes five
 * because the card said eleven would be a setting that does not reach the
 * client, which is exactly the failure this module exists to end.
 */
import {
  PROXY_POOL_MAX,
  PROXY_POOL_MIN,
  PROXY_POOL_TARGET_DEFAULT,
} from "@/lib/email/proxy-policy";
import { POOL_DEPTH } from "./pool";

export const POOL_TARGET_ENV = "TUXLER_POOL_TARGET";
export const POOL_DEPTH_ENV = "TUXLER_POOL_DEPTH";

/** A configuration value the client refuses to start with. */
export class PoolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolConfigError";
  }
}

export interface PoolConfig {
  readonly target: number;
  readonly depth: number;
}

function readInteger(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new PoolConfigError(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  }
  return Number(text);
}

/**
 * The pool's two sizes from the environment, or a refusal naming the variable.
 * An unset or blank variable is the default; anything outside its range is an
 * error, never a quiet substitution.
 */
export function poolConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): PoolConfig {
  const target = readInteger(env[POOL_TARGET_ENV], POOL_TARGET_ENV, PROXY_POOL_TARGET_DEFAULT);
  if (target < PROXY_POOL_MIN || target > PROXY_POOL_MAX) {
    throw new PoolConfigError(
      `${POOL_TARGET_ENV} must be from ${PROXY_POOL_MIN} to ${PROXY_POOL_MAX}, got ${target}`,
    );
  }

  const depth = readInteger(env[POOL_DEPTH_ENV], POOL_DEPTH_ENV, POOL_DEPTH);
  if (depth < 0 || depth > POOL_DEPTH) {
    throw new PoolConfigError(
      `${POOL_DEPTH_ENV} must be from 0 (no child buckets) to ${POOL_DEPTH}, got ${depth}`,
    );
  }

  return { target, depth };
}
