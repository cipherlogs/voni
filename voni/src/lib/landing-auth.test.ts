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
  // Section-whitespace rhythm: hero and feature sections share one gutter
  // literal (PUBLIC_CONTAINER in site-footer.tsx), not a copy per file.
  assert.match(landing, /PUBLIC_CONTAINER/, "hero shares the public gutter");
  assert.doesNotMatch(landing, /max-w-6xl px-6/, "gutter literal lives in one module");
  const footerGutter = readRepo("components/site-footer.tsx");
  assert.match(
    footerGutter,
    /max-w-6xl px-6/,
    "one gutter literal for header, hero, grid, and footer"
  );
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
  const decision = readRepo("components/auth-decision.tsx");
  // Frozen session decisions: byte-identical semantics in one module.
  assert.match(decision, /auth\.api\.getSession/, "shared decision keeps the session check");
  assert.match(decision, /safeNextPath/, "shared decision keeps next-path sanitizing");
  assert.match(decision, /devBypassEnabled/, "shared decision keeps the dev bypass");
  assert.match(decision, /AuthenticatedRedirect/, "shared decision keeps the client redirect");
  assert.match(decision, /AuthForm/, "shared decision keeps the single-sign-on form");
  assert.match(decision, /mode === "login"/, "shared decision branches on mode");
  assert.match(
    decision,
    /Google access was cancelled/,
    "login OAuth copy stays"
  );
  assert.match(
    decision,
    /Google could not complete account creation/,
    "signup OAuth copy stays"
  );

  for (const [route, mode] of [
    ["app/login/page.tsx", "login"],
    ["app/signup/page.tsx", "signup"],
  ] as const) {
    const page = readRepo(route);
    // Thin frames: delegate to the shared decision, keep boundaries + footer.
    assert.match(page, /AuthDecision/, `${route} delegates to the shared decision`);
    assert.match(page, new RegExp(`mode="${mode}"`), `${route} passes its mode`);
    assert.match(page, /Suspense/, `${route} keeps its suspense boundary`);
    // Shared footer language with the landing document.
    assert.match(page, /SiteFooter/, `${route} shares the footer language`);
    assert.match(page, /FooterYear/, `${route} shares the request-time year leaf`);
    assert.doesNotMatch(page, /auth\.api\.getSession/, `${route} does not duplicate the session check`);
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
