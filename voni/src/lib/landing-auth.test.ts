import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Ticket 02 pin (minimalist-editorial-pass): landing + auth in the editorial
// language. Source-text checks mirror the ticket checkboxes with the frozen
// logic kept byte-identical: session gates, suspense boundaries, and
// demo-mode voice wiring stay; only markup moves. Follows the existing
// source-text prior art (design-foundation.test.ts): no jsdom, read the
// real files that ship.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

function readRepo(relative: string): string {
  return readFileSync(join(srcRoot, relative), "utf8");
}

test("landing hero reads as one document composition with logic frozen", () => {
  const landing = readRepo("app/page.tsx");
  // Composition: badge, serif headline, subcopy, integrated demo widget.
  assert.match(landing, /Live voice calls/, "hero badge stays");
  assert.match(landing, /font-editorial/, "serif headline stays");
  assert.match(landing, /tracking-tight/, "tight tracking stays");
  assert.match(landing, /text-balance/, "balanced wrapping stays");
  assert.match(landing, /text-muted-foreground/, "plain-language subcopy tone stays");
  assert.match(landing, /max-w-3xl/, "headline keeps its constrained measure");
  assert.match(landing, /max-w-xl/, "subcopy keeps its constrained measure");
  assert.match(landing, /LandingDemo/, "live-demo widget stays in the hero");
  // Demo widget sits in the same composition measure, not full-bleed.
  assert.match(landing, /max-w-2xl/, "demo wrapper shares the document measure");
  // Section-whitespace rhythm: hero and feature sections share one gutter.
  assert.match(landing, /max-w-6xl px-6/, "one gutter for header, hero, and grid");
  assert.match(landing, /py-16/, "hero on the section-whitespace rhythm");
  assert.match(landing, /md:py-24/, "hero keeps its generous desktop rhythm");
  // Frozen logic: session gate, suspense boundaries, demo-mode wiring.
  assert.match(landing, /auth\.api\.getSession/, "session gate stays");
  assert.match(landing, /devBypassEnabled/, "dev bypass gate stays");
  assert.match(landing, /Suspense/, "suspense boundaries stay");
  assert.match(landing, /LandingHeaderGate/, "header gate stays behind its boundary");
  assert.match(landing, /FooterYear/, "request-time footer leaf stays");

  const demo = readRepo("components/landing-demo.tsx");
  assert.match(demo, /VoiceCall/, "demo widget keeps the voice surface");
  assert.match(demo, /kind: "demo"/, "demo-mode wiring stays");
});

test("feature Tile grid uses flat card tokens with ring hairlines", () => {
  const grid = readRepo("components/landing-grid-list.tsx");
  assert.match(grid, /bg-card/, "flat card token surface");
  assert.match(grid, /ring-1/, "crisp ring hairline");
  assert.match(grid, /ring-foreground\/10/, "hairline on the foreground token");
  assert.match(grid, /p-8/, "generous card padding");
  assert.match(grid, /gap-6/, "generous grid rhythm");
  assert.match(grid, /mt-auto|min-h-/, "bottom-anchored content");
  assert.match(grid, /duration-\[var\(--motion-standard\)\]/, "hover breath on the shared standard");
  // No primary-color fills, gradients, neon, or glass on the marketing grid.
  assert.doesNotMatch(grid, /bg-primary/, "no primary-color fills");
  assert.doesNotMatch(grid, /gradient|neon|glass|backdrop-blur/, "no hype surfaces");
  // Plain-language copy: no carnival verbs, no placeholder names.
  assert.doesNotMatch(grid, /revolutionize|supercharge|unlock|seamless|powerful/i, "no hype copy");
  assert.doesNotMatch(grid, /acme|lorem|john doe/i, "no placeholder names");
  // Icon sizing stays primitive-owned.
  assert.match(grid, /size-4/, "icon keeps its primitive size");
});

test("auth screens keep the login idiom with shared footer language", () => {
  for (const route of ["app/login/page.tsx", "app/signup/page.tsx"]) {
    const page = readRepo(route);
    // Frozen session decisions: byte-identical semantics, only frame moves.
    assert.match(page, /auth\.api\.getSession/, `${route} keeps the session decision`);
    assert.match(page, /safeNextPath/, `${route} keeps next-path sanitizing`);
    assert.match(page, /devBypassEnabled/, `${route} keeps the dev bypass`);
    assert.match(page, /AuthenticatedRedirect/, `${route} keeps the client redirect`);
    assert.match(page, /AuthForm/, `${route} keeps the single-sign-on form`);
    assert.match(page, /Suspense/, `${route} keeps its suspense boundary`);
    // Shared footer language with the landing document.
    assert.match(page, /SiteFooter|It sees the lead/, `${route} shares the footer language`);
  }

  const form = readRepo("components/auth-form.tsx");
  assert.match(form, /Login01/, "auth stays on the pinned login idiom");
  assert.match(form, /signIn\.social/, "Google-only sign-in logic stays");
  assert.match(form, /callbackURL: nextPath/, "post-auth destination stays");

  const block = readRepo("components/login-01.tsx");
  assert.match(block, /sm:max-w-sm/, "narrow auth width stays");
  assert.match(block, /Continue with Google/, "Google action stays");

  const footer = readRepo("components/site-footer.tsx");
  assert.match(footer, /It sees the lead/, "shared footer tagline");
  assert.match(footer, /VoniLogo/, "shared footer brand mark");
});
