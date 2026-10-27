import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ticket 11: instant-navigation + Workers regression guards. Every route
// touched by tickets 02-10 keeps a streaming shell, a recoverable error
// surface, and an e2e guard in tests/e2e/instant-shell.spec.ts, and the
// production build keeps the cache/prefetch flags the rig validates under.
// Source-text pins (repo has no jsdom): read the files that ship.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const src = (...parts: string[]) => join(root, "src", ...parts);
const appSeg = (...parts: string[]) => src("app", "(dashboard)", ...parts);
const read = (p: string) => readFileSync(p, "utf8");

// Route -> owning tickets (02-10) that touched it. The e2e spec and the
// segment boundaries below must cover every key here.
const TOUCHED_ROUTES: Record<string, string> = {
  "/": "05,08",
  "/dashboard": "02,05,09",
  "/calls": "09",
  "/calls/[id]": "03,09",
  "/leads": "09",
  "/leads/[id]": "03,09",
  "/campaigns": "09",
  "/campaigns/[id]": "06,09",
  "/agents": "10",
  "/agents/[id]": "06",
  "/agents/new": "06,10",
  "/settings": "04,06,10",
  "/settings/[tab]": "04,06,10",
  "/jobs": "06,10",
  "/numbers": "10",
  "/operator": "10",
};

// Segment directory per route key above.
const SEGMENT: Record<string, string> = {
  "/dashboard": appSeg("dashboard"),
  "/calls": appSeg("calls"),
  "/calls/[id]": appSeg("calls", "[id]"),
  "/leads": appSeg("leads"),
  "/leads/[id]": appSeg("leads", "[id]"),
  "/campaigns": appSeg("campaigns"),
  "/campaigns/[id]": appSeg("campaigns", "[id]"),
  "/agents": appSeg("agents"),
  "/agents/[id]": appSeg("agents", "[id]"),
  "/agents/new": appSeg("agents", "new"),
  "/settings": appSeg("settings"),
  "/settings/[tab]": appSeg("settings", "[tab]"),
  "/jobs": appSeg("jobs"),
  "/numbers": appSeg("numbers"),
  "/operator": appSeg("operator"),
};

test("instant-shell e2e covers every route touched by tickets 02-10", () => {
  const spec = read(join(root, "tests", "e2e", "instant-shell.spec.ts"));
  const missing: string[] = [];
  for (const route of Object.keys(TOUCHED_ROUTES)) {
    // Detail segments use a representative id in the spec; the static
    // prefix is the coverage anchor.
    const anchor = route.replace(/\[id\]/, "abc").replace(/\[tab\]/, "voice");
    if (!spec.includes(`"${anchor}"`) && !spec.includes(`\`${anchor}\``)) {
      missing.push(`${route} (tickets ${TOUCHED_ROUTES[route]})`);
    }
  }
  assert.deepEqual(missing, [], `e2e instant-shell must guard every touched route, missing: ${missing.join("; ")}`);
});

test("every touched route keeps loading and error boundaries", () => {
  const missing: string[] = [];
  for (const [route, dir] of Object.entries(SEGMENT)) {
    if (!existsSync(join(dir, "loading.tsx"))) missing.push(`${route} loading.tsx`);
    if (!existsSync(join(dir, "error.tsx"))) missing.push(`${route} error.tsx`);
  }
  assert.deepEqual(missing, [], `missing stream/error boundaries: ${missing.join("; ")}`);
});

test("every touched error boundary renders the shared recoverable surface", () => {
  const bad: string[] = [];
  for (const [route, dir] of Object.entries(SEGMENT)) {
    const body = read(join(dir, "error.tsx"));
    if (!body.includes("RouteError") || !body.includes("retry")) bad.push(route);
  }
  assert.deepEqual(bad, [], `error boundaries must render RouteError with retry: ${bad.join("; ")}`);
});

test("production build keeps cache and prefetch flags under which the rig validates", () => {
  const config = read(join(root, "next.config.ts"));
  assert.match(config, /cacheComponents:\s*true/, "cacheComponents stays on");
  assert.match(config, /partialPrefetching:\s*true/, "partialPrefetching stays on");
  // The testing API that powers instant() must stay gated to the isolated
  // test build — ordinary builds leave it unset.
  assert.match(
    config,
    /exposeTestingApiInProductionBuild:\s*process\.env\.VONI_INSTANT_TEST_BUILD === "1"/,
    "testing API stays test-build-gated",
  );
});

test("intent prefetch and view transitions stay wired", () => {
  const link = read(src("components", "hover-prefetch-link.tsx"));
  assert.match(link, /prefetch/, "hover link keeps intent prefetch");
  const layout = read(appSeg("layout.tsx"));
  assert.match(layout, /ViewTransition/, "dashboard keeps its view transition");
});

test("heavy voice and copilot modules stay behind on-demand loading", () => {
  const landing = read(src("components", "landing-demo.tsx"));
  assert.match(landing, /next\/dynamic/, "landing demo keeps the voice stack dynamic");
  const frame = read(src("components", "shell-frame.tsx"));
  assert.match(frame, /next\/dynamic/, "shell keeps Copilot dynamic");
  assert.match(frame, /CopilotProvider/, "shell keeps the provider gate");
});
