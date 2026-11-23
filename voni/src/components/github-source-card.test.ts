/**
 * Source guards for the read-only GitHub source card.
 *
 * The card deliberately has no runtime behaviour to test in this repo (it is a
 * server component with no mutations), so what a reviewer must be able to
 * trust is asserted where it is written:
 *
 *   1. honest states are words — a never-run OS and a disabled source cannot
 *      render a measured-looking `0/4`;
 *   2. the card imports no mutation and renders no form;
 *   3. volume comes from `clicksPerDay`, never a second day arithmetic;
 *   4. the worst-OS status follows the fixed order (disabled, never, stale,
 *      live);
 *   5. every read happens in `EmailControlData`, behind `connection()`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const here = new URL(".", import.meta.url);
const card = readFileSync(new URL("./github-source-card.tsx", here), "utf8");
const page = readFileSync(new URL("../app/email/page.tsx", here), "utf8");

/** Index just past a comment or string literal starting at `i`, else `i`. */
function skipNonCode(src: string, i: number): number {
  if (src[i] === "/" && src[i + 1] === "/") {
    const newline = src.indexOf("\n", i);
    return newline < 0 ? src.length : newline + 1;
  }
  if (src[i] === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end < 0 ? src.length : end + 2;
  }
  const quote = src[i];
  if (quote === '"' || quote === "'" || quote === "`") {
    let j = i + 1;
    while (j < src.length && src[j] !== quote) {
      j += src[j] === "\\" ? 2 : 1;
    }
    return j + 1;
  }
  return i;
}

/** The body of `function name(...) { ... }`, braces included. */
function functionBody(src: string, name: string): string {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = declaration.exec(src);
  assert.ok(match, `expected ${name}() in the source`);

  const paramsOpen = src.indexOf("(", match.index);
  let depth = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < src.length; i += 1) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (src[i] === "(") depth += 1;
    if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        paramsClose = i;
        break;
      }
    }
  }
  assert.ok(paramsClose > paramsOpen, `${name} has a parameter list`);

  const bodyOpen = src.indexOf("{", paramsClose);
  depth = 0;
  for (let i = bodyOpen; i < src.length; i += 1) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(bodyOpen, i + 1);
    }
  }
  assert.fail(`${name} has a closed body`);
}

test("honest states: a never-run OS and a disabled source are words, not zeroes", () => {
  assert.match(card, /"Never run"/, "a never-run OS says so");
  assert.match(card, /"Not scheduled"/, "a disabled source is not scheduled");
  assert.match(
    card,
    /status === "never"[\s\S]*?"Never run"/,
    "the never branch precedes any numeric coverage",
  );
  assert.match(
    card,
    /!enabled[\s\S]*?"Not scheduled"/,
    "the disabled branch precedes any numeric coverage",
  );
  assert.match(
    card,
    /This source is disabled\. Nothing clicks from GitHub/,
    "the disabled body explains the state in a sentence",
  );
  assert.match(
    card,
    /This source has no configuration row yet/,
    "a missing config row is said in words too",
  );
});

test("read-only: no mutation import, no server action, no form", () => {
  assert.doesNotMatch(card, /@\/app\/email\/actions/);
  assert.doesNotMatch(card, /["']use server["']/);
  assert.doesNotMatch(card, /useActionState|useFormStatus/);
  assert.doesNotMatch(card, /<form\b/);
  assert.doesNotMatch(card, /action=\{/);
});

test("volume is the one formula from the schedule domain", () => {
  assert.match(
    card,
    /import\s*\{[^}]*clicksPerDay[^}]*\}\s*from "@\/lib\/email\/sources"/,
    "the card imports the shared clicksPerDay",
  );
  assert.match(card, /clicksPerDay\(/, "the card calls it");
  assert.doesNotMatch(
    card,
    /86_400|86400/,
    "no second seconds-per-day arithmetic in the card",
  );
  assert.doesNotMatch(card, /function clicksPerDay/);
  assert.doesNotMatch(card, /@\/lib\/email\/volume/);
});

test("worst-OS status follows disabled, never, stale, live", () => {
  const worst = functionBody(card, "worstHealth");

  const disabledAt = worst.indexOf("!enabled");
  const neverAt = worst.indexOf('includes("never")');
  const staleAt = worst.indexOf('includes("stale")');
  const liveAt = worst.indexOf('"Live"');

  assert.ok(disabledAt >= 0, "disabled is handled");
  assert.ok(neverAt > disabledAt, "never-run is checked after disabled");
  assert.ok(staleAt > neverAt, "stale is checked after never-run");
  assert.ok(liveAt > staleAt, "live is the fallback");

  assert.match(worst, /label: "Disabled"/);
  assert.match(worst, /label: "Never run"/);
  assert.match(worst, /label: "Stale"/);
  assert.match(worst, /label: "Live"/);
});

test("the GitHub card links only the stable workflow page", () => {
  assert.match(card, /href=\{workflowUrl\}/);
  assert.match(card, /Runs &amp; artifacts/);
  assert.doesNotMatch(
    card,
    /actions\/runs\//,
    "a dispatch has no run id, so no per-run URL is fabricated",
  );
  assert.doesNotMatch(card, /api\.github\.com/);
});

test("every read happens inside EmailControlData, behind the page boundary", () => {
  const data = functionBody(page, "EmailControlData");
  const gate = functionBody(page, "EmailPageGate");

  for (const read of [
    "readSourceConfig(",
    "newestClickByOs(",
    "runnerClicksSince(",
    "summariseRunnerClicks(",
  ]) {
    assert.ok(data.includes(read), `EmailControlData reads ${read}`);
    assert.ok(
      !gate.includes(read),
      `${read} must not run before the page gate`,
    );
  }

  assert.match(page, /await connection\(\);/, "the boundary is connection()");
  assert.match(
    page,
    /<AffiliateControlPanel[\s\S]*?<GithubSourceCard[\s\S]*?<BurstCard/,
    "the GitHub card sits between Grafana and Burst",
  );
  assert.match(page, /workflowUrl=\{BROWSER_CHECK_RUN_URL\}/);
});
