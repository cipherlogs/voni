import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();

/**
 * Mirror `.dev.vars` into `process.env` for local Next commands.
 *
 * This project has two env files that do NOT overlap:
 *   `.env.local`  written by the Neon CLI, loaded by Next -> process.env.
 *                 Contains DATABASE_URL and nothing else.
 *   `.dev.vars`   the Cloudflare convention. `initOpenNextCloudflareForDev()`
 *                 above exposes it through the Cloudflare context, but NOT
 *                 through process.env.
 *
 * Everything else lives in `.dev.vars`: the AssemblyAI key, Google OAuth,
 * Better Auth's secret, every LLM provider key. Without this bridge they all
 * read `undefined` under `next dev`, and the failures are quiet and
 * misdirecting — the database works, so the environment looks healthy, while
 * Google sign-in and voice calls report themselves as "not configured".
 *
 * It has to happen here rather than in a helper because `src/lib/auth.ts`
 * reads its secrets at module scope, before any request-time code could run.
 *
 * This includes `next build`: its page-data workers import Better Auth and
 * validate the secret at module load. Loading the local Cloudflare vars here
 * keeps that validation real instead of printing a default-secret error on an
 * otherwise successful build. Deployed workers and CI do not carry this local
 * file, and existing environment values always win.
 */
try {
  const raw = readFileSync(join(process.cwd(), ".dev.vars"), "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // Strip one layer of matching quotes, the way dotenv does.
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    if (value && !process.env[key]) process.env[key] = value;
  }
} catch {
  // No .dev.vars is a legitimate state (CI, a fresh clone). Anything that
  // actually needs a secret reports it clearly at the point of use.
}
