/**
 * Tripwire for the `/email` page gate.
 *
 * The node runner cannot execute a React Server Component, so this reads
 * `page.tsx` as source — but it slices that source into *function bodies* with
 * balanced braces rather than "up to the next comment". A comment inside a
 * component can no longer truncate a slice, and a doc comment can no longer
 * flip an `indexOf` (both were real holes in the earlier version of this file).
 *
 * The invariant: the four reads of panel data live in `EmailControlData` and
 * nowhere else, and `EmailPageGate` — the function that decides whether the
 * visitor is unlocked — never names them.
 *
 * Each assertion was proved against a real mutation while this file was
 * written, then reverted:
 *
 *   - `await getCheck(1);` inserted into `EmailPageGate` above
 *     `if (!unlocked) return <EmailGateScreen />;` failed two tests with
 *     "EmailPageGate must not read getCheck — it runs before the gate" and
 *     "getCheck appears outside EmailControlData, in: EmailPageGate";
 *   - `loading.tsx` rewritten to render `<header />` + `<CardListSkeleton>` (with
 *     `GateSkeleton` still present) failed "the route fallback is gate-shaped and
 *     carries no panel chrome" on its panel-chrome regex.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(path, "utf8");

const source = read(join(here, "page.tsx"));
const loading = read(join(here, "loading.tsx"));
const sharedSkeleton = read(
  join(here, "../../components/email-gate-skeleton.tsx"),
);

/** The reads that must never happen for a visitor who has not cleared the gate. */
const PANEL_DATA = [
  "getCheck",
  "listProbes",
  "affiliateClickStats",
  "listAffiliateClicks",
] as const;

/** Names that mean "this slice renders the control panel", directly or via a helper. */
const PANEL_NAMES =
  /AffiliateControlPanel|EmailControlData|PanelSkeleton|CardListSkeleton|TableSkeleton|clicks=|stats=|check=/;

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

/**
 * `src` with comments blanked out (strings kept), so prose that merely *names*
 * a panel helper cannot satisfy — or trip — a check about code.
 */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipNonCode(src, i);
      out += src.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const end = skipNonCode(src, i);
      out += " ".repeat(end - i);
      i = end - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Index of the bracket closing the one that opens at `openIndex`, or -1. */
