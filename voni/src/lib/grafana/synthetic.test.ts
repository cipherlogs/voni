/**
 * The Grafana Synthetic Monitoring client's contract, proved without a socket:
 * the update merge keeps everything the panel must not own, the read paths
 * speak the API's real quirks, and each failure reason is distinguishable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  frequencyBounds,
  getCheck,
  listProbes,
  mergeCheckUpdate,
  normalizeBaseUrl,
  updateCheck,
  type SyntheticCheckBody,
} from "./synthetic";

const BASE_URL = "https://synthetic-monitoring-api-us-west-0.grafana.net/api/v1";
const TOKEN = "grafana-test-token";

// Deliberately carries `created`/`updated`, which this module does not model:
// the merge must keep unknown fields too, because Grafana round-trips them.
const CHECK_BODY: SyntheticCheckBody = {
  id: 7,
  tenantId: 1234,
  job: "email-target",
  target: "https://voni.cc/test?utm_source=gmail.com",
  enabled: true,
  frequency: 120_000,
  timeout: 10_000,
  probes: [1, 2],
  labels: { source: "email", env: "prod" },
  settings: { scripted: { script: "cmV0dXJuIHRydWU7" } },
  modified: 1_760_000_000,
  created: 1_700_000_000,
  updated: 1_760_000_000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withGrafanaEnv(): () => void {
  const saved = {
    url: process.env.GRAFANA_SM_URL,
    token: process.env.GRAFANA_SM_TOKEN,
  };
  // The trailing slash is on purpose: the client must strip it, not build
  // `//check/7`.
  process.env.GRAFANA_SM_URL = `${BASE_URL}/`;
  process.env.GRAFANA_SM_TOKEN = TOKEN;
  return () => {
    for (const [name, value] of [
      ["GRAFANA_SM_URL", saved.url],
      ["GRAFANA_SM_TOKEN", saved.token],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

const quietFetch = (async () => {
  throw new Error("a not-configured client must not reach the network");
}) as typeof globalThis.fetch;

test("merge: the patch lands, everything else is preserved verbatim", () => {
  const next = mergeCheckUpdate(CHECK_BODY, {
    enabled: false,
    frequencyMs: 300_000,
    probeIds: [3, 4],
  });

  assert.equal(next.enabled, false);
  assert.equal(next.frequency, 300_000);
  assert.deepEqual(next.probes, [3, 4]);

  assert.notEqual(next, CHECK_BODY, "a new body, never a mutation of the read one");
  assert.equal(CHECK_BODY.enabled, true, "the current body is untouched");
  assert.equal(next.id, 7);
  assert.equal(next.tenantId, 1234);
  assert.equal(next.job, "email-target");
  assert.equal(next.target, CHECK_BODY.target);
  assert.deepEqual(next.labels, CHECK_BODY.labels);
  assert.deepEqual(next.settings, CHECK_BODY.settings);
  assert.equal(next.timeout, 10_000);
  assert.equal(next.modified, 1_760_000_000);
  assert.equal(next.created, 1_700_000_000, "fields this module does not model survive");
  assert.deepEqual(CHECK_BODY.probes, [1, 2], "the probe array is copied, not shared");
});

test("merge: an absent key in the patch leaves its field alone", () => {
  const next = mergeCheckUpdate(CHECK_BODY, { enabled: false });
  assert.equal(next.enabled, false);
  assert.equal(next.frequency, 120_000);
  assert.deepEqual(next.probes, [1, 2]);
});

test("merge: scripted checks cannot go below the 60s floor or above the cap", () => {
  assert.equal(frequencyBounds.minMs, 60_000);
  assert.equal(frequencyBounds.maxMs, 3_600_000);
  assert.equal(
    mergeCheckUpdate(CHECK_BODY, { frequencyMs: 15_000 }).frequency,
    frequencyBounds.minMs,
  );
  assert.equal(
    mergeCheckUpdate(CHECK_BODY, { frequencyMs: 86_400_000 }).frequency,
    frequencyBounds.maxMs,
  );
});

test("updateCheck: posts the whole body back and returns the re-read state", async () => {
  const restore = withGrafanaEnv();
  try {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let state: SyntheticCheckBody = { ...CHECK_BODY };
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === "POST") {
        // Grafana stores exactly what was posted; the fake does the same so the
        // final GET reflects the write rather than the fixture.
        state = JSON.parse(String(init.body)) as SyntheticCheckBody;
        return jsonResponse(state);
      }
      return jsonResponse(state);
    }) as typeof globalThis.fetch;

    const result = await updateCheck(7, { enabled: false, probeIds: [3] }, fetcher);
    assert.ok(result.ok);
    assert.equal(result.data.enabled, false);
    assert.deepEqual(result.data.probeIds, [3]);
    assert.equal(result.data.job, "email-target");
    assert.equal(result.data.target, CHECK_BODY.target);
    assert.equal(result.data.frequencyMs, 120_000);

    assert.equal(calls.length, 3, "read, write, re-read");
    assert.equal(calls[0].url, `${BASE_URL}/check/7`, "no doubled slash");
    assert.equal(calls[1].url, `${BASE_URL}/check/7`);
    assert.equal(calls[1].init?.method, "POST", "PUT/PATCH 404 on this API");
    assert.equal(calls[2].url, `${BASE_URL}/check/7`);

    const posted = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
    assert.equal(posted.id, 7, "the id rides in the body, not only the path");
    assert.equal(posted.tenantId, 1234);
    assert.equal(posted.job, "email-target");
    assert.equal(posted.target, CHECK_BODY.target);
    assert.deepEqual(posted.labels, CHECK_BODY.labels);
    assert.deepEqual(posted.settings, CHECK_BODY.settings);
    assert.equal(posted.frequency, 120_000, "the unpatched frequency is sent as it was");
    assert.equal(posted.timeout, 10_000);
    assert.equal(posted.created, 1_700_000_000);
    assert.equal(posted.enabled, false);
    assert.deepEqual(posted.probes, [3]);

    assert.equal(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      `Bearer ${TOKEN}`,
    );
    assert.equal(calls[0].init?.cache, "no-store");
    assert.ok(
      calls[0].init?.signal instanceof AbortSignal,
      "a 10s timeout is always attached",
    );
  } finally {
    restore();
  }
});

test("getCheck: missing secrets are not_configured and never touch the network", async () => {
  const savedUrl = process.env.GRAFANA_SM_URL;
  const savedToken = process.env.GRAFANA_SM_TOKEN;
  delete process.env.GRAFANA_SM_URL;
  delete process.env.GRAFANA_SM_TOKEN;
  try {
    const result = await getCheck(7, quietFetch);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "not_configured");
    assert.match(result.message, /GRAFANA_SM_URL/);
    assert.match(result.message, /GRAFANA_SM_TOKEN/);
    assert.equal(result.status, undefined);
  } finally {
    if (savedUrl !== undefined) process.env.GRAFANA_SM_URL = savedUrl;
    if (savedToken !== undefined) process.env.GRAFANA_SM_TOKEN = savedToken;
  }
});

test("getCheck: a 401 is unauthorized, with the status and no token in the message", async () => {
  const restore = withGrafanaEnv();
  try {
    const urls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({ message: "invalid token" }, 401);
    }) as typeof globalThis.fetch;

    const result = await getCheck(7, fetcher);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "unauthorized");
    assert.equal(result.status, 401);
    assert.doesNotMatch(result.message, new RegExp(TOKEN));
    assert.equal(urls[0], `${BASE_URL}/check/7`);
  } finally {
    restore();
  }
});

test("getCheck: a 500 is http_error, not unauthorized, and keeps its status", async () => {
  const restore = withGrafanaEnv();
  try {
    const fetcher = (async () => jsonResponse({}, 500)) as typeof globalThis.fetch;
    const result = await getCheck(7, fetcher);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "http_error");
    assert.equal(result.status, 500);
    assert.match(result.message, /HTTP 500/);
  } finally {
    restore();
  }
});

test("base url: a scheme-less value gets https:// and any trailing slash is stripped", () => {
  assert.equal(
    normalizeBaseUrl("synthetic-monitoring-api-us-west-0.grafana.net/api/v1"),
    BASE_URL,
  );
  assert.equal(normalizeBaseUrl(`${BASE_URL}/`), BASE_URL);
  assert.equal(normalizeBaseUrl(`  ${BASE_URL}//  `), BASE_URL);
  assert.equal(normalizeBaseUrl(BASE_URL), BASE_URL, "an already-normal url is unchanged");
});

test("base url: empty and hostless values are null, never a broken fetch", () => {
  for (const bad of [undefined, "", "   ", "not-a-host", "localhost:3000"]) {
    assert.equal(normalizeBaseUrl(bad), null, `${JSON.stringify(bad)} cannot be fetched`);
  }
});

test("getCheck: a thrown fetch is network_error naming GRAFANA_SM_URL and no token", async () => {
  const restore = withGrafanaEnv();
  try {
    const fetcher = (async () => {
      throw new TypeError("Failed to parse URL from /check/7");
    }) as typeof globalThis.fetch;

    const result = await getCheck(7, fetcher);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "network_error");
    assert.match(result.message, /GRAFANA_SM_URL/);
    assert.match(result.message, /Failed to parse URL/);
    assert.doesNotMatch(result.message, new RegExp(TOKEN));
  } finally {
    restore();
  }
});

test("getCheck: a malformed GRAFANA_SM_URL is not_configured before any fetch", async () => {
  const savedUrl = process.env.GRAFANA_SM_URL;
  const savedToken = process.env.GRAFANA_SM_TOKEN;
  process.env.GRAFANA_SM_URL = "not-a-host";
  process.env.GRAFANA_SM_TOKEN = TOKEN;
  try {
    const result = await getCheck(7, quietFetch);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "not_configured");
    assert.match(result.message, /GRAFANA_SM_URL is not set or malformed/);
    assert.doesNotMatch(result.message, new RegExp(TOKEN));
  } finally {
    if (savedUrl === undefined) delete process.env.GRAFANA_SM_URL;
    else process.env.GRAFANA_SM_URL = savedUrl;
    if (savedToken === undefined) delete process.env.GRAFANA_SM_TOKEN;
    else process.env.GRAFANA_SM_TOKEN = savedToken;
  }
});

test("listProbes: reads the singular /probe path and flattens the probe fields", async () => {
  const restore = withGrafanaEnv();
  try {
    const urls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse([
        {
          id: 1,
          name: "Ashburn",
          region: "us-east",
          public: true,
          latitude: 39.04,
          longitude: -77.48,
        },
        { id: 2, name: "Frankfurt", region: "eu-west" },
      ]);
    }) as typeof globalThis.fetch;

    const result = await listProbes(fetcher);
    assert.ok(result.ok);
    assert.deepEqual(urls, [`${BASE_URL}/probe`], "/probes is a 404 on this API");
    assert.deepEqual(result.data[0], {
      id: 1,
      name: "Ashburn",
      region: "us-east",
      public: true,
      latitude: 39.04,
      longitude: -77.48,
    });
    assert.deepEqual(result.data[1], {
      id: 2,
      name: "Frankfurt",
      region: "eu-west",
      public: false,
      latitude: null,
      longitude: null,
    });
  } finally {
    restore();
  }
});
