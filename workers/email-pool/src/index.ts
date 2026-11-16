/**
 * Email-pool worker: a secret-gated fetch proxy with a strict target
 * allowlist. One source file, deployed N times as email-pool-01..NN.
 *
 * Contract: docs/agents/email-pool.md
 */

import { isAuthorized } from "./auth.ts";
import { runClick, poolWorkerId } from "./click.ts";
import type { ClickResult, PoolEnv } from "./click.ts";
import { validateTarget } from "./target.ts";

interface ClickBody {
  url?: unknown;
  visitId?: unknown;
}

const DEFAULT_ALLOWED_HOSTS = ["voni.cc", "www.voni.cc", "cipherlogs.github.io"];

function coloOf(request: Request): string {
  const cf = (request as Request & { cf?: { colo?: string } }).cf;
  return cf?.colo ?? "UNKNOWN";
}

export function parseAllowedHosts(env: PoolEnv): string[] {
  const raw =
    typeof env.ALLOWED_TARGET_HOSTS === "string"
      ? env.ALLOWED_TARGET_HOSTS
      : DEFAULT_ALLOWED_HOSTS.join(",");
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

function allowPrivate(env: PoolEnv): boolean {
  return String(env.ALLOW_PRIVATE_TARGETS ?? "").toLowerCase() === "true";
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
  result: ClickResult,
): { ok: false; reason: string; detail?: string } {
  const failure: { ok: false; reason: string; detail?: string } = {
    ok: false,
    reason: result.reason ?? "fetch_failed",
  };
  if (result.detail) failure.detail = result.detail;
  return failure;
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
      return json(
        { worker, colo, allowlist: parseAllowedHosts(env) },
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

      const validation = validateTarget(body?.url, {
        allowedHosts: parseAllowedHosts(env),
        allowPrivate: allowPrivate(env),
      });

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

      if (result.ok) {
        return json(result, 200);
      }

      // Transport failures map to the contract's 502; an HTTP error status is
      // a successful observation of the target, so it rides the 200 shape.
      if (result.reason === "timeout" || result.reason === "fetch_failed") {
        return json(workerFailure(result), 502);
      }

      return json(result, 200);
    }

    return json({ ok: false, reason: "not_found" }, 404);
  },
};
