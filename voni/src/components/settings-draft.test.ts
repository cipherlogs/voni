import test from "node:test";
import assert from "node:assert/strict";
import {
  isVoiceDirty,
  isWorkspaceDirty,
  settingsDraftKey,
} from "./settings-draft";

test("voice dirty when either field differs from saved prefs", () => {
  const saved = { voiceId: "ivy", language: "auto" };
  assert.equal(isVoiceDirty(saved, saved), false);
  assert.equal(isVoiceDirty({ voiceId: "alba", language: "auto" }, saved), true);
  assert.equal(isVoiceDirty({ voiceId: "ivy", language: "en" }, saved), true);
});

test("workspace dirty when any field differs from saved settings", () => {
  const saved = { name: "Main workspace", timezone: "Asia/Dubai", humanTransferNumber: "" };
  assert.equal(isWorkspaceDirty(saved, saved), false);
  assert.equal(isWorkspaceDirty({ ...saved, name: "Main workspace 2" }, saved), true);
  assert.equal(isWorkspaceDirty({ ...saved, timezone: "Europe/London" }, saved), true);
  assert.equal(
    isWorkspaceDirty({ ...saved, humanTransferNumber: "+971501234567" }, saved),
    true,
  );
});

test("draft keys are namespaced per section", () => {
  assert.equal(settingsDraftKey("voice"), "voni:settings:voice-draft");
  assert.equal(settingsDraftKey("workspace"), "voni:settings:workspace-draft");
  assert.notEqual(settingsDraftKey("voice"), settingsDraftKey("workspace"));
});
