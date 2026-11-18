/**
 * The burst-only `options` transform, proved on the committed script: unset env
 * leaves it byte-identical (it has no distribution), and a well-formed env adds
 * VUs, a duration and the k6 Cloud load-zone distribution the workflow asks for.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyBurstOptions,
  burstK6OptionsFromEnv,
  renderBurstOptions,
} from "./k6-options";

const here = dirname(fileURLToPath(import.meta.url));
const COMMITTED = readFileSync(
  join(here, "../../../scripts/affiliate-click-check.k6.js"),
  "utf8",
);

const ZONES_JSON = JSON.stringify([
  { id: "amazon:us:ashburn", label: "Ashburn", percent: 50 },
  { id: "amazon:us:portland", label: "Portland", percent: 50 },
]);

/** Parse the emitted text as a program body: a broken literal throws here. */
function assertParses(source: string): void {
  const body = source
    .replace(/^import .*$/gm, "")
    .replace(/^export default /gm, "")
    .replace(/^export /gm, "");
  assert.doesNotThrow(() => new Function(body));
}

test("no burst env leaves the committed script alone", () => {
  assert.equal(burstK6OptionsFromEnv({}), null);
  assert.equal(
    burstK6OptionsFromEnv({
      BURST_VUS: "",
      BURST_DURATION: " ",
      K6_LOAD_ZONES: undefined,
    }),
    null,
  );
  // The committed script is the SM check: it must carry no distribution.
  assert.equal(COMMITTED.includes("loadimpact"), false);
});

test("a partial burst env is a broken invocation, not a default", () => {
  assert.throws(
    () => burstK6OptionsFromEnv({ BURST_VUS: "200" }),
    /needs all of BURST_VUS, BURST_DURATION, K6_LOAD_ZONES/,
  );
});

test("the distribution is validated against the confirmed US zones", () => {
  const base = {
    BURST_VUS: "200",
    BURST_DURATION: "120",
  };

  assert.throws(
    () =>
      burstK6OptionsFromEnv({
        ...base,
        K6_LOAD_ZONES: JSON.stringify([
          { id: "amazon:eu:frankfurt", percent: 100 },
        ]),
      }),
    /amazon:us:ashburn/,
  );

  assert.throws(
    () =>
      burstK6OptionsFromEnv({
        ...base,
        K6_LOAD_ZONES: JSON.stringify([
          { id: "amazon:us:ashburn", percent: 60 },
          { id: "amazon:us:portland", percent: 30 },
        ]),
      }),
    /sum to 100/,
  );

  assert.throws(
    () =>
      burstK6OptionsFromEnv({ ...base, K6_LOAD_ZONES: "not json" }),
    /not valid JSON/,
  );
});

test("a full env produces options.vus, options.duration and the distribution", () => {
  const options = burstK6OptionsFromEnv({
    BURST_VUS: "200",
    BURST_DURATION: "120",
    K6_LOAD_ZONES: ZONES_JSON,
  });

  assert.deepEqual(options, {
    vus: 200,
    durationSec: 120,
    zones: [
      { id: "amazon:us:ashburn", percent: 50 },
      { id: "amazon:us:portland", percent: 50 },
    ],
  });

  const block = renderBurstOptions(options!);
  assert.match(block, /vus: 200,/);
  assert.match(block, /duration: "120s",/);
  assert.match(block, /loadimpact/);
  assert.match(block, /"loadZone": "amazon:us:ashburn"/);
  assert.match(block, /"percent": 50/);
  // The SM check's own rules survive the transform.
  assert.match(block, /dns: \{ policy: "onlyIPv4" \}/);
  assert.match(block, /thresholds: \{ report_failed: \["count==0"\] \}/);
});

test("applying the transform keeps the click program parseable", () => {
  const options = burstK6OptionsFromEnv({
    BURST_VUS: "200",
    BURST_DURATION: "120",
    K6_LOAD_ZONES: ZONES_JSON,
  });
  const burst = applyBurstOptions(COMMITTED, options!);

  assert.match(burst, /distribution:/);
  assert.match(burst, /"amazon:us:portland"/);
  assertParses(burst);
  // Everything below the options block is the same click script.
  assert.equal(burst.includes("function affiliateClickCheck"), true);
  assert.equal(burst.includes("withUtm"), true);

  // Deterministic: the same env produces the same bytes.
  assert.equal(applyBurstOptions(COMMITTED, options!), burst);
});

test("an unrecognised options block fails loudly instead of writing a default run", () => {
  assert.throws(
    () =>
      applyBurstOptions("export default function x() {}", {
        vus: 1,
        durationSec: 30,
        zones: [{ id: "amazon:us:ashburn", percent: 100 }],
      }),
    /no recognisable `export const options` block/,
  );
});
