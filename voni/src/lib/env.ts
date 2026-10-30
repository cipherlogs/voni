import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Read a server-side secret, from wherever this runtime actually keeps it.
 *
 * Two sources, and the split follows OpenNext's recommended layout:
 *
 *   .env.local  — every local value. Next loads it into `process.env`, and
 *                 OpenNext bakes it into the Worker at build time.
 *   .dev.vars   — Worker-runtime overrides only (`NEXTJS_ENV`, `LANDING_HOST=`).
 *                 `initOpenNextCloudflareForDev()` exposes these through the
 *                 *Cloudflare context*, not `process.env`.
 *
 * So `process.env` alone is enough for anything in `.env.local`, but a binding
 * that only exists on the Worker (a real secret, a `wrangler.jsonc` var) can be
 * absent from it. That fallback is cheap insurance, and forgetting it is easy
 * to lose an hour to — the database works fine and makes the environment look
 * healthy while the feature reports itself "not configured".
 *
 * Checking `process.env` first keeps ordinary deploys, tests and CI working
 * (and on Workers in production OpenNext populates it), with the Cloudflare
 * context as the fallback that makes local development behave the same.
 */
export async function secret(name: string): Promise<string | undefined> {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;

  try {
    const { env } = await getCloudflareContext({ async: true });
    const value = (env as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : undefined;
  } catch {
    // No Cloudflare context (plain Node, a unit test, a build-time import).
    // An absent secret is the caller's problem to report, not ours to throw on.
    return undefined;
  }
}

/** Convenience for the several call sites that need more than one. */
export async function secrets<T extends string>(
  ...names: T[]
): Promise<Record<T, string | undefined>> {
  const values = await Promise.all(names.map((n) => secret(n)));
  return Object.fromEntries(names.map((n, i) => [n, values[i]])) as Record<
    T,
    string | undefined
  >;
}
