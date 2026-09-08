import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Read a server-side secret, from wherever this runtime actually keeps it.
 *
 * There are two env sources in this project and they do NOT overlap:
 *
 *   .env.local  — written by the Neon CLI, loaded by Next into `process.env`.
 *                 Holds DATABASE_URL and nothing else.
 *   .dev.vars   — the Cloudflare convention, loaded by
 *                 `initOpenNextCloudflareForDev()` in next.config.ts into the
 *                 *Cloudflare context*, not into `process.env`.
 *
 * Everything that matters — the AssemblyAI key, Google OAuth, Better Auth's
 * secret, every LLM provider key — lives in `.dev.vars`. So a plain
 * `process.env.ASSEMBLYAI_API_KEY` reads `undefined` under `next dev` and the
 * feature silently reports itself as "not configured". That is exactly the bug
 * this function exists to stop, and it is easy to lose an hour to because the
 * database works fine and makes the environment look healthy.
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
