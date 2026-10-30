import { VoiceStartError } from "./mic-capture";
import { RateLimitError } from "./session";

/**
 * The browser's one door to a demo call (demo-cascade ticket 10).
 *
 * The managed demo token is gone: `POST /api/demo/token` (ticket 09) mints the
 * cascade contract instead — the pipeline WebSocket URL, the demo subject, the
 * single-use cascade call token, and the demo call token that authorizes the
 * tool and judge routes. The browser holds no prompt, no tool list and no
 * pipeline configuration.
 *
 * This module owns the request shape and the response type so the component
 * never guesses what the route returns, and it keeps the two visitor-facing
 * failure modes intact: a 429 is a typed `RateLimitError` with its countdown,
 * and every other refusal carries the route's own line.
 */

/** Where the one demo mint lives. */
export const DEMO_MINT_PATH = "/api/demo/token";

/** The fallback when the route refuses without naming a reason. */
export const DEMO_MINT_UNAVAILABLE = "Could not start the demo call.";

/** The exact response contract from ticket 09, in one place. */
export const DEMO_MINT_FIELDS = [
  "engine",
  "wsUrl",
  "agentId",
  "callToken",
  "demoCallToken",
  "testTag",
  "tagToken",
  "tagCarried",
  "maxSessionSeconds",
] as const;

export type DemoMint = {
  /** The demo is cascade-only; a managed response is refused, not run. */
  engine: "cascade";
  /** The minted pipeline WebSocket URL; the browser connects here. */
  wsUrl: string;
  /** The routing subject the browser sends: `demo:<voice>`. */
  agentId: string;
  /** The single-use cascade call token (`ct1.…`). */
  callToken: string;
  /** The demo call token (`<callId>.<exp>.<tagId>.<mac>`) for tools/judges. */
  demoCallToken: string;
  testTag: string;
  tagToken: string;
  tagCarried: boolean;
  maxSessionSeconds: number;
};

export type DemoMintOptions = {
  /** A hold rejoin continues the same call; omitted for a fresh call. */
  resume?: boolean;
  /** The carried demo call token; omitted for a fresh call. */
  callToken?: string;
  /** The visitor's Test tag, kept a day by the browser. */
  tagToken?: string;
};

export type DemoMintFetcher = (
  voiceId: string,
  opts?: DemoMintOptions,
  deps?: DemoMintDeps,
) => Promise<DemoMint>;

export type DemoMintDeps = {
  /** Injected for tests; the browser's `fetch` otherwise. */
  fetch?: typeof fetch;
};

function isCascadeMint(value: unknown): value is DemoMint {
  if (typeof value !== "object" || value === null) return false;
  const minted = value as Record<string, unknown>;
  return (
    minted.engine === "cascade" &&
    typeof minted.wsUrl === "string" &&
    minted.wsUrl !== "" &&
    typeof minted.agentId === "string" &&
    minted.agentId !== "" &&
    typeof minted.callToken === "string" &&
    minted.callToken !== "" &&
    typeof minted.demoCallToken === "string" &&
    typeof minted.testTag === "string" &&
    typeof minted.tagToken === "string" &&
    typeof minted.tagCarried === "boolean" &&
    typeof minted.maxSessionSeconds === "number"
  );
}

function retryAfterSeconds(res: Response): number {
  const retryAfter = Number(res.headers.get("Retry-After"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
}

/** Mint one demo call. The caller owns the mic gesture; this only fetches. */
export async function demoMint(
  voiceId: string,
  opts: DemoMintOptions = {},
  deps: DemoMintDeps = {},
): Promise<DemoMint> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(DEMO_MINT_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      voiceId,
      // A hold rejoin binds the greeting-less resume body, so the welcome-back
      // is the single first utterance. Omitted otherwise.
      ...(opts.resume === true ? { resume: true } : {}),
      // The call's token rides along on a rejoin, so the server keeps the same
      // call (id, budgets, tag) instead of opening a new one.
      ...(opts.callToken ? { callToken: opts.callToken } : {}),
      // The visitor's Test tag, kept a day by the browser (docs/adr/0004).
      ...(opts.tagToken ? { tagToken: opts.tagToken } : {}),
    }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: null as string | null }));
    if (res.status === 429) {
      throw new RateLimitError(error ?? "Too many demo calls right now.", retryAfterSeconds(res));
    }
    const message = error ?? DEMO_MINT_UNAVAILABLE;
    if (res.status === 401) throw new VoiceStartError("auth", message);
    // A 503 is the pipeline refusing the call (draining, missing secret,
    // malformed body, store unavailable): the route's visitor-facing line is
    // the whole answer, and it never becomes a managed fallback.
    throw new VoiceStartError("network", message);
  }

  const minted: unknown = await res.json();
  if (!isCascadeMint(minted)) {
    // The old managed shape (`token`, no `wsUrl`) lands here by name, so a
    // stale route cannot silently boot a managed session.
    throw new VoiceStartError("config", DEMO_MINT_UNAVAILABLE);
  }
  return minted;
}
