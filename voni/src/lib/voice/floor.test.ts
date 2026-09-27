import test from "node:test";
import assert from "node:assert/strict";
import { CALLER_ANSWER_WAIT_MS, Floor } from "./floor";

function rig() {
  let now = 0;
  let settled = true;
  let toolBusy = false;
  let socketUp = true;
  const sent: string[] = [];
  const floor = new Floor({
    send: (instructions) => {
      if (!socketUp) return false;
      sent.push(instructions);
      return true;
    },
    settled: () => settled,
    toolBusy: () => toolBusy,
    now: () => now,
  });
  return {
    floor,
    sent,
    advance: (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        now += 100;
        floor.tick();
      }
    },
    setSettled: (v: boolean) => (settled = v),
    setToolBusy: (v: boolean) => (toolBusy = v),
    setSocketUp: (v: boolean) => (socketUp = v),
  };
}

test("a line goes out at once on a free floor, one at a time", () => {
  const { floor, sent, advance } = rig();
  floor.speak({ instructions: "A" });
  floor.speak({ instructions: "B" });
  assert.deepEqual(sent, ["A"]);
  advance(1000);
  assert.deepEqual(sent, ["A"], "B waits for A's reply");
  floor.replyStarted();
  floor.replyDone(false);
  advance(100);
  assert.deepEqual(sent, ["A", "B"]);
});

test("never while a reply plays, audio is still sounding, or the caller talks", () => {
  const { floor, sent, advance, setSettled } = rig();
  floor.replyStarted();
  floor.speak({ instructions: "note" });
  advance(2000);
  assert.deepEqual(sent, []);
  floor.replyDone(false);
  setSettled(false); // the last words still play out
  advance(1000);
  assert.deepEqual(sent, []);
  floor.callerSpeechStarted();
  setSettled(true);
  advance(1000);
  assert.deepEqual(sent, [], "the caller is speaking");
  floor.callerWords();
  floor.callerTurnDone();
  advance(CALLER_ANSWER_WAIT_MS - 200);
  assert.deepEqual(sent, [], "the platform's answer to them may be starting");
  advance(400);
  assert.deepEqual(sent, ["note"], "they said something the platform didn't answer");
});

test("a tool call holds the floor until the platform's reply to its result is done (the lost reveal)", () => {
  // sess_aacaf… 164s: check_code ran, a note went out, and the reveal was lost.
  const { floor, sent, advance, setToolBusy } = rig();
  floor.replyStarted();
  floor.toolCalled();
  setToolBusy(true);
  floor.replyDone(false); // the silent tool-call reply ends before the result
  floor.speak({ instructions: "welcome back" });
  advance(3000);
  assert.deepEqual(sent, [], "the result is still running");
  setToolBusy(false);
  floor.toolResultSent();
  advance(500);
  assert.deepEqual(sent, [], "the reveal is about to start");
  floor.replyStarted(); // the platform speaks the reveal
  advance(3000);
  floor.replyDone(false);
  advance(100);
  assert.deepEqual(sent, ["welcome back"], "only after the reveal");
});

test("a keyed line replaces the waiting one: never said twice", () => {
  const { floor, sent, advance } = rig();
  floor.replyStarted();
  floor.speak({ instructions: "invite 1", key: "invite" });
  floor.speak({ instructions: "invite 2", key: "invite" });
  floor.replyDone(false);
  advance(100);
  floor.replyStarted();
  floor.replyDone(false);
  advance(1000);
  assert.deepEqual(sent, ["invite 2"]);
});

test("our line cut by the caller for real is said again, whole; a check-in is not", () => {
  const { floor, sent, advance } = rig();
  floor.speak({ instructions: "found it" });
  floor.replyStarted();
  floor.callerSpeechStarted();
  floor.replyDone(true);
  floor.requeueCut();
  advance(1000);
  assert.deepEqual(sent, ["found it"], "not over the caller");
  floor.replyStarted(); // the platform answers them
  floor.replyDone(false);
  advance(100);
  assert.deepEqual(sent, ["found it", "found it"]);

  const other = rig();
  other.floor.speak({ instructions: "still there?", droppable: true });
  other.floor.replyStarted();
  other.floor.replyDone(true);
  other.floor.requeueCut();
  other.advance(5000);
  assert.deepEqual(other.sent, ["still there?"]);
});

test("a line refused between sockets waits and goes when the socket is back", () => {
  const { floor, sent, advance, setSocketUp } = rig();
  setSocketUp(false);
  floor.speak({ instructions: "note" });
  advance(500);
  assert.deepEqual(sent, []);
  setSocketUp(true);
  advance(100);
  assert.deepEqual(sent, ["note"]);
});

test("a sent line that never starts frees the floor, and is never sent twice", () => {
  const { floor, sent, advance } = rig();
  floor.speak({ instructions: "note" });
  floor.speak({ instructions: "next" });
  advance(4100);
  assert.deepEqual(sent, ["note", "next"]);
});

test("silence check-in: once after 15s of free floor, re-armed only by the caller", () => {
  const { floor, sent, advance, setToolBusy } = rig();
  let allowed = true;
  floor.setSilenceCheckIn({ afterMs: 15_000, instructions: "Still with me?", allowed: () => allowed });
  advance(14_000);
  assert.deepEqual(sent, []);
  advance(1100);
  assert.deepEqual(sent, ["Still with me?"]);
  floor.replyStarted();
  floor.replyDone(false);
  advance(30_000);
  assert.deepEqual(sent, ["Still with me?"], "once per silent stretch");

  floor.callerSpeechStarted();
  floor.callerTurnDone();
  floor.replyStarted();
  floor.replyDone(false);
  setToolBusy(true); // a tool runs: not silence
  advance(20_000);
  assert.deepEqual(sent.length, 1);
  setToolBusy(false);
  allowed = false; // muted
  advance(20_000);
  assert.deepEqual(sent.length, 1);
  allowed = true;
  advance(14_000);
  assert.deepEqual(sent.length, 1, "the clock restarts after the mute");
  advance(1100);
  assert.deepEqual(sent, ["Still with me?", "Still with me?"]);
});

test("the check-in never lands on a caller who just started talking", () => {
  const { floor, sent, advance } = rig();
  floor.setSilenceCheckIn({ afterMs: 15_000, instructions: "Still with me?", allowed: () => true });
  advance(14_900);
  floor.callerSpeechStarted();
  advance(2000);
  assert.deepEqual(sent, []);
});

test("a long sentence with sparse partials holds the floor until speech stops", () => {
  const { floor, sent, advance } = rig();
  floor.callerSpeechStarted();
  floor.callerWords();
  floor.speak({ instructions: "email landed" });
  advance(9000); // 9s of talking, no partial for 4s at a time
  assert.deepEqual(sent, []);
  floor.callerSpeechStopped();
  advance(CALLER_ANSWER_WAIT_MS + 200);
  assert.deepEqual(sent, ["email landed"], "they stopped and the platform didn't answer");
});
