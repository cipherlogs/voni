/**
 * The check script builder: the one place that turns the app's modules into the
 * k6 script Grafana runs.
 *
 * What is proved here, without k6 or Grafana:
 *
 *   - the committed script is exactly what a fresh build produces, so a diff in
 *     `scripts/affiliate-click-check.k6.js` always means a source module moved;
 *   - the click loop appears only above one click, so the committed one-click
 *     script carries no dead scaffolding;
 *   - the bounds are the builder's own refusal, not just the form's;
 *   - the run rules the check depends on (`onlyIPv4`, `report_failed`, a
 *     redirect-free 2 s report) are present;
 *   - the secret is a parameter: `null` emits the placeholder, a string emits
 *     the value, and the emitted text parses as JavaScript either way.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CLICKS_PER_RUN_MAX,
  REPORT_SECRET_PLACEHOLDER,
  buildCheckScript,
  readClicksPerRun,
} from "./check-script";
import { readTargetSelection } from "./target-selection";
import {
  campaignForProvider,
  EMAIL_CAMPAIGN_FALLBACK,
  EMAIL_PROVIDERS,
} from "./pool";

const here = dirname(fileURLToPath(import.meta.url));
const COMMITTED = readFileSync(
  join(here, "../../../scripts/affiliate-click-check.k6.js"),
  "utf8",
);

const SECRET = "0123456789abcdef0123456789abcdef";

/** Parse the emitted text as a program body: a broken literal throws here. */
function assertParses(source: string): void {
  const body = source
    .replace(/^import .*$/gm, "")
    .replace(/^export default /gm, "")
    .replace(/^export /gm, "");
  assert.doesNotThrow(() => new Function(body));
}

const oneClick = buildCheckScript({ clicksPerRun: 1, reportSecret: null });

const RUN_HEADER = "export default function affiliateClickCheck() {\n";
const LOOP_HEADER = "  for (let i = 0; i < CLICKS_PER_RUN; i++) {\n";

/** The run function's body, as emitted (the file always ends with `}\n`). */
function runBody(script: string): string {
  const start = script.indexOf(RUN_HEADER);
  assert.ok(start >= 0, "the run function is emitted");
  return script.slice(start + RUN_HEADER.length, script.length - "}\n".length);
}

function outdent(body: string): string {
  return body
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
}

test("the committed script is a fresh one-click generation, byte for byte", () => {
  assert.equal(oneClick, COMMITTED);
  // Determinism: the same input is the same output, which is what makes a diff
  // after `npm run affiliate:check` mean a source module changed.
  assert.equal(
    buildCheckScript({ clicksPerRun: 1, reportSecret: null }),
    oneClick,
  );
});

