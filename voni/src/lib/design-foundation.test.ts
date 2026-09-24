import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Foundation pin for ticket 01 (minimalist-editorial-pass): serif amendment,
// token sweep, and motion unification. Source-text checks mirror the DESIGN.md
// §5 enforcement greps, with generated ui/ primitives and explicitly listed
// exceptions excluded. Follows the existing source-text prior art
// (onboarding-07.test.tsx, sidebar-redesign.test.ts): no jsdom, read the
// real files that ship.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const designPath = join(srcRoot, "..", "DESIGN.md");

function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.(tsx?|css|svg)$/.test(entry)) continue;
      if (/\.test\.(tsx?|mts)$/.test(entry)) continue;
      out.push(full);
    }
  };
  walk(srcRoot);
  return out;
}

function readRepo(relative: string): string {
  return readFileSync(join(srcRoot, relative), "utf8");
}

test("Amendment A: one bundled editorial serif for heroes and quotes only", () => {
  const layout = readRepo("app/layout.tsx");
  // Bundled via the framework font bundler — no third-party fetch.
  assert.match(layout, /from "next\/font\/google"/);
  assert.match(layout, /Newsreader/);
  assert.match(layout, /--font-editorial/);
  // Only the three blessed families: sans, mono, editorial serif.
  const fontImports = layout.match(/import \{[^}]*\} from "next\/font\/google"/g) ?? [];
  assert.equal(fontImports.length, 1, "single next/font/google import");
  assert.match(fontImports[0] ?? "", /Geist/);
  assert.match(fontImports[0] ?? "", /Geist_Mono/);
  assert.match(fontImports[0] ?? "", /Newsreader/);
  // Wired onto the root so the utility resolves app-wide.
  assert.match(layout, /geistSans\.variable/);
  assert.match(layout, /geistMono\.variable/);
  assert.match(layout, /editorial/);

  const css = readRepo("app/globals.css");
  assert.match(css, /--font-editorial/);
  assert.match(css, /--font-geist-sans/);
  // Element scope for quotes: future blockquote/q render editorial
  // without inventing per-site classes; body stays on the blessed sans.
  assert.match(css, /blockquote/);

  const landing = readRepo("app/page.tsx");
  assert.match(landing, /font-editorial/, "landing hero headline uses the serif");

  const design = readFileSync(designPath, "utf8");
  assert.match(design, /Amendment A/);
  assert.match(design, /Newsreader/);
  assert.match(design, /hero headings and quotes only/);
});

