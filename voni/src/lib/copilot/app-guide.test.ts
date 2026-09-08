import test from "node:test";
import assert from "node:assert/strict";
import { matchNavIntent, renderAppGuide } from "./app-guide";
import {
  APP_DESTINATIONS,
  APP_FEATURE_TERMS,
  NAVIGABLE_ROUTES,
  SETTINGS_TABS_MANIFEST,
} from "./app-manifest";
import { NAV_ITEMS } from "@/components/app-sidebar";
import { SECTION_TITLES } from "@/components/app-header";
import { SETTINGS_TABS } from "@/components/settings-view";

test("guide names every destination and the voice tab", () => {
  const guide = renderAppGuide();
  assert.match(guide, /\/settings/);
  assert.match(guide, /Voice copilot/);
  assert.doesNotMatch(guide, /tap-only/);
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
    if (prefix === "/calls") continue; // no index page — voice cannot land there
    assert.ok(routes.has(prefix), `manifest covers section ${prefix}`);
  }
  assert.deepEqual(
    SETTINGS_TABS_MANIFEST.map((t) => t.label),
    SETTINGS_TABS.map((t) => t.label),
  );
});

test("partial speech routes early to settings", () => {
  assert.equal(matchNavIntent("I want to open settings", "/jobs"), "/settings");
  assert.equal(matchNavIntent("open settings then voice control", "/dashboard"), "/settings");
  assert.equal(matchNavIntent("take me to the voice copilot", "/agents"), "/settings");
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
});

test("manifest v2 covers all 16 pages without navigating to templates or public routes", () => {
  assert.equal(APP_DESTINATIONS.length, 16);
  for (const route of APP_DESTINATIONS) {
    assert.equal(route.examples.length, 3);
    assert.ok(route.phrases.length > 0);
    assert.equal(NAVIGABLE_ROUTES.includes(route.route), route.navigationKind === "static");
  }
  assert.equal(APP_DESTINATIONS.filter((r) => r.navigationKind === "record").length, 4);
});
