import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { ReplyQueue, StakesLadder, REPLY_GRACE_MS } from "./stakes-ladder";

test("three off-track turns climb nudge, warning, end", () => {
  const ladder = new StakesLadder();
  assert.equal(ladder.onVerdict(false), null, "on-track turns never climb");
  assert.equal(ladder.onVerdict(true), "nudge");
  assert.equal(ladder.onVerdict(false), null);
  assert.equal(ladder.onVerdict(true), "warning", "strikes are cumulative");
  assert.equal(ladder.onVerdict(true), "end");
  assert.equal(ladder.onVerdict(true), null, "nothing past the end");
  assert.equal(ladder.strikes, 3);
});

test("queued instructions wait for the agent's current reply to finish", () => {
  const delivered: string[] = [];
  const queue = new ReplyQueue((text) => delivered.push(text));
  queue.onReplyStarted();
  queue.enqueue("nudge");
  assert.deepEqual(delivered, []);
  queue.onReplyDone();
  assert.deepEqual(delivered, ["nudge"]);
  queue.onReplyDone();
  assert.deepEqual(delivered, ["nudge"], "delivered once");
});

test("when idle, a short grace lets the reply to the judged turn start first", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const delivered: string[] = [];
    const queue = new ReplyQueue((text) => delivered.push(text));
    queue.enqueue("warning");
    queue.onReplyStarted(); // the agent's answer to the off-track turn
    mock.timers.tick(REPLY_GRACE_MS);
    assert.deepEqual(delivered, [], "never talks over a live reply");
    queue.onReplyDone();
    assert.deepEqual(delivered, ["warning"]);

    queue.enqueue("check-in");
    mock.timers.tick(REPLY_GRACE_MS);
    assert.deepEqual(delivered, ["warning", "check-in"], "idle: delivered after grace");
  } finally {
    mock.timers.reset();
  }
});

test("caller speech holds delivery until the agent answers them", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const delivered: string[] = [];
    const queue = new ReplyQueue((text) => delivered.push(text));
    queue.enqueue("warning");
    queue.onCallerSpeech();
    mock.timers.tick(REPLY_GRACE_MS);
    assert.deepEqual(delivered, [], "never talks over the caller");
    queue.onReplyStarted();
    queue.onReplyDone();
    assert.deepEqual(delivered, ["warning"]);
  } finally {
    mock.timers.reset();
  }
});

test("a newer instruction replaces an undelivered one", () => {
  const delivered: string[] = [];
  const queue = new ReplyQueue((text) => delivered.push(text));
  queue.onReplyStarted();
  queue.enqueue("nudge");
  queue.enqueue("warning");
  queue.onReplyDone();
  assert.deepEqual(delivered, ["warning"]);
});

test("clear drops anything pending", () => {
  const delivered: string[] = [];
  const queue = new ReplyQueue((text) => delivered.push(text));
  queue.onReplyStarted();
  queue.enqueue("nudge");
  queue.clear();
  queue.onReplyDone();
  assert.deepEqual(delivered, []);
});