test("one click emits no loop and no unused count", () => {
  assert.doesNotMatch(oneClick, /CLICKS_PER_RUN/);
  assert.doesNotMatch(oneClick, /for \(let i = 0; i < CLICKS_PER_RUN/);
});

test("the emitted campaign map is the app's, one campaign per provider", () => {
  assert.doesNotMatch(oneClick, /voni-email/, "the fixed campaign is gone");
  assert.match(oneClick, /const CAMPAIGNS = \{/);
  for (const provider of EMAIL_PROVIDERS) {
    assert.ok(
      oneClick.includes(
        `  ${JSON.stringify(provider)}: ${JSON.stringify(campaignForProvider(provider))},`,
      ),
      `${provider} carries its own campaign`,
    );
  }
  assert.ok(
    oneClick.includes(
      `const CAMPAIGN_FALLBACK = ${JSON.stringify(EMAIL_CAMPAIGN_FALLBACK)};`,
    ),
  );
  assert.match(
    oneClick,
    /query = setParam\(query, "utm_campaign", campaignFor\(source\)\);/,
    "a runtime source pick sets the matching campaign",
  );
});

test("the emitted lookup answers exactly what campaignForProvider answers", () => {
  // The script is plain JavaScript the test can run: whatever a source resolves
  // to here must be what the app stamps, unknown sources included.
  const start = oneClick.indexOf("const CAMPAIGNS = {");
  assert.notEqual(start, -1, "the campaign map is emitted");
  const lookupAt = oneClick.indexOf("function campaignFor(source)");
  assert.notEqual(lookupAt, -1, "the campaign lookup is emitted");
  const end = oneClick.indexOf("\n}", lookupAt) + 2;
  const source = `${oneClick.slice(start, end)}\nreturn campaignFor;`;
  const lookup = new Function(source)() as (provider: string) => string;

  for (const provider of [...EMAIL_PROVIDERS, "example.com", "unknown.example"]) {
    assert.equal(lookup(provider), campaignForProvider(provider), provider);
  }
});

test("more than one click wraps the click in the counted loop", () => {
  const three = buildCheckScript({ clicksPerRun: 3, reportSecret: null });
  assert.match(three, /const CLICKS_PER_RUN = 3;/);

  const body = runBody(three);
  assert.ok(
    body.startsWith(LOOP_HEADER),
    "the loop is the run function's only top-level statement",
  );
  const inner = body.slice(LOOP_HEADER.length, body.length - "  }\n".length);

  // One draw per iteration, not one draw reused: the whole one-click body is
  // inside the loop, indented, and nothing about it changed on the way in.
  assert.equal(outdent(inner), runBody(oneClick));
  assert.equal((three.match(/const profile = pickProfile\(\);/g) ?? []).length, 1);
});

test("the builder refuses a click count outside 1..10, including fractions", () => {
  for (const bad of [0, -1, 11, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildCheckScript({ clicksPerRun: bad, reportSecret: null }),
      /clicksPerRun must be an integer from 1 to 10/,
      `${String(bad)} must be refused`,
    );
  }
  assert.equal(CLICKS_PER_RUN_MAX, 10);
  assert.doesNotThrow(() =>
    buildCheckScript({ clicksPerRun: 10, reportSecret: null }),
  );
});

test("the run rules a green check depends on are in the emitted options", () => {
  assert.match(oneClick, /dns: \{ policy: "onlyIPv4" \}/);
  assert.match(oneClick, /thresholds: \{ report_failed: \["count==0"\] \}/);
  // The report must not follow a redirect and must give up quickly.
  assert.match(oneClick, /redirects: 0/);
  assert.match(oneClick, /timeout: "2s"/);
  assert.match(oneClick, /"x-voni-click-secret": REPORT_SECRET/);
});

test("the secret is a parameter, never a constant in the file", () => {
  assert.equal(oneClick.includes(`"${REPORT_SECRET_PLACEHOLDER}"`), true);
  assert.equal(oneClick.includes(SECRET), false);

  const injected = buildCheckScript({ clicksPerRun: 2, reportSecret: SECRET });
  assert.equal(
    injected.includes(`const REPORT_SECRET = ${JSON.stringify(SECRET)};`),
    true,
  );
  assert.equal(injected.split(SECRET).length - 1, 1);
  // The enable check still compares against the placeholder: that comparison is
  // what turns reporting on once the real value is in the declaration.
  assert.equal(
    injected.includes(
      `REPORT_SECRET !== ${JSON.stringify(REPORT_SECRET_PLACEHOLDER)}`,
    ),
    true,
  );
});

test("a secret that cannot survive the string literal is refused", () => {
  for (const bad of ['abc"defg', "abc\\defg", "short", ""]) {
    assert.throws(
      () => buildCheckScript({ clicksPerRun: 1, reportSecret: bad }),
      /reportSecret must be at least 8 characters/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("both variants parse as JavaScript", () => {
  assertParses(oneClick);
  assertParses(buildCheckScript({ clicksPerRun: 10, reportSecret: SECRET }));
});

test("readClicksPerRun reads the stored constant back, one when absent", () => {
  assert.equal(readClicksPerRun(oneClick), 1);
  assert.equal(
    readClicksPerRun(buildCheckScript({ clicksPerRun: 4, reportSecret: null })),
    4,
  );
  // A script from before the loop existed is one click, and an out-of-range
  // constant is not allowed to become the panel's starting value.
  assert.equal(readClicksPerRun("export default function x() {}"), 1);
  assert.equal(readClicksPerRun("const CLICKS_PER_RUN = 99;"), 1);
});

test("selection: a new script draws at random and says so", () => {
  const random = buildCheckScript({ clicksPerRun: 1, reportSecret: null });
  assert.equal(readTargetSelection(random), "random");
  assert.match(random, /const TARGET_SELECTION = "random";/);
  assert.match(
    random,
    /function nextTarget\(\) \{\n  return TARGETS\[Math\.floor\(Math\.random\(\) \* TARGETS\.length\)\];\n\}/,
    "random mode draws one entry with replacement per click",
  );
  assert.doesNotMatch(random, /const nextTarget = shuffleBag\(TARGETS\)/);
});

test("selection: rotate keeps the shuffle bag and the marker agrees", () => {
  const rotate = buildCheckScript({
    clicksPerRun: 1,
    reportSecret: null,
    selection: "rotate",
  });
  assert.equal(readTargetSelection(rotate), "rotate");
  assert.match(rotate, /const TARGET_SELECTION = "rotate";/);
  assert.match(rotate, /const nextTarget = shuffleBag\(TARGETS\);/);
  assert.doesNotMatch(rotate, /function nextTarget/);
  // The marker is the annotation the panel reads; the definition is the
  // behaviour. Both come from one input, and both variants must still parse.
  assertParses(rotate);
});

test("the target list is a parameter, so the panel's list is what the check clicks", () => {
  const targets = [
    "https://example.com/a?creative_id=1",
    "https://example.org/b",
  ];
  const script = buildCheckScript({
    clicksPerRun: 1,
    reportSecret: null,
    targets,
  });

  assert.match(script, /const TARGETS = \[/);
  for (const target of targets) {
    assert.ok(
      script.includes(JSON.stringify(target)),
      `${target} must be embedded`,
    );
  }
  assert.doesNotMatch(script, /glizzitrium/, "the seed must not leak through");
  assertParses(script);
});

test("no target, or a target the panel would refuse, is a builder refusal", () => {
  assert.throws(
    () => buildCheckScript({ clicksPerRun: 1, reportSecret: null, targets: [] }),
    /at least one URL/,
    "an empty list would upload a check that clicks nothing",
  );
  for (const bad of ["http://example.com/", "https://127.0.0.1/", "not a url"]) {
    assert.throws(
      () =>
        buildCheckScript({ clicksPerRun: 1, reportSecret: null, targets: [bad] }),
      /Invalid email target/,
      `${bad} must be refused`,
    );
  }
});
