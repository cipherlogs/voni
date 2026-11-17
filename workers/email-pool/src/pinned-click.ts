/**
 * Pinned click: the POST /click fetch path, moved into a Durable Object.
 *
 * The invoking Worker stays wherever the caller reached it (Madrid, today). A
 * DO created with `locationHint: "enam"` runs in the US and its `fetch()`
 * egresses from there, so putting `runClick` inside the object turns the
 * location hint into a real region lever for the click itself.
 *
 * `locationHint` is best-effort, so this reports the colo the runtime actually
 * gave the object (`request.cf.colo`) instead of echoing the hint back.
 *
 * Stateless on purpose: the caller sends both the target and the region hint in
 * the request, so nothing is retained between calls and a fresh deploy needs no
 * storage.
 *
 * One object is serialized per id, which caps concurrent clicks per instance —
 * see "Pinned click" in the README.
 */

import { runClick } from "./click.ts";
import type { ClickResult, PoolEnv } from "./click.ts";
import { isRegionHint } from "./region-probe.ts";
import { validateTarget } from "./target.ts";

interface PinnedClickBody {
  url?: unknown;
  region?: unknown;
}

/**
 * The object's own colo, taken from the request the runtime delivered to it.
 * Absent (local dev, or a runtime that does not populate `cf`) is null — never
 * a made-up code.
 */
function coloOf(request: Request): string | null {
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

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

/**
 * The Durable Object. Every request is one click, answered from wherever the
 * object happens to be running.
 */
export class PinnedClick implements DurableObject {
  // Accepted so the runtime can hand the object storage later; unused today.
  private readonly state: DurableObjectState;
  private readonly env: PoolEnv;

  constructor(state: DurableObjectState, env: PoolEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const colo = coloOf(request);

    let body: PinnedClickBody;
    try {
      body = (await request.json()) as PinnedClickBody;
    } catch {
      return json(
        { ok: false, reason: "bad_request", detail: "body is not valid JSON" },
        400,
      );
    }

    // The region arrives with the request (the route decides the hint), and the
    // object refuses an unknown one rather than reporting a region it never
    // ran in.
    const region = body?.region;
    if (typeof region !== "string" || !isRegionHint(region)) {
      return json(
        {
          ok: false,
          reason: "bad_region",
          detail: "region must be one of the supported location hints",
        },
        400,
      );
    }

    // The route already validated, but the object is a separate entry point
    // (another binding can reach it), so re-check at this boundary.
    const validation = validateTarget(body?.url);
    if (!validation.ok) {
      return json(
        { ok: false, reason: "bad_target", detail: validation.detail },
        400,
      );
    }

    let result: ClickResult;
    try {
      result = await runClick(validation.url, this.env, {
        fetch: (input, init) => globalThis.fetch(input, init),
        colo,
        region,
      });
    } catch (error) {
      // Unreachable by design, since runClick names its own failures; kept so a
      // surprise is a readable 502 instead of an opaque 500 the route guesses at.
      return json(
        {
          ok: false,
          reason: "fetch_failed",
          colo,
          region,
          detail: `click_threw: ${errorDetail(error)}`,
        },
        502,
      );
    }

    // A transport failure is a 502 so the route can map it without trusting a
    // missing status; an observed 4xx/5xx is a 200 that carries its own status.
    return json(result, result.status === null ? 502 : 200);
  }
}
