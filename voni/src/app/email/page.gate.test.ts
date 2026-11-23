/**
 * Tripwire for the `/email` page gate.
 *
 * The node runner cannot execute a React Server Component, so this reads
 * `page.tsx` as source — but it slices that source into *function bodies* with
 * balanced braces rather than "up to the next comment". A comment inside a
 * component can no longer truncate a slice, and a doc comment can no longer
 * flip an `indexOf` (both were real holes in the earlier version of this file).
 *
 * The invariant: every read of panel data is imported for `EmailControlData`,
 * lives only in that function, and `<EmailControlData />` is rendered exactly
 * once — inside `EmailPageGate`, below the gate check.
 *
 * The watched names are *derived from the import specifiers*, local aliases
 * included, so `import { getCheck as fetchCheck }` watches `fetchCheck` without
 * anyone editing a list here. A second evasion — hoisting the panel element to
 * a module-scope constant and rendering that in `EmailGateScreen` — is what the
 * single-render and position assertions below exist for; naming no identifier,
 * it would pass a name-only check.
 *
 * Each assertion was proved against a real mutation while this file was
 * written, then reverted:
 *
 *   - `await getCheck(1);` inserted into `EmailPageGate` above
 *     `if (!unlocked) return <EmailGateScreen />;` failed "EmailPageGate must
 *     not read getCheck — it runs before the gate" and "getCheck appears outside
 *     EmailControlData, in: EmailPageGate";
 *   - `loading.tsx` rewritten to render `<header />` + `<CardListSkeleton>` (with
 *     `GateSkeleton` still present) failed "the route fallback is gate-shaped and
 *     carries no panel chrome" on its panel-chrome regex;
 *   - `const EARLY = <EmailControlData … />` at module scope, rendered from
 *     `EmailGateScreen` and from the gate, failed "EmailControlData is rendered
 *     exactly once" (2 renders);
 *   - `import { getCheck as fetchCheck }` added beside the original import and
 *     `fetchCheck(1)` called in `EmailPageGate` failed "EmailPageGate must not
 *     read fetchCheck".
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
 * a panel helper cannot satisfy — or trip — a check about code. Blanking keeps
 * every offset, so indices from the stripped text index the original too.
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

/** `page.tsx` without comments; same length, same offsets as `source`. */
const code = stripComments(source);

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

type FunctionSlice = {
  body: string;
  /** Offset of the body's `{` in the file it was read from. */
  start: number;
  /** Offset of the body's matching `}`. */
  end: number;
};

/** Every `function name(...) { ... }` in `src`, keyed by name, body only. */
function functionBodies(src: string): Map<string, FunctionSlice> {
  const bodies = new Map<string, FunctionSlice>();
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
    bodies.set(match[1], {
      body: src.slice(bodyOpen, bodyClose + 1),
      start: bodyOpen,
      end: bodyClose,
    });
    declaration.lastIndex = bodyClose + 1;
  }
  return bodies;
}

const bodies = functionBodies(source);
const loadingCode = stripComments(loading);

function sliceOf(
  name: string,
  from = bodies,
  file = "page.tsx",
): FunctionSlice {
  const slice = from.get(name);
  assert.ok(slice, `${file} declares ${name}()`);
  return slice;
}

function body(name: string, from = bodies, file = "page.tsx"): string {
  return sliceOf(name, from, file).body;
}

/** Every index of `needle` in `text`, so a repeat cannot hide behind a first hit. */
function indexesOf(text: string, needle: string): number[] {
  const found: number[] = [];
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + needle.length)
  ) {
    found.push(at);
  }
  return found;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

type ImportBinding = {
  /** The name this file uses — `as` applied. */
  local: string;
  /** The exported name, before any `as`. */
  imported: string;
  source: string;
  /** A type-only binding, which cannot read data at runtime. */
  typeOnly: boolean;
};

/**
 * Every binding `src` imports, keyed by the local name so an alias cannot hide
 * a watched read. An import shape this parser does not understand is a test
 * failure rather than a silently unwatched binding.
 */
