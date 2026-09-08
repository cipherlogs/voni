import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireMic,
  currentMicOwner,
  releaseMic,
  resetMicOwnerForTests,
} from "./mic-owner";

test("mic ownership is exclusive until released", () => {
  resetMicOwnerForTests();
  assert.equal(acquireMic("voice-call"), true);
  assert.equal(acquireMic("copilot"), false);
  assert.equal(currentMicOwner(), "voice-call");
  // A stranger cannot release someone else's hold.
  releaseMic("copilot");
  assert.equal(currentMicOwner(), "voice-call");
  releaseMic("voice-call");
  assert.equal(currentMicOwner(), null);
  assert.equal(acquireMic("copilot"), true);
  releaseMic("copilot");
});

test("re-acquiring with the same id is idempotent", () => {
  resetMicOwnerForTests();
  assert.equal(acquireMic("copilot"), true);
  assert.equal(acquireMic("copilot"), true);
  releaseMic("copilot");
  assert.equal(currentMicOwner(), null);
});
