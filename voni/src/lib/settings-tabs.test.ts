import test from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_TABS, settingsHashTarget } from "./settings-tabs";

test("every tab value resolves from its own hash", () => {
  for (const tab of SETTINGS_TABS) {
    assert.equal(settingsHashTarget(`#${tab.value}`), tab.value);
  }
});

test("hash matching trims and ignores case", () => {
  assert.equal(settingsHashTarget("#Voice"), "voice");
  assert.equal(settingsHashTarget("#services "), "services");
});

test("unknown, empty, and non-tab hashes resolve to null", () => {
  assert.equal(settingsHashTarget("#bogus"), null);
  assert.equal(settingsHashTarget("#"), null);
  assert.equal(settingsHashTarget(""), null);
  // Externals are real routes, never hashes.
  assert.equal(settingsHashTarget("#numbers"), null);
  assert.equal(settingsHashTarget("#operator"), null);
});
