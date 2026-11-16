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
import { validateTarget } from "./target.ts";

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

    return json({ ok: false, reason: "not_found" }, 404);
  },
};
