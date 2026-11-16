import { NextResponse } from "next/server";
import {
  fanOutToWorkers,
  nextEmailTarget,
  parseWorkerUrls,
  resolveTarget,
} from "@/lib/email/pool";
import { secret } from "@/lib/env";

/**
 * The voni half of the `/email` edge-worker pool (contract:
 * `docs/agents/email-pool.md`).
 *
 * The route is the only thing that chooses the target: it draws an absolute URL
 * from the no-repeat bag and stamps the attribution on it, so the browser cannot
 * turn this into an open proxy. `POST` therefore takes no request at all, not
 * even an ignored one — nothing here can be influenced by a body.
 *
 * Node runtime by default; outbound `fetch` only, so the OpenNext/Cloudflare
 * build handles it like every sibling route. There is deliberately no
 * `export const runtime`: this app sets `cacheComponents: true`, and Next
 * rejects route segment config there.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

function notConfigured(message: string) {
  return NextResponse.json(
    { ok: false, reason: "not_configured", message },
    { status: 503, headers: NO_STORE },
  );
}

export async function POST() {
  const [poolSecret, rawWorkerUrls] = await Promise.all([
    secret("POOL_SECRET"),
    secret("POOL_WORKER_URLS"),
  ]);

  const urls = parseWorkerUrls(rawWorkerUrls);
  const missing = [
    poolSecret ? null : "POOL_SECRET",
    urls.length > 0 ? null : "POOL_WORKER_URLS",
  ].filter((name): name is string => name !== null);

  if (missing.length > 0 || !poolSecret) {
    return notConfigured(
      `The email pool needs ${missing.join(" and ")}. Set them on the server ` +
        `(POOL_SECRET is the shared worker secret, POOL_WORKER_URLS is a ` +
        `comma-separated list of Worker origins) and reload this page.`,
    );
  }

  const target = resolveTarget(nextEmailTarget());
  const result = await fanOutToWorkers({
    urls,
    secret: poolSecret,
    target,
    visitId: crypto.randomUUID(),
  });

  return NextResponse.json(
    { ok: true, ...result },
    { headers: NO_STORE },
  );
}
