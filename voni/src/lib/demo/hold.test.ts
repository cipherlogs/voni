import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHoldCarryover,
  CALL_MEMORY_KEY,
  clearCallMemory,
  decideHoldReturn,
  HOLD_CAP_S,
  HoldState,
  loadCallMemory,
  RESUME_GRACE_MS,
  saveCallMemory,
  shouldParkOnDrop,
  shouldRejoinAfterHold,
  type CallMemorySnapshot,
  type HoldReturn,
  type HoldSessionStatus,
} from "./hold";

const secToMs = (seconds: number) => seconds * 1000;

test("hidden enters hold, visible exits with the held duration", () => {
  const hold = new HoldState();
  assert.equal(hold.holding, false);
  assert.equal(hold.enter(secToMs(10)), true, "first enter reports new");
  assert.equal(hold.holding, true);
  assert.equal(hold.holdSeconds(secToMs(40)), 30);
  assert.equal(hold.exit(secToMs(40)), 30000);
  assert.equal(hold.holding, false);
});

test("double enter and stray exit are no-ops", () => {
  const hold = new HoldState();
  assert.equal(hold.exit(secToMs(5)), null, "exit while idle");
  hold.enter(secToMs(10));
  assert.equal(hold.enter(secToMs(20)), false, "already holding");
  assert.equal(hold.holdSeconds(secToMs(30)), 20, "first enter wins");
  hold.exit(secToMs(30));
});

test("hold expires at the cap", () => {
  const hold = new HoldState();
  hold.enter(0);
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S - 1)), false);
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S)), true);
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S + 60)), true);
});

test("idle hold never expires", () => {
  const hold = new HoldState();
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S + 60)), false);
  assert.equal(hold.holdSeconds(secToMs(999)), 0);
});

test("re-enter after exit starts a fresh stretch", () => {
  const hold = new HoldState();
  hold.enter(secToMs(0));
  hold.exit(secToMs(30));
  assert.equal(hold.isExpired(secToMs(HOLD_CAP_S)), false, "old stretch does not linger");
  hold.enter(secToMs(100));
  assert.equal(hold.holdSeconds(secToMs(130)), 30);
});

test("carryover context keeps newest turns and says where to resume", () => {
  const context = buildHoldCarryover([
    { role: "user", text: "My favorite color is blue." },
    { role: "agent", text: "Blue, noted. What does your business do?" },
  ]);
  assert.match(context, /blue/i);
  assert.match(context, /business/i);
  assert.match(context, /do not start over/i);
});

test("carryover with no turns is still a resume cue", () => {
  const context = buildHoldCarryover([]);
  assert.match(context, /resumed|reconnected/i);
});

test("carryover truncates oldest first under the budget", () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({
    role: "user" as const,
    text: `Turn number ${i} with some padding words to fill the budget.`,
  }));
  const context = buildHoldCarryover(turns, 300);
  assert.ok(context.length <= 600, `got ${context.length}`);
  assert.match(context, /Turn number 19/, "newest survives");
  assert.doesNotMatch(context, /Turn number 0/, "oldest is cut");
});

test("a failed resume after a hold return rejoins on transport failure", () => {
  // 1008 refusal, exhausted attempts, resume-fetch failure: the old
  // transport is terminally gone, so restart it with carried context.
  assert.equal(shouldRejoinAfterHold(true, "expired"), true);
  assert.equal(shouldRejoinAfterHold(true, "network"), true);
});

test("a failed resume after a hold return still shows real errors", () => {
  // Mic, auth, config, and rate-limit failures need the visitor to act —
  // a silent restart would loop or strand them.
  assert.equal(shouldRejoinAfterHold(true, "mic"), false);
  assert.equal(shouldRejoinAfterHold(true, "busy-mic"), false);
  assert.equal(shouldRejoinAfterHold(true, "auth"), false);
  assert.equal(shouldRejoinAfterHold(true, "config"), false);
  assert.equal(shouldRejoinAfterHold(true, undefined), false);
});

test("no hold return pending means no silent rejoin, ever", () => {
  assert.equal(shouldRejoinAfterHold(false, "expired"), false);
  assert.equal(shouldRejoinAfterHold(false, "network"), false);
});

