import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { secret } from "@/lib/env";
import { rateLimits } from "@/lib/db/schema";

/**
 * Rate limiting for the public demo.
 *
 * In Postgres rather than memory because the deploy target is Cloudflare
 * Workers: each request can land in a different isolate, so a process-local
 * counter enforces nothing at all. One upsert per token request is affordable —
 * a token is minted once per call, not once per audio frame.
 *
 * Two independent ceilings, because they stop different things:
 *   - per-IP  stops one person hammering it
 *   - global  stops a distributed crowd (or a botnet) draining the credit,
 *             which the per-IP limit alone cannot
 *
 * The global cap is the one that actually bounds the bill. At the 12-minute
 * wall-clock cap (talk-clock.ts) and $0.075/min, each demo costs at most
 * $0.90, so the default 60/day ceiling is about $54/day worst case; a
 * typical call ends at 2 minutes of talk.
 */

const DEFAULTS = {
  perIpPerHour: 3,
  perDayGlobal: 60,
};

export type LimitDecision =
  | { allowed: true }
  | { allowed: false; reason: string; retryAfterSeconds: number };

function parseLimit(raw: string | undefined, fallback: number): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Limit override, from wherever this runtime keeps env: plain deploys and
 * CI populate `process.env`, while `next dev` loads `.dev.vars` into the
 * Cloudflare context instead (see `src/lib/env.ts`). Reading only
 * `process.env` silently ignores local overrides.
 */
async function envInt(name: string, fallback: number): Promise<number> {
  if (process.env[name] !== undefined) return parseLimit(process.env[name], fallback);
  return parseLimit(await secret(name), fallback);
}

/**
 * The caller's IP, as seen through whatever proxy is in front of us.
 *
 * Cloudflare sets `cf-connecting-ip` and it cannot be spoofed by the client
 * once traffic is behind Cloudflare, so it is preferred. `x-forwarded-for` is
 * client-settable if anything is misconfigured, hence the fallback order — and
 * its FIRST entry is the original client, later ones are proxies.
 */
export function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers.get("x-real-ip")?.trim() ?? "unknown";
}

/**
 * Hash the IP before it becomes a database key.
 *
 * A rate-limit table does not need to know who anyone is, and storing raw
 * addresses turns an abuse counter into a log of who visited the site. A
 * per-deployment secret means the hashes are not reversible by rainbow table.
 */
async function ipKey(ip: string): Promise<string> {
  const salt = process.env.BETTER_AUTH_SECRET ?? "voni-demo";
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Increment a bucket and report whether it is still under `limit`.
 *
 * The whole check is one statement so it is atomic: read-then-write would let
 * two concurrent requests both see count-1 and both proceed. `ON CONFLICT` with
 * an expiry comparison also recycles a bucket whose window has passed, so no
 * sweeper job is required for correctness — only for tidiness.
 *
 * Exported for the copilot token route, which needs the same Cloudflare-safe
 * atomicity with its own per-user bucket and window.
 */
export async function bumpRateBucket(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<{ ok: boolean; count: number }> {
  const rows = await db.execute<{ count: number }>(sql`
    INSERT INTO ${rateLimits} (bucket, count, expires_at)
    VALUES (${bucket}, 1, now() + ${`${windowSeconds} seconds`}::interval)
    ON CONFLICT (bucket) DO UPDATE
      SET count = CASE
            WHEN ${rateLimits.expiresAt} < now() THEN 1
            ELSE ${rateLimits.count} + 1
          END,
          expires_at = CASE
            WHEN ${rateLimits.expiresAt} < now()
              THEN now() + ${`${windowSeconds} seconds`}::interval
            ELSE ${rateLimits.expiresAt}
          END
    RETURNING count
  `);
  const count = Number(rows.rows[0]?.count ?? 0);
  return { ok: count <= limit, count };
}

/** Check both ceilings. Called once per demo token request. */
export async function checkDemoLimits(headers: Headers): Promise<LimitDecision> {
  const perIp = await envInt("DEMO_MAX_PER_IP_PER_HOUR", DEFAULTS.perIpPerHour);
  const perDay = await envInt("DEMO_MAX_PER_DAY", DEFAULTS.perDayGlobal);

  // A zero limit is a deliberate kill switch for the public demo.
  if (perIp === 0 || perDay === 0) {
    return {
      allowed: false,
      reason: "The live demo is turned off right now.",
      retryAfterSeconds: 3600,
    };
  }

  const day = new Date().toISOString().slice(0, 10);
  const hour = new Date().toISOString().slice(0, 13);

  // Global first: if the day's budget is gone, don't spend a write on the
  // per-IP bucket, and don't let one person's quota depend on ordering.
  const global = await bumpRateBucket(`demo:global:${day}`, perDay, 24 * 3600);
  if (!global.ok) {
    return {
      allowed: false,
      reason: "The demo has hit today's limit. Try again tomorrow.",
      retryAfterSeconds: 3600,
    };
  }

  const key = await ipKey(clientIp(headers));
  const ip = await bumpRateBucket(`demo:ip:${key}:${hour}`, perIp, 3600);
  if (!ip.ok) {
    return {
      allowed: false,
      reason: `You've used your ${perIp} demo calls this hour. Try again later.`,
      retryAfterSeconds: 3600,
    };
  }

  return { allowed: true };
}
