import test from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_TABS } from "./settings-tabs";
import { SETTINGS_TILES, type SettingsTabValue } from "./settings-tiles";

test("every tab has exactly one non-external tile", () => {
  const tabValues = new Set<string>(SETTINGS_TABS.map((t) => t.value));
  const internal = SETTINGS_TILES.filter((t) => !t.external);
  assert.equal(internal.length, tabValues.size);
  for (const tile of internal) {
    const value: SettingsTabValue = tile.value as SettingsTabValue;
    assert.ok(tabValues.has(value), `tile ${value} matches a tab`);
    assert.equal(tile.href, `/settings/${value}`);
  }
});

test("tiles carry unique values, labels, descriptions, and allowed icons", () => {
  const values = SETTINGS_TILES.map((t) => t.value);
  assert.equal(new Set(values).size, values.length);
  const icons = new Set(["user", "mic", "building", "plug", "sun", "phone", "shield"]);
  for (const tile of SETTINGS_TILES) {
    assert.ok(tile.label.trim().length > 0);
    assert.ok(tile.description.trim().length > 0);
    assert.ok(tile.cta.trim().length > 0, `tile ${tile.value} names its action`);
    assert.ok(icons.has(tile.icon), `tile ${tile.value} uses an allowed icon key`);
    assert.ok(tile.span === "standard" || tile.span === "hero");
  }
});

test("externals are real routes and admin-only implies external", () => {
  const externals = SETTINGS_TILES.filter((t) => t.external);
  assert.deepEqual(
    externals.map((t) => t.href).sort(),
    ["/numbers", "/operator"],
  );
  for (const tile of SETTINGS_TILES) {
    if (tile.adminOnly) assert.ok(tile.external, `admin-only tile ${tile.value} must be external`);
  }
  const operator = SETTINGS_TILES.find((t) => t.value === "operator");
  assert.ok(operator?.adminOnly, "operator tile is admin-gated");
});

test("v1 heroes are voice and services", () => {
  const heroes = SETTINGS_TILES.filter((t) => t.span === "hero").map((t) => t.value).sort();
  assert.deepEqual(heroes, ["services", "voice"]);
});

test("bgKinds are exactly the seven approved scene-round-2 kinds", () => {
  const kinds = SETTINGS_TILES.map((t) => t.bgKind).sort();
  assert.deepEqual(kinds, [
    "constellation",
    "control",
    "horizon",
    "incoming",
    "lanes",
    "orbit",
    "spine",
  ]);
});

test("every tile maps its bgKind to a distinct scene", () => {
  const byKind = new Map(SETTINGS_TILES.map((t) => [t.bgKind, t.value]));
  assert.equal(byKind.size, SETTINGS_TILES.length);
  assert.equal(byKind.get("constellation"), "services");
  assert.equal(byKind.get("lanes"), "voice");
});
