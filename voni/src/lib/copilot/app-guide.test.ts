import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPartialNav,
  isCorrectionRetarget,
  isFlowLockedRoute,
  matchNavIntent,
  rankNavPrefix,
  renderAppGuide,
  stripWakePhrase,
} from "./app-guide";
import {
  APP_DESTINATIONS,
  APP_FEATURE_TERMS,
  NAVIGABLE_ROUTES,
  SETTINGS_TABS_MANIFEST,
} from "./app-manifest";
import { NAV_ITEMS } from "@/components/app-sidebar";
import { SECTION_TITLES } from "@/components/app-sidebar";
import { SETTINGS_TABS } from "@/lib/settings-tabs";

test("guide names every destination and the voice section route", () => {
  const guide = renderAppGuide();
  assert.match(guide, /\/settings\/voice/);
  assert.match(guide, /Voice copilot/);
  assert.doesNotMatch(guide, /tap-only/);
  assert.doesNotMatch(guide, /\[tab\]/);
  assert.match(guide, /ui_settings_tab/);
  assert.match(guide, /ui_open_record/);
  for (const destination of APP_DESTINATIONS.filter((d) => d.access === "signed-in")) {
    assert.ok(guide.includes(destination.route), `guide names ${destination.route}`);
  }
});

test("manifest covers every nav item, title, and settings tab", () => {
  const routes = new Set(NAVIGABLE_ROUTES);
  for (const item of NAV_ITEMS as Array<{ title: string; url: string }>) {
    assert.ok(routes.has(item.url), `manifest covers nav ${item.url}`);
  }
  for (const [prefix] of SECTION_TITLES as Array<[string, string]>) {
    assert.ok(routes.has(prefix), `manifest covers section ${prefix}`);
  }
  assert.deepEqual(
    SETTINGS_TABS_MANIFEST.map((t) => t.label),
    SETTINGS_TABS.map((t) => t.label),
  );
});

test("partial speech routes early to settings", () => {
  assert.equal(matchNavIntent("I want to open settings", "/jobs"), "/settings");
  assert.equal(matchNavIntent("open settings then voice control", "/dashboard"), "/settings/voice");
  assert.equal(matchNavIntent("take me to the voice copilot", "/agents"), "/settings/voice");
});

test("spoken section names land on their section routes", () => {
  assert.equal(matchNavIntent("open account settings", "/jobs"), "/settings/account");
  assert.equal(matchNavIntent("show the workspace section", "/dashboard"), "/settings/workspace");
  assert.equal(matchNavIntent("read the services section", "/agents"), "/settings/services");
  assert.equal(matchNavIntent("open appearance settings", "/leads"), "/settings/appearance");
  assert.equal(matchNavIntent("change my voice", "/jobs"), "/settings/voice");
  assert.equal(matchNavIntent("change my voice", "/settings/voice"), null);
});

test("longest phrase wins and the current route never re-pushes", () => {
  assert.equal(matchNavIntent("build a new agent for viewings", "/jobs"), "/agents/new");
  assert.equal(matchNavIntent("open settings", "/settings"), null);
  assert.equal(matchNavIntent("show me my jobs", "/settings"), "/jobs");
});

test("word boundaries guard against false routes", () => {
  assert.equal(matchNavIntent("the leaders called back", "/jobs"), null);
  assert.equal(matchNavIntent("nothing to do here", "/jobs"), null);
});

test("feature terms stay within the recognition budget", () => {
  assert.ok(APP_FEATURE_TERMS.length > 0 && APP_FEATURE_TERMS.length <= 100);
  assert.ok(APP_FEATURE_TERMS.includes("Voice copilot"));
  for (const section of ["account", "workspace", "services", "appearance"]) {
    assert.ok(APP_FEATURE_TERMS.includes(section), `recognition hears ${section}`);
  }
});