function balancedEnd(
  src: string,
  openIndex: number,
  open = "{",
  close = "}",
): number {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (src[i] === open) {
      depth += 1;
    } else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every `function name(...) { ... }` in `src`, keyed by name, body only. */
function functionBodies(src: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const declaration = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  for (
    let match = declaration.exec(src);
    match;
    match = declaration.exec(src)
  ) {
    const paramsOpen = src.indexOf("(", match.index);
    const paramsClose = balancedEnd(src, paramsOpen, "(", ")");
    assert.ok(paramsClose > paramsOpen, `${match[1]} has a parameter list`);
    const bodyOpen = src.indexOf("{", paramsClose);
    const bodyClose = balancedEnd(src, bodyOpen);
    assert.ok(bodyClose > bodyOpen, `${match[1]} has a body`);
    bodies.set(match[1], src.slice(bodyOpen, bodyClose + 1));
    declaration.lastIndex = bodyClose + 1;
  }
  return bodies;
}

const bodies = functionBodies(source);
const loadingCode = stripComments(loading);

function body(name: string, from = bodies, file = "page.tsx"): string {
  const slice = from.get(name);
  assert.ok(slice, `${file} declares ${name}()`);
  return slice;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("EmailPageGate owns the gate check and reads no panel data", () => {
  const gate = body("EmailPageGate");

  assert.match(gate, /isPageUnlocked\(/, "the gate calls isPageUnlocked");
  assert.match(
    gate,
    /jar\.get\(PAGE_COOKIE\)/,
    "the gate reads the page cookie",
  );
  assert.match(
    gate,
    /secret\("EMAIL_PAGE_PASSWORD"\)/,
    "the gate checks the page password",
  );

  for (const read of PANEL_DATA) {
    assert.ok(
      !gate.includes(read),
      `EmailPageGate must not read ${read} — it runs before the gate`,
    );
  }

  const afterGate = gate.slice(gate.indexOf("if (!unlocked)"));
  assert.ok(gate.includes("if (!unlocked)"), "the gate decides `unlocked`");
  assert.match(
    afterGate,
    /return <EmailGateScreen \/>/,
    "the locked branch returns the gate screen",
  );
  assert.match(
    afterGate,
    /<EmailControlData /,
    "the unlocked branch renders the panel",
  );
  assert.ok(
    afterGate.indexOf("<EmailGateScreen />") <
      afterGate.indexOf("<EmailControlData "),
    "the gate screen is chosen before the panel is rendered",
  );
});

test("the four panel reads happen only inside EmailControlData", () => {
  const data = body("EmailControlData");

  for (const read of PANEL_DATA) {
    assert.ok(data.includes(read), `EmailControlData reads ${read}`);

    const alsoFoundIn = [...bodies]
      .filter(
        ([name, slice]) => name !== "EmailControlData" && slice.includes(read),
      )
      .map(([name]) => name);
    assert.deepEqual(
      alsoFoundIn,
      [],
      `${read} appears outside EmailControlData, in: ${alsoFoundIn.join(", ")}`,
    );

    assert.equal(
      occurrences(data, `${read}(`),
      occurrences(source, `${read}(`),
      `${read}( is called only inside EmailControlData`,
    );
  }
});

test("the locked branch renders the gate form and never panel chrome", () => {
  const screen = body("EmailGateScreen");

  assert.match(
    screen,
    /<EmailGateForm \/>/,
    "the gate screen renders the form",
  );
  assert.match(
    screen.slice(0, screen.indexOf("<EmailGateForm")),
    /<GateFrame>/,
    "the gate screen sits in the shared gate frame",
  );
  assert.doesNotMatch(screen, PANEL_NAMES);
  assert.doesNotMatch(screen, /68584|DEFAULT_CHECK_ID/);
});

test("the page's own fallback is the gate skeleton, not the panel skeleton", () => {
  const page = body("EmailControlPage");

  assert.match(
    page,
    /fallback=\{<GateSkeleton \/>\}/,
    "the Suspense fallback is GateSkeleton",
  );
  assert.doesNotMatch(page, /PanelSkeleton/);
  assert.match(
    source,
    /from "@\/components\/email-gate-skeleton"/,
    "GateSkeleton is the shared component, not a local copy",
  );
  assert.ok(
    !bodies.has("GateSkeleton"),
    "page.tsx does not redeclare GateSkeleton",
  );
});

test("the route fallback is gate-shaped and carries no panel chrome", () => {
  assert.match(loadingCode, /<GateSkeleton \/>/);
  assert.match(loadingCode, /from "@\/components\/email-gate-skeleton"/);
  assert.doesNotMatch(
    loadingCode,
    /PanelSkeleton|AffiliateControlPanel|EmailControlData|CardListSkeleton|TableSkeleton|<header/,
  );

  const skeleton = body(
    "GateSkeleton",
    functionBodies(sharedSkeleton),
    "email-gate-skeleton.tsx",
  );
  assert.match(skeleton, /<GateFrame>/, "the skeleton reuses the shared frame");
  assert.doesNotMatch(skeleton, PANEL_NAMES);
  assert.doesNotMatch(sharedSkeleton, /page-skeletons/);
});

test("PanelSkeleton stays inside page.tsx and is the only panel fallback", () => {
  assert.ok(bodies.has("PanelSkeleton"), "page.tsx declares PanelSkeleton");
  assert.ok(!loadingCode.includes("PanelSkeleton"));
  assert.match(
    source,
    /<Suspense fallback=\{<PanelSkeleton \/>\}>\s*<EmailControlData /,
    "the panel fallback wraps EmailControlData, behind the gate",
  );
});

test("the page stays out of search indexes", () => {
  assert.match(source, /robots: \{ index: false, follow: false \}/);
});
