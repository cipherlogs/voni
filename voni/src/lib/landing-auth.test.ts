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
  // Composition (DESIGN.md §10c): badge, serif headline, subcopy, call CTA,
  // then the live-demo widget.
  assert.match(landing, /Phone and WhatsApp voice agents/, "hero badge stays");
  assert.match(landing, /font-editorial/, "serif headline stays");
  assert.match(landing, /tracking-\[-0\.03em\]/, "hero keeps the mockup's tight tracking");
  assert.match(landing, /text-balance/, "balanced wrapping stays");
  assert.match(landing, /text-muted-foreground/, "plain-language subcopy tone stays");
  assert.match(landing, /max-w-225/, "headline keeps the mockup's 900px measure");
  assert.match(landing, /max-w-140/, "subcopy keeps the mockup's 560px measure");
  assert.match(landing, /LandingDemo/, "live-demo widget stays in the hero");
  assert.match(landing, /id="demo"/, "demo links have an anchor to land on");
  // Audit 2026-09-24: one call action. The demo card's Start call is the only
  // green on the page; hero and closing CTAs sign up or link to the demo.
  assert.doesNotMatch(landing, /voice-call-live-fill/, "no scroll-only green call button");
  assert.match(landing, /<main id="main"/, "page content sits in a main landmark");
  assert.match(landing, /href="#main"/, "skip link targets the main landmark");
  // Section-whitespace rhythm: every section shares one gutter literal
  // (PUBLIC_CONTAINER in lib/public-container.ts), not a copy per file.
  assert.match(landing, /PUBLIC_CONTAINER/, "hero shares the public gutter");
  assert.doesNotMatch(landing, /max-w-300 px-6/, "gutter literal lives in one module");
  const footerGutter = readRepo("lib/public-container.ts");
  assert.match(
    footerGutter,
    /max-w-300 px-6/,
    "one gutter literal (1152px measure) for hero, sections, and footer"
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

  // The orb is the demo card's portrait (§10c); inline test calls stay
  // motion-free, so landing motion appears only inside the demo branch.
  const call = readRepo("components/voice-call.tsx");
  assert.match(call, /<LandingOrb \/>/, "demo card uses the orb portrait");
  const inline = call.slice(call.indexOf("// Fills its host rail"));
  assert.doesNotMatch(inline, /landing-|LandingOrb/, "inline call card stays motion-free");

  // Light-only landing (§10c): ephemeral override on "/", no theme toggle
  // in its header. The provider itself stays outside Suspense (its inline
  // <script> is SSR-only); only the usePathname leaf suspends.
  const theme = readRepo("components/theme-provider.tsx");
  assert.match(theme, /LandingLightEnforcer/, "landing forces the light theme");
  assert.match(theme, /usePathname\(\)/, "landing override reads the route");
  assert.match(theme, /pathname !== "\/"/, "override applies to the landing only");
  assert.match(theme, /classList\.remove\("dark"\)/, "landing strips dark without persisting");
  assert.doesNotMatch(theme, /forcedTheme=\{/, "no conditional provider prop (script must stay out of the fallback)");
  const header = readRepo("components/landing-header.tsx");
  assert.doesNotMatch(header, /ModeToggle/, "landing header has no theme toggle");
});

test("landing motion is decorative, token-only, and stops under reduced motion", () => {
  const sections = readRepo("components/landing-sections.tsx");
  const orb = readRepo("components/landing-orb.tsx");
  assert.match(orb, /aria-hidden="true"/, "orb is decorative");
  assert.match(sections, /aria-hidden="true"/, "bento visuals are decorative");
  assert.doesNotMatch(sections + orb, /style=\{/, "no inline style objects");
  // Plain-language copy: no carnival verbs, no placeholder names.
  assert.doesNotMatch(sections, /revolutionize|supercharge|unlock|seamless|powerful/i, "no hype copy");
  assert.doesNotMatch(sections, /acme|lorem|john doe/i, "no placeholder names");

  const css = readRepo("app/globals.css");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  const loops = [...css.matchAll(/^\.(landing-[a-z-]+)\s*\{[^}]*infinite/gm)].map((m) => m[1]);
  assert.ok(loops.length > 0, "landing loops exist");
  for (const cls of loops) {
    assert.match(reduced, new RegExp(`\\.${cls}\\b`), `${cls} stops under reduced motion`);
  }
  // Audit 2026-09-24: bento and steps pictures play once when seen; only the
  // orb, the pings and the ticker may loop, and every played class stops
  // under reduced motion too.
  assert.deepEqual(
    loops.sort(),
    ["landing-marquee", "landing-orb-ping", "landing-orb-spin", "landing-ping"],
    "only the orb, the live ping and the ticker loop"
  );
  const played = [...css.matchAll(/^\[data-inview\] \.(landing-[a-z-]+)[^{]*\{\s*animation:/gm)].map((m) => m[1]);
  assert.ok(played.length > 0, "in-view animations exist");
  for (const cls of played) {
    assert.match(reduced, new RegExp(`\\.${cls}\\b`), `${cls} stops under reduced motion`);
  }
  assert.doesNotMatch(css, /@keyframes landing-[a-z-]+\s*\{[^}]*\b(left|top):/, "landing motion never animates left/top");
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