test("return from hold: one path per away time and session state", () => {
  const cap = secToMs(HOLD_CAP_S);
  const rows: Array<[string, { heldMs: number; status: HoldSessionStatus; droppedMs?: number }, HoldReturn]> = [
    ["frozen page, socket survived", { heldMs: 5000, status: "live" }, "unhold"],
    ["auto-resume already in flight", { heldMs: 5000, status: "reconnecting" }, "await"],
    ["dropped while hidden, back inside grace", { heldMs: 20000, status: "parked", droppedMs: 20000 }, "resume"],
    ["dropped while hidden, grace boundary", { heldMs: 30000, status: "parked", droppedMs: RESUME_GRACE_MS }, "rejoin"],
    ["dropped while hidden, back at 45s", { heldMs: 45000, status: "parked", droppedMs: 45000 }, "rejoin"],
    ["session gone (1008, exhausted, expired)", { heldMs: 10000, status: "gone" }, "rejoin"],
    ["away past the cap, live", { heldMs: cap, status: "live" }, "endCapped"],
    ["away past the cap, parked", { heldMs: cap + 1, status: "parked", droppedMs: 1000 }, "endCapped"],
    ["away past the cap, gone", { heldMs: cap * 2, status: "gone" }, "endCapped"],
    ["one tick under the cap, gone", { heldMs: cap - 1, status: "gone" }, "rejoin"],
  ];
  for (const [name, input, expected] of rows) {
    assert.equal(decideHoldReturn(input), expected, name);
  }
});

test("a drop parks only on a hidden demo page", () => {
  assert.equal(shouldParkOnDrop(true, true), true, "hidden demo: wait for the visitor");
  assert.equal(shouldParkOnDrop(true, false), false, "visible demo: auto-resume now");
  assert.equal(shouldParkOnDrop(false, true), false, "test calls never park");
});

test("one silent rejoin per return; a second terminal failure surfaces", () => {
  assert.equal(shouldRejoinAfterHold(true, "expired", false), true);
  assert.equal(shouldRejoinAfterHold(true, "expired", true), false);
  assert.equal(shouldRejoinAfterHold(true, "network", true), false);
});

test("call memory fits a whole demo call before it truncates", () => {
  // A 2-minute demo is far below 8000 chars: nothing is cut.
  const turns = Array.from({ length: 30 }, (_, i) => ({
    role: (i % 2 ? "agent" : "user") as "agent" | "user",
    text: `Line ${i}: a realistic sentence someone might say on a sales demo call.`,
  }));
  const context = buildHoldCarryover(turns);
  assert.match(context, /Line 0:/, "oldest survives by default");
  assert.match(context, /Line 29:/);
  assert.match(context, /do not re-introduce yourself/);
});

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const snapshot = (savedAt: number): CallMemorySnapshot => ({
  savedAt,
  voiceId: "anna",
  turns: [{ role: "user", text: "We sell solar panels." }],
  talkSeconds: 42,
  strikes: 1,
  sessionId: "sess_1",
});

test("call memory survives a reload inside the hold cap", () => {
  const store = memoryStore();
  saveCallMemory(snapshot(1000), store);
  const back = loadCallMemory(1000 + secToMs(60), store);
  assert.deepEqual(back, snapshot(1000));
});

test("call memory past the hold cap is dropped and cleared", () => {
  const store = memoryStore();
  saveCallMemory(snapshot(0), store);
  assert.equal(loadCallMemory(secToMs(HOLD_CAP_S), store), null);
  assert.equal(store.map.has(CALL_MEMORY_KEY), false, "stale entry cleared");
});

test("corrupt or future call memory is ignored and cleared", () => {
  const store = memoryStore();
  store.setItem(CALL_MEMORY_KEY, "{not json");
  assert.equal(loadCallMemory(0, store), null);
  assert.equal(store.map.size, 0);
  saveCallMemory(snapshot(5000), store);
  assert.equal(loadCallMemory(1000, store), null, "saved in the future (clock skew)");
});

test("call memory never throws when storage does", () => {
  const broken = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.doesNotThrow(() => saveCallMemory(snapshot(0), broken));
  assert.doesNotThrow(() => clearCallMemory(broken));
  assert.equal(loadCallMemory(0, broken), null);
  assert.equal(loadCallMemory(0, null), null, "no storage at all (SSR)");
});
