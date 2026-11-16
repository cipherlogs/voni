/**
 * Shared-secret auth for POST /click.
 *
 * The comparison must not early-exit on content: a length check first, then a
 * constant-time XOR accumulate over the whole (equal-length) byte string.
 */

export interface AuthEnv {
  POOL_SECRET?: string;
  [key: string]: unknown;
}

const encoder = new TextEncoder();

/**
 * Constant-time string comparison.
 *
 * Length is not secret (it is fixed by deployment config), so the early length
 * check leaks nothing useful; every byte is still compared once lengths match.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

export function headerSecret(request: Request): string | null {
  const value = request.headers.get("x-pool-secret");
  return value === null || value === "" ? null : value;
}

/** False when POOL_SECRET is unset: an unconfigured worker is closed, not open. */
export function isAuthorized(request: Request, env: AuthEnv): boolean {
  const expected = env.POOL_SECRET;
  if (typeof expected !== "string" || expected === "") return false;

  const provided = headerSecret(request);
  if (provided === null) return false;

  return timingSafeEqual(provided, expected);
}