test("arbitrary type/background values map to scale except the listed survivor", () => {
  const files = listSourceFiles();
  const hits: string[] = [];
  for (const full of files) {
    if (full.includes(`${join("components", "ui")}${"/"}`)) continue;
    const text = readFileSync(full, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (/text-\[|bg-\[/.test(line)) {
        // Listed exception: voice-call error body mixes destructive toward
        // foreground — no token expresses it, a new token would be worse.
        if (full.endsWith("voice-call.tsx") && line.includes("color-mix")) return;
        hits.push(`${full}:${idx + 1}:${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `arbitrary text-/bg- hits:\n${hits.join("\n")}`);
});

test("hardcoded palette stays out of product code except listed sites", () => {
  const files = listSourceFiles();
  const hits: string[] = [];
  for (const full of files) {
    const text = readFileSync(full, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (/provider-/.test(line)) return;
      // Icon favicon is fixed paper + ink by design (not theme-reactive).
      if (full.endsWith("icon.svg")) return;
      if (/emerald|amber/i.test(line)) {
        hits.push(`${full}:${idx + 1}:${line.trim().slice(0, 120)}`);
        return;
      }
      // Hex literals: skip HTML-entity middots (use the real char instead)
      // by matching only plausible color literals.
      const hex = line.match(/#[0-9a-fA-F]{3,6}\b/);
      if (hex) hits.push(`${full}:${idx + 1}:${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], `palette hits:\n${hits.join("\n")}`);
});

test("bespoke dark sites are gone except the AppearancePreview scene pair", () => {
  const files = listSourceFiles();
  const hits: string[] = [];
  for (const full of files) {
    if (full.includes(`${join("components", "ui")}${"/"}`)) continue;
    const text = readFileSync(full, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (!line.includes("dark:")) return;
      // Sole scene exception: the illustrative preview keeps light/dark
      // halves fixed under either host theme (DESIGN.md §5).
      if (full.endsWith(join("settings-bento", "scenes.tsx"))) return;
      hits.push(`${full}:${idx + 1}:${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(hits, [], `dark: hits:\n${hits.join("\n")}`);
});

test("inline style objects survive only as listed dynamic exceptions", () => {
  const files = listSourceFiles();
  const hits: string[] = [];
  for (const full of files) {
    const text = readFileSync(full, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (!line.includes("style={{") && !line.includes("style={")) return;
      const rel = full.slice(srcRoot.length + 1);
      // Generated primitives own their CSS variables.
      if (rel.startsWith(join("components", "ui") + "/")) return;
      // Deterministic voice motif: hash-derived token gradient, no static
      // equivalent (Amendment A scope keeps it token-only).
      if (rel === join("components", "wizard", "voice-field.tsx")) return;
      // Brand mark: static stroke via inline currentColor so the resting mark
      // follows the theme without a presentation attribute (animated mark
      // uses the CSS class per the Chromium note in globals.css).
      if (rel === join("components", "voni-logo.tsx")) return;
      hits.push(`${full}:${idx + 1}:${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(hits, [], `style hits:\n${hits.join("\n")}`);
});

test("stacks, composition, toast, filler, and geometry converge on the system", () => {
  const files = listSourceFiles();
  const spaceHits: string[] = [];
  const cnHits: string[] = [];
  const sonnerHits: string[] = [];
  const childHits: string[] = [];
  const fillerHits: string[] = [];
  for (const full of files) {
    if (full.includes(`${join("components", "ui")}${"/"}`)) continue;
    const text = readFileSync(full, "utf8");
    for (const line of text.split("\n")) {
      if (/space-[xy]-/.test(line)) spaceHits.push(`${full}:${line.trim().slice(0, 100)}`);
      if (/from "cn"/.test(line)) cnHits.push(full);
      if (/sonner/i.test(line)) sonnerHits.push(full);
      if (/asChild/.test(line)) childHits.push(full);
      if (/acme|lorem|john doe|foo bar/i.test(line)) fillerHits.push(full);
    }
  }
  assert.deepEqual(spaceHits, [], `spaced stacks:\n${spaceHits.join("\n")}`);
  assert.deepEqual(cnHits, [], `off-spec cn imports: ${cnHits.join(", ")}`);
  assert.deepEqual(sonnerHits, [], `non-canonical toast refs: ${sonnerHits.join(", ")}`);
  assert.deepEqual(childHits, [], `child-composition props: ${childHits.join(", ")}`);
  assert.deepEqual(fillerHits, [], `template filler: ${fillerHits.join(", ")}`);

  const controlHits: string[] = [];
  const walkComponents = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walkComponents(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\./.test(entry)) continue;
      if (readFileSync(full, "utf8").includes("CONTROL")) controlHits.push(full);
    }
  };
  walkComponents(join(srcRoot, "components"));
  assert.deepEqual(controlHits, [], `per-form geometry overrides: ${controlHits.join(", ")}`);
});

test("overlay and interactive durations unify on the shared standard token", () => {
  const files = listSourceFiles();
  const durationHits: string[] = [];
  for (const full of files) {
    if (full.includes(`${join("components", "ui")}${"/"}`)) {
      // Generated overlay primitives must already speak the standard enter.
      const text = readFileSync(full, "utf8");
      if (/dialog|select|dropdown-menu/.test(full) && /duration-100/.test(text)) {
        durationHits.push(`${full}: overlay still on duration-100`);
      }
      continue;
    }
    const text = readFileSync(full, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (/duration-100/.test(line)) durationHits.push(`${full}:${idx + 1}`);
    });
  }
  assert.deepEqual(durationHits, [], `duration-100 survivors:\n${durationHits.join("\n")}`);

  for (const rel of [
    join("components", "ui", "dialog.tsx"),
    join("components", "ui", "select.tsx"),
    join("components", "ui", "dropdown-menu.tsx"),
  ]) {
    const text = readFileSync(join(srcRoot, rel), "utf8");
    assert.match(text, /duration-\[var\(--motion-standard\)\]/, `${rel} speaks the standard enter`);
  }

  const css = readRepo("app/globals.css");
  assert.match(css, /--motion-standard:\s*180ms/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.notEqual(css.indexOf("@media (prefers-reduced-motion: reduce)"), -1);
  // Looping families need their own outright stop (the blanket 1ms squash
  // reads as flicker on infinite loops). One-shots (voni-chip-in,
  // auth/content enters, voni-done-pop) are covered by the squash alone per
  // the delight amendment.
  for (const family of [
    "voni-arc",
    "voni-shimmer",
  ]) {
    assert.match(reduced, new RegExp(family), `${family} keeps its reduced-motion stop`);
  }
});
