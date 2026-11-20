/**
 * The burst dispatch, proved without GitHub: what a missing token, a 204, a
 * 403 body, a 404 and a transport failure each become, and that the token
 * never reaches a string the panel could render.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BURST_RUN_URL,
  burstCommand,
  dispatchBurst,
  type BurstDispatchResult,
} from "./dispatch";
import { US_ZONES, planBurst } from "./plan";
import { TARGET_SELECTION_DEFAULT } from "../email/target-selection";

const TOKEN = "ghp_burstsecretvalue123";
const ALL_ZONES = US_ZONES.map((zone) => zone.id);

function plan() {
  const result = planBurst({
    clicks: 2_000,
    durationSec: 120,
    zoneIds: ALL_ZONES,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown = null) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("a missing token hands back the manual command and makes no request", async () => {
  const { fetcher, calls } = stubFetch(204);
  const result = await dispatchBurst(plan(), {
    fetcher,
    readSecret: async () => undefined,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.mode, "manual");
  if (result.mode !== "manual") throw new Error("unreachable");
  assert.equal(
    result.fallback.command,
    "k6 cloud run --vus 25 --duration 120s scripts/affiliate-click-check.k6.js",
  );
  assert.equal(calls.length, 0, "an unconfigured dispatch must not reach GitHub");
  assert.equal(JSON.stringify(result).includes("k6 cloud run"), true);
});

test("the fallback command is the planned VUs and duration, per plan", () => {
  const big = planBurst({
    clicks: 16_000,
    durationSec: 120,
    zoneIds: ALL_ZONES,
  });
  if (!big.ok) throw new Error(big.reason);

  assert.equal(
    burstCommand(big.plan),
    "k6 cloud run --vus 200 --duration 120s scripts/affiliate-click-check.k6.js",
  );
});

test("a 204 answers with the workflow's run list URL", async () => {
  const { fetcher, calls } = stubFetch(204);
  const result = await dispatchBurst(plan(), {
    fetcher,
    readSecret: async () => TOKEN,
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.mode, "dispatched");
  if (result.mode !== "dispatched") throw new Error("unreachable");
  assert.equal(result.runUrl, BURST_RUN_URL);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/cipherlogs/voni/actions/workflows/burst.yml/dispatches",
  );
  assert.equal(calls[0].init.method, "POST");

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.accept, "application/vnd.github+json");
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["x-github-api-version"], "2022-11-28");
  assert.ok(calls[0].init.signal, "the dispatch must carry a timeout signal");

  const body = JSON.parse(String(calls[0].init.body)) as {
    ref: string;
    inputs: Record<string, string>;
  };
  assert.equal(body.ref, "main");
  assert.equal(body.inputs.vus, "25");
  assert.equal(body.inputs.duration, "120");
  const zones = JSON.parse(body.inputs.zones) as Array<{
    id: string;
    percent: number;
  }>;
  assert.deepEqual(
    zones.map((zone) => [zone.id, zone.percent]),
    ALL_ZONES.map((id) => [id, 25]),
  );
});

test("401, 403 with a body, and 404 are three distinct sentences", async () => {
  const sentences = new Map<number, string>();

  for (const status of [401, 403, 404]) {
    const { fetcher } = stubFetch(status, {
      message:
        status === 403 ? "Resource not accessible by integration" : "Not Found",
    });
    const result = await dispatchBurst(plan(), {
      fetcher,
      readSecret: async () => TOKEN,
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, new RegExp(String(status)));
    sentences.set(status, result.error);
  }

  // The 403 keeps GitHub's own explanation; the others do not claim one.
  assert.match(
    sentences.get(403) ?? "",
    /Resource not accessible by integration/,
  );
  assert.equal(new Set(sentences.values()).size, 3);
});

test("no returned string ever contains the token", async () => {
  const outcomes: Array<() => Promise<BurstDispatchResult>> = [
    async () => {
      const { fetcher } = stubFetch(204);
      return dispatchBurst(plan(), { fetcher, readSecret: async () => TOKEN });
    },
    // The manual path must be token-free too: the command is not a secret.
    async () => {
      const { fetcher } = stubFetch(204);
      return dispatchBurst(plan(), {
        fetcher,
        readSecret: async () => undefined,
      });
    },
    ...[401, 403, 404, 500].map((status) => async () => {
      const { fetcher } = stubFetch(status, { message: "nope" });
      return dispatchBurst(plan(), { fetcher, readSecret: async () => TOKEN });
    }),
    async () => {
      const fetcher = (async () => {
        throw new Error(`connect failed while sending ${TOKEN}`);
      }) as unknown as typeof fetch;
      return dispatchBurst(plan(), { fetcher, readSecret: async () => TOKEN });
    },
  ];

  for (const outcome of outcomes) {
    const result = await outcome();
    const text = JSON.stringify(result);
    assert.equal(text.includes(TOKEN), false, text);
    if (!result.ok) assert.equal(result.error?.includes(TOKEN), false);
  }
});

test("a transport failure is reported without the token, and redacted", async () => {
  const fetcher = (async () => {
    throw new Error(`fetch failed with ${TOKEN}`);
  }) as unknown as typeof fetch;

  const result = await dispatchBurst(plan(), {
    fetcher,
    readSecret: async () => TOKEN,
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.error, /Could not reach GitHub/);
  assert.match(result.error, /\[redacted\]/);
});

test("an empty plan never reaches the API", async () => {
  const { fetcher, calls } = stubFetch(204);
  const result = await dispatchBurst(
    { vus: 0, durationSec: 120, clicks: 0, vuHours: 0, zones: [] },
    { fetcher, readSecret: async () => TOKEN },
  );

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("the dispatch request carries a User-Agent", async () => {
  // GitHub refuses UA-less requests with a 403 whose body looks like a
  // permission error. That is a header bug wearing a credential's clothes.
  let seen: Record<string, string> = {};
  const fetcher = (async (_url: string, init?: RequestInit) => {
    seen = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  await dispatchBurst(plan(), { fetcher, readSecret: async () => "token" });
  assert.equal(seen["user-agent"], "voni-burst");
});

test("a plain-text refusal reaches the operator, not just the status", async () => {
  const fetcher = (async () =>
    new Response("Request forbidden by administrative rules.", {
      status: 403,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;

  const result = await dispatchBurst(plan(), {
    fetcher,
    readSecret: async () => "token",
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /administrative rules/);
});

test("the panel's live target list rides the dispatch, and empty stays empty", async () => {
  const targets = ["https://example.com/a?creative_id=1", "https://example.org/b"];

  const dispatched = stubFetch(204);
  await dispatchBurst(plan(), {
    fetcher: dispatched.fetcher,
    readSecret: async () => TOKEN,
    targets,
  });
  const body = JSON.parse(String(dispatched.calls[0]!.init.body)) as {
    inputs: Record<string, string>;
  };
  assert.deepEqual(JSON.parse(body.inputs.targets), targets);

  // No list means "keep the committed seed": an empty array would generate a
  // script with no targets and spend a run clicking nothing.
  const empty = stubFetch(204);
  await dispatchBurst(plan(), {
    fetcher: empty.fetcher,
    readSecret: async () => TOKEN,
    targets: [],
  });
  const emptyBody = JSON.parse(String(empty.calls[0]!.init.body)) as {
    inputs: Record<string, string>;
  };
  assert.equal(emptyBody.inputs.targets, "");
});

test("the target-selection mode rides the dispatch, defaulting to random", async () => {
  const cases = [
    { selection: undefined, expected: TARGET_SELECTION_DEFAULT },
    { selection: "rotate" as const, expected: "rotate" },
    { selection: "random" as const, expected: "random" },
  ];

  for (const { selection, expected } of cases) {
    const { fetcher, calls } = stubFetch(204);
    await dispatchBurst(plan(), {
      fetcher,
      readSecret: async () => TOKEN,
      ...(selection ? { selection } : {}),
    });

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      inputs: Record<string, string>;
    };
    assert.equal(
      body.inputs.selection,
      expected,
      `selection ${selection ?? "(omitted)"} must be sent as ${expected}`,
    );
  }
});

test("the manual command still names the committed script", () => {
  assert.match(burstCommand(plan()), /affiliate-click-check\.k6\.js$/);
});
