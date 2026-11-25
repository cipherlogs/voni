/**
 * The proxy card's rules, proved where they can be broken.
 *
 * Two things on `/email` are constraints rather than preferences: the country is
 * US and nothing else, and the pool target is a whole number from three to eight.
 * Both are refused server-side, so this file proves the parsers reject what the
 * form would never send, and then reads the action's own body to prove the
 * refusal happens before a write and before the input is trusted.
 *
 * The pool target has to mean something after it is saved, so the last test
 * carries a saved value into the real pool and reads its target back: the
 * number the operator chose is the number the client fills to.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { POOL_MAX, POOL_TARGET, createExitPool } from "@/lib/tuxler/pool";
import {
  PROXY_COUNTRY,
  PROXY_POOL_MAX,
  PROXY_POOL_MIN,
  PROXY_POOL_TARGET_DEFAULT,
  PROXY_PROVIDER,
  describeProxyHealth,
  failureWords,
  parseProxyCountry,
  parseProxyPoolTarget,
  resolveProxySettings,
  type ProxyExitView,
  type ProxyHealthData,
  type ProxyHealthRead,
} from "./proxy-policy";

const here = dirname(fileURLToPath(import.meta.url));
const actionsSource = readFileSync(
  join(here, "../../app/email/actions.ts"),
  "utf8",
);
const settingsSource = readFileSync(join(here, "proxy-settings.ts"), "utf8");
const schemaSource = readFileSync(join(here, "../db/schema.ts"), "utf8");

/** One exported action's body, from its declaration to the next `export`. */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is exported`);
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

test("US is the only country the card accepts; every other value is refused", () => {
  assert.equal(PROXY_COUNTRY, "US");
  assert.equal(PROXY_PROVIDER, "tuxler");
  assert.equal(parseProxyCountry("US"), "US");
  assert.equal(parseProxyCountry("us"), "US", "case is not a different country");
  assert.equal(parseProxyCountry(" US "), "US", "whitespace is not a different country");

  for (const refused of ["GB", "CA", "USA", "U", "", "  ", null, undefined, 1, ["US"]]) {
    assert.equal(
      parseProxyCountry(refused),
      null,
      `${JSON.stringify(refused)} must be refused, not mapped to a country`,
    );
  }
});

test("the pool target is a whole number from three to eight", () => {
  assert.equal(PROXY_POOL_MIN, 3);
  assert.equal(PROXY_POOL_MAX, 8);
  assert.equal(PROXY_POOL_TARGET_DEFAULT, 5);

  for (const accepted of [3, 5, 8, "3", "8", " 5 "]) {
    const parsed = parseProxyPoolTarget(accepted);
    assert.equal(typeof parsed, "number", `${JSON.stringify(accepted)} is accepted`);
    assert.ok(parsed! >= 3 && parsed! <= 8);
  }

  for (const refused of [2, 9, 0, -1, 3.5, 8.5, "2", "9", "", "five", null, undefined, NaN, Infinity, [5]]) {
    assert.equal(
      parseProxyPoolTarget(refused),
      null,
      `${JSON.stringify(refused)} is outside 3–8 and must be refused`,
    );
  }
});

test("a stored row can never pass a non-US country down, and a bad target reads as the default", () => {
  assert.deepEqual(
    resolveProxySettings({ proxyCountry: "GB", proxyPoolTarget: 7 }),
    { country: "US", poolTarget: 7 },
    "the country is a constraint, not a stored choice: a hand-edited row still reads US",
  );
  assert.deepEqual(resolveProxySettings(null), {
    country: "US",
    poolTarget: PROXY_POOL_TARGET_DEFAULT,
  });
  assert.equal(
    resolveProxySettings({ proxyCountry: "US", proxyPoolTarget: 11 }).poolTarget,
    PROXY_POOL_TARGET_DEFAULT,
    "an out-of-range stored value is not a pool size",
  );
});

test("the card's bounds are the client's own, not a second copy that can drift", () => {
  assert.equal(PROXY_POOL_TARGET_DEFAULT, POOL_TARGET);
  assert.equal(PROXY_POOL_MAX, POOL_MAX);
});

test("a saved pool target is the target the pool fills to", () => {
  const saved = resolveProxySettings({ proxyCountry: "US", proxyPoolTarget: 8 });
  const session = {
    snapshot: () => ({
      state: "connected" as const,
      account: { resetAt: null, changesUsed: null },
    }),
    requestChange: async () => {
      throw new Error("the pool target test never spends a change");
    },
  };
  // The pool is the only thing that fills exits; constructing it with the saved
  // value is what "the pool converges to it" means on the client side.
  const pool = createExitPool({
    session: session as never,
    relayHost: "server1.ipsharkk.com",
    target: saved.poolTarget,
  });
  assert.equal(pool.snapshot().target, 8);

  const smaller = createExitPool({
    session: session as never,
    relayHost: "server1.ipsharkk.com",
    target: resolveProxySettings({ proxyPoolTarget: 3 }).poolTarget,
  });
  assert.equal(smaller.snapshot().target, 3);
});

test("the action gates first, refuses a non-US country and a bad target before writing", () => {
  const save = fnBody(actionsSource, "saveProxy");

  assert.match(
    save,
    /if \(!\(await requirePageUnlock\(\)\)\) return locked\(\);/,
    "the page password is the only authorization on the card",
  );
  assert.ok(
    save.indexOf("requirePageUnlock()") < save.indexOf("formData.get("),
    "the gate runs before the form is read",
  );
  assert.ok(
    save.indexOf("parseProxyCountry(") < save.indexOf("parseProxyPoolTarget("),
    "the country is settled before the pool target",
  );
  assert.ok(
    save.indexOf("parseProxyCountry(") < save.indexOf("writeProxySettings("),
    "a refused country is refused before anything is written",
  );
  assert.ok(
    save.indexOf("parseProxyPoolTarget(") < save.indexOf("writeProxySettings("),
    "a refused target is refused before anything is written",
  );
  assert.match(
    save,
    /if \(country === null\) \{[\s\S]*?return \{[\s\S]*?\};/,
    "a refused country returns a message and stops",
  );
  assert.match(
    save,
    /if \(poolTarget === null\) \{[\s\S]*?return \{[\s\S]*?\};/,
    "a refused target returns a message and stops",
  );
  assert.match(save, /must be US/i, "the refusal says what the country must be");
  assert.match(save, /3 to 8/, "the refusal says the accepted range");
  assert.match(save, /writeProxySettings\(\{ country, poolTarget \}\)|\{ country, poolTarget \}/);
  assert.match(save, /revalidatePath\("\/email"\)/, "a save refreshes the card and the pool read");
});

test("the settings live on the one console row, and the write never trusts a submitted country", () => {
  const table = schemaSource.slice(
    schemaSource.indexOf('emailSettings = pgTable("email_settings"'),
  );
  const columns = table.slice(0, table.indexOf("});"));
  assert.match(columns, /proxyCountry: text\("proxy_country"\)/);
  assert.match(columns, /proxyPoolTarget: integer\("proxy_pool_target"\)/);

  assert.match(
    settingsSource,
    /export async function readProxySettings/,
    "one reader for the card and every future client start",
  );
  assert.match(
    settingsSource,
    /export async function writeProxySettings/,
    "one writer, so the two columns cannot be updated by different rules",
  );
  assert.match(
    settingsSource,
    /proxyCountry: PROXY_COUNTRY/,
    "the stored country is the constant, never `settings.country`",
  );
  assert.doesNotMatch(
    settingsSource,
    /proxyCountry: settings\.country/,
    "a submitted country is never written through",
  );
  assert.match(settingsSource, /\.onConflictDoUpdate\(/, "a first save creates the row");
});

function exit(ip: string, city: string): ProxyExitView {
  return { ip, country: "US", asn: "7018", city, state: null };
}

function report(
  overrides: Partial<ProxyHealthData> = {},
): Extract<ProxyHealthRead, { state: "reported" }> {
  return {
    state: "reported",
    health: {
      ok: true,
      ready: true,
      pool: [
        exit("198.51.100.10", "Austin"),
        exit("198.51.100.11", "Dallas"),
        exit("198.51.100.12", "Denver"),
        exit("198.51.100.13", "Boston"),
        exit("198.51.100.14", "Seattle"),
      ],
      buckets: [
        {
          clientIpHash: "abc",
          depth: 0,
          used: 2,
          limit: 10,
          remaining: 8,
          resetAt: "2026-11-26T00:00:00.000Z",
        },
      ],
      reconnects: 0,
      lastError: null,
      account: null,
      session: { state: "connected" },
      ...overrides,
    },
  };
}

test("the card tells client-down, short-of-exits and out-of-quota apart", () => {
  const down = describeProxyHealth({ state: "unconfigured" }, 5);
  assert.equal(down.status, "client-down");
  assert.match(down.headline, /client/i);

  const unreachable = describeProxyHealth(
    { state: "unreachable", message: "The client did not answer." },
    5,
  );
  assert.equal(unreachable.status, "client-down");
  assert.match(unreachable.detail, /falling back/i, "a down client says clicks will not fall back");

  const failed = describeProxyHealth(
    report({
      ok: false,
      ready: false,
      session: { state: "failed" as const },
      lastError: { reason: "login-rejected", message: "the relay refused the login" },
    }),
    5,
  );
  assert.equal(failed.status, "client-down");
  assert.match(failed.detail, /refused the login/);

  const short = describeProxyHealth(
    report({ ready: false, pool: [exit("198.51.100.10", "Austin")] }),
    5,
  );
  assert.equal(short.status, "short-of-exits");
  assert.match(short.headline, /short of exits/i);

  const empty = describeProxyHealth(report({ ready: false, pool: [] }), 5);
  assert.equal(empty.status, "short-of-exits");

  const quota = describeProxyHealth(
    report({
      ready: false,
      pool: [],
      buckets: [
        { clientIpHash: "a", depth: 0, used: 10, limit: 10, remaining: 0, resetAt: null },
        { clientIpHash: "b", depth: 1, used: 10, limit: 10, remaining: 0, resetAt: null },
      ],
      lastError: { reason: "quota-spent", message: "the change bucket has nothing left" },
    }),
    5,
  );
  assert.equal(quota.status, "out-of-quota");
  assert.match(quota.headline, /quota/i);
});

test("a live pool at its target is ok; a pool below it is short, not down", () => {
  const full = describeProxyHealth(report(), 5);
  assert.equal(full.status, "ok");
  assert.match(full.headline, /5 of 5/);

  const two = describeProxyHealth(
    report({
      pool: [
        exit("198.51.100.10", "Austin"),
        exit("198.51.100.11", "Dallas"),
      ],
    }),
    4,
  );
  assert.equal(two.status, "short-of-exits");
  assert.match(two.headline, /2 of 4/);
});

test("failures are named in operator words, never as a reason code", () => {
  assert.equal(failureWords("no-us-exit"), "no US exit");
  assert.equal(failureWords("quota-spent"), "quota spent");
  assert.equal(failureWords("relay-silent"), "relay silent");
  assert.equal(failureWords("not-ready"), "the pool is not ready");

  const unknown = failureWords("some-new-code");
  assert.doesNotMatch(unknown, /some-new-code/, "an unknown reason is not printed as a code");
  assert.match(unknown, /failure/i);
});
