import assert from "node:assert/strict";
import test from "node:test";

import {
  CopilotContext,
  createIdleCopilotValue,
  getEngineValue,
  publishEngineValue,
  subscribeEngineValue,
} from "./copilot-context.js";

// Shell review fix: the synchronous provider boundary renders children
// immediately under idle defaults while the engine chunk loads beside them,
// then swaps idle → live on the same boundary (re-render, never remount).
// Seams under test (light context module, imported for real — no jsdom):
// - Idle contract: inert first-paint value with the full live shape.
//   Catches a shape drift that would crash sidebar/page readers before the
//   engine lands; misses visual output (unchanged by construction).
// - Upgrade slot: the boot probe publishes the live value and subscribers
//   are notified. Catches a broken handoff (engine loaded but shell stuck
//   idle); misses chunk timing (runtime check + build comparison).

test("idle defaults carry the full live shape without touching the engine", () => {
  let needs = 0;
  const idle = createIdleCopilotValue(() => {
    needs += 1;
  });

  assert.equal(idle.status, "idle", "first paint reads idle");
  assert.equal(idle.error, null, "no error at rest");
  assert.equal(idle.live, false, "not live before the engine lands");
  assert.deepEqual(idle.captions, [], "no captions at rest");
  assert.deepEqual(idle.proposals, [], "no proposals at rest");
  assert.equal(idle.userPartial, null, "no partial at rest");
  assert.equal(idle.agentPartial, null, "no agent partial at rest");
  assert.equal(idle.micMuted, false, "mic unmuted at rest");
  assert.equal(idle.speakerMuted, false, "speaker unmuted at rest");
  assert.equal(idle.toolActive, false, "no tool running at rest");
  assert.equal(idle.sessionSeconds, null, "no session clock at rest");
  assert.equal(idle.sessionId, null, "no session id at rest");

  // Inert calls never throw and only warm the engine chunk.
  assert.doesNotThrow(() => idle.start(), "start only warms the chunk");
  assert.equal(needs, 1, "start requests the engine");
  assert.doesNotThrow(() => idle.registerRoute("r", {} as never), "register only warms the chunk");
  assert.equal(needs, 2, "registration requests the engine");
  assert.doesNotThrow(() => {
    idle.stop();
    idle.toggleMicMute();
    idle.toggleSpeakerMute();
    idle.applyTap("x");
    idle.dismissTap("x");
    idle.noteInteraction();
    idle.unregisterRoute("r");
  }, "inert controls never throw");

  // Helpers stay shaped so pre-load callers cannot crash on undefined.
  assert.deepEqual(
    idle.proposeChange({} as never, {} as never),
    { proposal_id: "", summary: "" },
    "proposeChange stays shaped",
  );
  const undo = idle.proposeUndo({} as never);
  assert.equal(undo.ok, false, "idle undo reports not-ok");
  assert.match(undo.error ?? "", /loading/, "idle undo explains itself");
});

test("the upgrade slot hands the live value to subscribers without remounting", () => {
  assert.equal(getEngineValue(), null, "slot starts empty (idle first paint)");
  assert.ok(CopilotContext.Provider, "light context boundary stays");

  let notifications = 0;
  const unsubscribe = subscribeEngineValue(() => {
    notifications += 1;
  });
  try {
    const live = createIdleCopilotValue();
    publishEngineValue(live);
    assert.equal(getEngineValue(), live, "probe publishes the live value");
    assert.equal(notifications, 1, "shell is notified to re-render");

    // Same identity republishes are no-ops: no render churn after load.
    publishEngineValue(live);
    assert.equal(notifications, 1, "identical publish does not notify");

    publishEngineValue(null);
    assert.equal(getEngineValue(), null, "slot clears on probe unmount");
    assert.equal(notifications, 2, "shell is notified of the clear");
  } finally {
    publishEngineValue(null);
    unsubscribe();
  }
});
