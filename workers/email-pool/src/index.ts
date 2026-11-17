/**
 * Email-pool worker: a secret-gated fetch proxy that follows redirect chains
 * and reports where they landed. One source file, deployed N times as
 * email-pool-01..NN.
 *
 * Contract: docs/agents/email-pool.md
 */

import { isAuthorized } from "./auth.ts";
import { runClick, poolWorkerId } from "./click.ts";
import type { ClickObservation, PoolEnv } from "./click.ts";
import { isRegionHint } from "./region-probe.ts";
import type { RegionHint } from "./region-probe.ts";
import { validateTarget } from "./target.ts";

// The migration names these classes, so they must be real exports of the entry
// module — not just route implementation details.
export { RegionProbe } from "./region-probe.ts";
export { PinnedClick } from "./pinned-click.ts";

const DEFAULT_HINT = "enam";

interface ClickBody {
  url?: unknown;
  visitId?: unknown;
}

function coloOf(request: Request): string {
  const cf = (request as Request & { cf?: { colo?: string } }).cf;
  return cf?.colo ?? "UNKNOWN";
}

/** This worker's own colo for /click, or null when the runtime gave none. */
function nullableColo(request: Request): string | null {
  const cf = (request as Request & { cf?: { colo?: string } }).cf;
  return cf?.colo ?? null;
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

/**
 * The 502 shape: a click that never produced a response. It accepts whatever
 * the Durable Object reported, so a missing field degrades to a named reason
 * instead of `undefined` in the JSON.
 */
function failureBody(source: {
  reason?: unknown;
  detail?: unknown;
}): { ok: false; reason: string; detail: string } {
  const reason =
    typeof source.reason === "string" && source.reason !== ""
      ? source.reason
      : "fetch_failed";
  return {
    ok: false,
    reason,
    detail: typeof source.detail === "string" ? source.detail : "",
  };
}

/** A parsed DO body is an observation only when it carries a numeric status. */
function isObservation(value: unknown): value is ClickObservation {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { status?: unknown }).status === "number"
  );
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

/**
 * The location hint this instance pins its click object to. A typo must not
 * fall back to a silently different region, so an unknown value is null and the
 * route answers with a named error.
 */
function regionHint(env: PoolEnv): RegionHint | null {
  const raw = env.POOL_REGION_HINT;
  const hint = typeof raw === "string" && raw !== "" ? raw : DEFAULT_HINT;
  return isRegionHint(hint) ? hint : null;
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

      // Read the hint only after auth and validation: a misconfigured instance
      // is a server error its operator sees, not a probe unauthenticated callers
      // can use to fingerprint the region.
      const hint = regionHint(env);
      if (hint === null) {
        return json(
          {
            ok: false,
            reason: "bad_region_hint",
            detail: `POOL_REGION_HINT="${String(env.POOL_REGION_HINT)}" is not a supported location hint`,
          },
          500,
        );
      }

      const namespace = env.POOL_CLICK;

      if (!namespace) {
        // Local dev before the v2 migration has no PinnedClick class, so fetch
        // inline from this Worker and keep `npm run dev` working. `colo` is then
        // whatever this Worker got (null under miniflare), never the hint.
        const inline = await runClick(validation.url, env, {
          fetch: (input, init) => globalThis.fetch(input, init),
          colo: nullableColo(request),
          region: hint,
        });

        if (inline.status === null) {
          return json(failureBody(inline), 502);
        }

        return json(inline, 200);
      }

      let observation: unknown;
      try {
        // The object id is per instance *and* per hint: Cloudflare only applies
        // a location hint when it creates the object, so a shared id could let
        // an object created for one hint answer for another.
        const stub = namespace.get(
          namespace.idFromName(`${worker}-${hint}`),
          { locationHint: hint },
        );

        const response = await stub.fetch(
          new Request("https://pinned-click.internal/click", {
            method: "POST",
            headers: { "content-type": "application/json" },
            // The hint rides the request, so the object needs no state to know
            // which region it is reporting.
            body: JSON.stringify({ url: validation.url.toString(), region: hint }),
          }),
        );

        const text = await response.text();
        try {
          observation = JSON.parse(text);
        } catch {
          return json({ ok: false, reason: "click_bad_response" }, 502);
        }
      } catch (error) {
        // The stub itself failed: the click never ran anywhere.
        return json(
          { ok: false, reason: "fetch_failed", detail: errorDetail(error) },
          502,
        );
      }

      // Transport failures from inside the object keep the contract's 502; an
      // observed status — including a target 4xx/5xx — rides the 200 shape.
      if (isObservation(observation)) {
        return json(observation, 200);
      }

      return json(
        failureBody(
          observation !== null && typeof observation === "object"
            ? (observation as { reason?: unknown; detail?: unknown })
            : {},
        ),
        502,
      );
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
