/**
 * Email-pool worker: a secret-gated fetch proxy that follows redirect chains
 * and reports where they landed. One source file, deployed N times as
 * email-pool-01..NN.
 *
 * Contract: docs/agents/email-pool.md
 */

import { isAuthorized } from "./auth.ts";
import { runClick, poolWorkerId } from "./click.ts";
import type { ClickFailure, PoolEnv } from "./click.ts";
import { isRegionHint } from "./region-probe.ts";
import { validateTarget } from "./target.ts";

// The migration names this class, so it must be a real export of the entry
// module — not just a route implementation detail.
export { RegionProbe } from "./region-probe.ts";

const DEFAULT_HINT = "enam";

interface ClickBody {
  url?: unknown;
  visitId?: unknown;
}

function coloOf(request: Request): string {
  const cf = (request as Request & { cf?: { colo?: string } }).cf;
  return cf?.colo ?? "UNKNOWN";
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function workerFailure(
  result: ClickFailure,
): { ok: false; reason: string; detail: string } {
  return { ok: false, reason: result.reason, detail: result.detail };
}

export default {
  async fetch(request: Request, env: PoolEnv): Promise<Response> {
    const url = new URL(request.url);
    const worker = poolWorkerId(env);
    const colo = coloOf(request);

    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ ok: false, reason: "method_not_allowed" }, 405);
      }
      // No host policy to report: the pool fetches any host voni names.
      return json(
        {
          worker,
          colo,
          redirects: "follow",
          targets: "any absolute http(s) URL",
        },
        200,
      );
    }

    if (url.pathname === "/click") {
      if (request.method !== "POST") {
        return json({ ok: false, reason: "method_not_allowed" }, 405);
      }

      if (!isAuthorized(request, env)) {
        return json({ ok: false, reason: "unauthorized" }, 401);
      }

      let body: ClickBody;
      try {
        body = (await request.json()) as ClickBody;
      } catch {
        return json(
          { ok: false, reason: "bad_request", detail: "body is not valid JSON" },
          400,
        );
      }

      const validation = validateTarget(body?.url);

      if (!validation.ok) {
        return json(
          { ok: false, reason: "bad_target", detail: validation.detail },
          400,
        );
      }

      const result = await runClick(validation.url, env, {
        fetch: (input, init) => globalThis.fetch(input, init),
        colo,
      });

      // Transport failures map to the contract's 502; an HTTP error status is
      // a successful observation of the target, so it rides the 200 shape.
      if (result.status === null) {
        return json(workerFailure(result), 502);
      }

      return json(result, 200);
    }

    if (url.pathname === "/probe-region") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ ok: false, reason: "method_not_allowed" }, 405);
      }

      // The probe makes outbound requests, so it is gated exactly like /click:
      // same secret, same 401 shape.
      if (!isAuthorized(request, env)) {
        return json({ ok: false, reason: "unauthorized" }, 401);
      }

      const requested = url.searchParams.get("hint");
      const hint = requested === null || requested === "" ? DEFAULT_HINT : requested;
      if (!isRegionHint(hint)) {
        return json({ ok: false, reason: "bad_hint" }, 400);
      }

      const namespace = env.POOL_REGION;
      if (!namespace) {
        // Local dev before the migration, or a deploy that lost the binding.
        return json({ ok: false, reason: "probe_not_configured" }, 503);
      }

      let probe: unknown;
      let status: number;
      try {
        // A distinct id per hint: Cloudflare only applies a location hint when
        // it creates the object, so a shared id could silently answer for a
        // different hint's object.
        const stub = namespace.get(
          namespace.idFromName(`region-probe-${hint}`),
          { locationHint: hint },
        );
        const response = await stub.fetch(
          new Request("https://region-probe.internal/", { method: "GET" }),
        );

        const text = await response.text();
        try {
          probe = JSON.parse(text);
        } catch {
          return json({ ok: false, reason: "probe_bad_response" }, 502);
        }

        // 502 means both sources failed; mirror that so a caller cannot read a
        // total failure as a success.
        const failed =
          probe !== null &&
          typeof probe === "object" &&
          (probe as { ok?: unknown }).ok === false;
        status = failed ? 502 : 200;
      } catch (error) {
        const detail =
          error instanceof Error && error.message
            ? error.message.slice(0, 300)
            : String(error).slice(0, 300);
        return json({ ok: false, reason: "probe_unavailable", detail }, 502);
      }

      return json({ worker, colo, hint, durableObject: probe }, status);
    }

    return json({ ok: false, reason: "not_found" }, 404);
  },
};