test("manifest v3 covers all 23 pages without navigating to templates or public routes", () => {
  assert.equal(APP_DESTINATIONS.length, 23);
  for (const route of APP_DESTINATIONS) {
    assert.equal(route.examples.length, 3);
    assert.ok(route.phrases.length > 0);
    assert.equal(NAVIGABLE_ROUTES.includes(route.route), route.navigationKind === "static");
  }
  assert.equal(APP_DESTINATIONS.filter((r) => r.navigationKind === "record").length, 4);
  assert.equal(APP_DESTINATIONS.filter((r) => r.access === "signed-in").length, 19);
  assert.equal(APP_DESTINATIONS.filter((r) => r.access === "platform-admin").length, 1);
});

test("every settings section is a static destination; no tab template remains", () => {
  const routes = new Set(APP_DESTINATIONS.map((d) => d.route));
  assert.ok(!routes.has("/settings/[tab]"), "tab template is expanded, not listed");
  for (const section of ["account", "voice", "workspace", "services", "appearance"]) {
    const destination = APP_DESTINATIONS.find((d) => d.route === `/settings/${section}`);
    assert.ok(destination, `manifest covers /settings/${section}`);
    assert.equal(destination.navigationKind, "static");
    assert.equal(destination.access, "signed-in");
    assert.ok(NAVIGABLE_ROUTES.includes(`/settings/${section}`), `voice may navigate to /settings/${section}`);
  }
});

test("operator navigation is offered only with observable authorization", () => {
  assert.ok(!renderAppGuide().includes("Platform operator (/operator"));
  assert.ok(renderAppGuide(true).includes("Platform operator (/operator"));
  assert.equal(matchNavIntent("open the operator area", "/dashboard"), null);
  assert.equal(matchNavIntent("open the operator area", "/dashboard", true), "/operator");
});


test("wake phrase strips leading Hi Michael", () => {
  assert.equal(stripWakePhrase("Hi, Michael open the settings page"), "open the settings page");
  assert.equal(stripWakePhrase("hey michael show my jobs"), "show my jobs");
  assert.equal(stripWakePhrase("open settings"), "open settings");
  assert.equal(stripWakePhrase("tell michael hi"), "tell michael hi");
});

test("prefix partials route before the word completes", () => {
  const top = rankNavPrefix("open settin", "/dashboard");
  assert.ok(top.length > 0 && top[0].route === "/settings", `got ${JSON.stringify(top)}`);
  const action = classifyPartialNav("Hi, Michael open the settin", "/dashboard");
  assert.ok(
    (action.action === "navigate" && action.route === "/settings") ||
      (action.action === "prefetch" && action.candidates.includes("/settings")),
    `got ${JSON.stringify(action)}`,
  );
});

test("prefix ranking keeps word-boundary guards", () => {
  assert.deepEqual(rankNavPrefix("the leaders called back", "/jobs"), []);
  assert.deepEqual(rankNavPrefix("nothing to do here", "/jobs"), []);
  assert.equal(classifyPartialNav("the leaders called back", "/jobs").action, "none");
  assert.equal(classifyPartialNav("open settings", "/jobs").action, "navigate");
});

test("bare call-it-mantra never yanks to /calls", () => {
  // Short entity word without a nav verb: no navigate, at most prefetch.
  const action = classifyPartialNav("let's call it mantra", "/agents/new");
  assert.notEqual(action.action, "navigate", `got ${JSON.stringify(action)}`);
  assert.equal(matchNavIntent("let's call it mantra", "/agents/new"), null);
  // Verb adjacency still navigates.
  assert.equal(matchNavIntent("open calls", "/agents/new"), "/calls");
  assert.equal(classifyPartialNav("open calls", "/agents").action, "navigate");
});

test("flow-locked wizard prefetches instead of navigating", () => {
  const locked = classifyPartialNav("open calls", "/agents/new", false, { flowLocked: true });
  assert.equal(locked.action, "prefetch");
  const free = classifyPartialNav("open calls", "/agents", false, { flowLocked: false });
  assert.equal(free.action, "navigate");
  assert.equal(isFlowLockedRoute("/agents/new"), true);
  assert.equal(isFlowLockedRoute("/agents"), false);
});

test("correction cue authorizes a second nav in one utterance", () => {
  assert.equal(isCorrectionRetarget("no, actually go to calls"), true);
  assert.equal(isCorrectionRetarget("let's call it mantra"), false);
});
