/**
 * What the click table says about the exit a click used.
 *
 * Attribution is only honest if every row can answer: a pooled click names the
 * address, country and ASN the exit reported; a manual override says so; a row
 * written before the pool existed says "No proxy" instead of inventing one or
 * printing `undefined`. Ticket 07 stores the columns; this module is the one
 * place that turns them into words, so the table cannot grow a second rule.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { describeClickExit } from "./click-exit";

const here = dirname(fileURLToPath(import.meta.url));
const panelSource = readFileSync(
  join(here, "../../components/affiliate-control-panel.tsx"),
  "utf8",
);
const pageSource = readFileSync(join(here, "../../app/email/page.tsx"), "utf8");

test("a pooled click names its exit address, country and ASN", () => {
  assert.equal(
    describeClickExit({
      proxyKind: "pool",
      exitIp: "198.51.100.10",
      exitCountry: "US",
      exitAsn: "7018",
    }),
    "198.51.100.10 · US · AS7018",
  );
});

test("a row with no exit reads as no proxy, never as undefined", () => {
  for (const row of [
    {},
    { proxyKind: null },
    { proxyKind: "none" },
    { proxyKind: undefined, exitIp: null },
  ]) {
    assert.equal(describeClickExit(row), "No proxy");
  }
  assert.doesNotMatch(describeClickExit({}), /undefined|null/);
});

test("a manual override is named as one, not as a pool exit", () => {
  assert.equal(describeClickExit({ proxyKind: "manual" }), "Manual proxy");
  assert.equal(
    describeClickExit({ proxyKind: "manual", exitIp: "198.51.100.10" }),
    "Manual proxy",
    "a manual address is not an exit the pool issued",
  );
});

test("half an attribution is still honest", () => {
  assert.equal(
    describeClickExit({ proxyKind: "pool", exitIp: "198.51.100.10" }),
    "198.51.100.10 · US",
    "the country is US by construction, so a missing country is not unknown",
  );
  assert.equal(
    describeClickExit({ proxyKind: "pool" }),
    "Pool exit (address not recorded)",
  );
});

test("a click that failed before a browser opened names why", () => {
  assert.equal(
    describeClickExit({ proxyKind: "none", failureReason: "no-us-exit" }),
    "No proxy · no US exit",
  );
  assert.equal(
    describeClickExit({ failureReason: "quota-spent" }),
    "No proxy · quota spent",
  );
});

test("the clicks table shows the exit and reads the shared helper", () => {
  assert.match(panelSource, /describeClickExit/, "the table calls the one rule");
  assert.match(
    panelSource,
    /<th className="py-2 pr-3 font-medium">Exit<\/th>/,
    "the table has an Exit column",
  );
  assert.match(
    pageSource,
    /exitIp: row\.exitIp \?\? null/,
    "the page forwards the stored exit rather than dropping it",
  );
});
