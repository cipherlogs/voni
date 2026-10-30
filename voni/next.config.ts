import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Phones on the LAN open the dev server by this machine's IP; without this
  // Next blocks /_next dev resources, the page never hydrates, and no button
  // works. Dev-only: production ignores it.
  allowedDevOrigins: Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address),
  // Cache Components adoption (myplan.md Task 7, direct one-branch):
  // Partial Prefetching enabled in Task 12 after a clean flag-off audit
  // (Task 11: zero prefetch props / router.prefetch calls — no legacy
  // full-prefetch contract, no route-level exports needed).
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    exposeTestingApiInProductionBuild:
      process.env.VONI_INSTANT_TEST_BUILD === "1",
  },
};

export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();

/**
 * Local env, following OpenNext's recommended layout (cloudflare/howtos/env-vars):
 *
 *   `.env.local`  every value. Next loads it into `process.env` itself, before
 *                 this config file is evaluated, so `src/lib/auth.ts` and the
 *                 `next build` page-data workers see it at module scope.
 *   `.dev.vars`   Worker-runtime overrides only — `NEXTJS_ENV` (which `.env`
 *                 mode the local Worker uses) and `LANDING_HOST=` (override the
 *                 committed prod var). Its values reach the Worker through
 *                 `initOpenNextCloudflareForDev()` below, not `process.env`.
 *
 * Nothing here bridges the two: `src/lib/env.ts`'s `secret()` checks
 * `process.env` first and falls back to the Cloudflare context, so both
 * sources are covered at the point of use. See voni/ENVIRONMENT.md.
 */