function importBindings(src: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const declaration =
    /\bimport\s+(type\s+)?([^;]*?)\s+from\s*["']([^"']+)["']/g;

  for (
    let match = declaration.exec(src);
    match;
    match = declaration.exec(src)
  ) {
    const declarationTypeOnly = match[1] !== undefined;
    const clause = (match[2] ?? "").trim();
    const from = match[3] ?? "";
    if (clause === "") continue;

    const named = /\{([\s\S]*)\}/.exec(clause);
    if (named) {
      for (const raw of (named[1] ?? "").split(",")) {
        const item = raw.trim();
        if (item === "") continue;
        const spec = /^(type\s+)?([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/.exec(
          item,
        );
        assert.ok(spec, `understood the import specifier "${item}" in ${from}`);
        const imported = spec[2]!;
        bindings.push({
          local: spec[3] ?? imported,
          imported,
          source: from,
          typeOnly: declarationTypeOnly || spec[1] !== undefined,
        });
      }
    }

    // Default and namespace bindings sit outside the braces.
    for (const raw of clause.replace(/\{[\s\S]*\}/, "").split(",")) {
      const item = raw.trim();
      if (item === "") continue;
      const namespace = /^\*\s+as\s+([A-Za-z0-9_$]+)$/.exec(item);
      if (namespace) {
        bindings.push({
          local: namespace[1]!,
          imported: "*",
          source: from,
          typeOnly: declarationTypeOnly,
        });
        continue;
      }
      const fallback = /^([A-Za-z0-9_$]+)$/.exec(item);
      assert.ok(fallback, `understood the import clause "${item}" in ${from}`);
      bindings.push({
        local: fallback[1]!,
        imported: "default",
        source: from,
        typeOnly: declarationTypeOnly,
      });
    }
  }

  return bindings;
}

/**
 * The modules whose exports are panel data. Every value imported from one of
 * them is a read that must happen inside `EmailControlData` and nowhere else —
 * derived, so a local alias is watched under the name this file actually calls.
 */
const DATA_MODULES = ["@/lib/email/clicks", "@/lib/grafana/synthetic"] as const;

const imports = importBindings(code);

const PANEL_DATA: string[] = imports
  .filter(
    (binding) =>
      !binding.typeOnly &&
      (DATA_MODULES as readonly string[]).includes(binding.source),
  )
  .map((binding) => binding.local);

assert.ok(
  PANEL_DATA.length >= 4,
  `the panel-data imports are watched, not assumed: ${PANEL_DATA.join(", ")}`,
);

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
  assert.match(gate, /if \(!unlocked\)/, "the gate decides `unlocked`");

  for (const read of PANEL_DATA) {
    assert.ok(
      !gate.includes(read),
      `EmailPageGate must not read ${read} — it runs before the gate`,
    );
  }
});

test("EmailControlData is rendered exactly once, inside the unlocked branch", () => {
  const gate = sliceOf("EmailPageGate");
  const renders = indexesOf(code, "<EmailControlData");

  assert.equal(
    renders.length,
    1,
    `<EmailControlData is rendered ${renders.length} times: a module-scope element or a ` +
      "second render from the locked branch hands the panel to a visitor who never passed the gate",
  );

  const renderAt = renders[0]!;
  assert.ok(
    renderAt > gate.start && renderAt < gate.end,
    "the single EmailControlData render sits inside EmailPageGate, not at module scope",
  );

  const unlockedAt = gate.body.indexOf("if (!unlocked)");
  assert.ok(unlockedAt >= 0, "the gate decides `unlocked`");
  assert.ok(
    gate.start + unlockedAt < renderAt,
    "the panel render sits after the gate check, in the unlocked branch",
  );

  // The single highest-consequence property of this file: a locked visitor
  // gets the gate screen and nothing else. Removing this assertion was a real
  // regression — replacing the locked branch with `if (!unlocked) {}` renders
  // the whole panel to every locked visitor and passed every other test here.
  assert.match(
    gate.body.slice(unlockedAt),
    /if \(!unlocked\) return <EmailGateScreen \/>;/,
    "the locked branch returns the gate screen",
  );
});

test("every panel read happens only inside EmailControlData", () => {
  const data = body("EmailControlData");

  for (const read of PANEL_DATA) {
    assert.ok(data.includes(read), `EmailControlData reads ${read}`);

    const alsoFoundIn = [...bodies]
      .filter(
        ([name, slice]) => name !== "EmailControlData" && slice.body.includes(read),
      )
      .map(([name]) => name);
    assert.deepEqual(
      alsoFoundIn,
      [],
      `${read} appears outside EmailControlData, in: ${alsoFoundIn.join(", ")}`,
    );

    assert.equal(
      occurrences(data, `${read}(`),
      occurrences(code, `${read}(`),
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

  for (const read of PANEL_DATA) {
    assert.ok(
      !screen.includes(read),
      `EmailGateScreen must not read ${read} — it is the locked view`,
    );
  }
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

test("the source filter is resolved in the request-time data boundary", () => {
  const data = body("EmailControlData");

  // The URL contract is resolved against the stored producer inside the same
  // boundary that reads the rows, so a copied link and the narrowed query come
  // from one value; an unknown value resolves to All in `parseClickSource`.
  assert.match(
    data,
    /const selectedSource = parseClickSource\(params\.source\);/,
  );
  assert.match(
    data,
    /listAffiliateClicks\(PAGE_CLICK_LIMIT, selectedSource \?\? undefined\)/,
    "the table query is the resolved filter, not the raw query string",
  );
  assert.match(data, /clickSourceChips\(selectedSource\)/);
  assert.match(data, /sources=\{sourceChips\}/);

  // The gate renders before any of this and must not touch the filter.
  const gate = body("EmailPageGate");
  assert.doesNotMatch(gate, /selectedSource|clickSourceChips|parseClickSource/);
});

test("the page stays out of search indexes", () => {
  assert.match(source, /robots: \{ index: false, follow: false \}/);
});
