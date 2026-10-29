import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvalEventWriter, readEvalEvents } from "./eval-events";
import { createCallTurnMarks, createTurnMarks } from "./turn-marks";

const dir = () => mkdtempSync(join(tmpdir(), "turn-marks-"));

function stream() {
  const path = join(dir(), "events.jsonl");
  const writer = createEvalEventWriter(path, { startedAtMs: 0, now: () => 0 });
  return { path, marks: createTurnMarks(writer) };
}

test("a caller turn and its reply share one turn id across the three receipt marks", () => {
  const { path, marks } = stream();
  marks.observe(
    { type: "transcript.user", item_id: "item_1", text: "My email is caller at example dot com" },
    { sessionId: "sess_a", atMs: 1_200 },
  );
  marks.observe({ type: "reply.started", reply_id: "r1" }, { sessionId: "sess_a", atMs: 1_450 });
  marks.observe(
    { type: "reply.audio", reply_id: "r1", data: "AAECAwQFBgc=" },
    { sessionId: "sess_a", atMs: 1_500 },
  );

  const events = readEvalEvents(path);
  assert.deepEqual(events, [
    { atMs: 1_200, type: "turn.user_final", sessionId: "sess_a", turnId: "turn-1", callMs: 1_200 },
    { atMs: 1_450, type: "turn.reply_start", sessionId: "sess_a", turnId: "turn-1", replyId: "r1", callMs: 1_450 },
    {
      atMs: 1_500,
      type: "reply.first_audio",
      sessionId: "sess_a",
      turnId: "turn-1",
      replyId: "r1",
      callMs: 1_500,
      anchor: true,
    },
  ]);
  // The receipt marks never carry the caller's words or the audio payload.
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(text, /caller at example/);
  assert.doesNotMatch(text, /AAECAwQFBgc/);
});

test("exactly one call-level anchor is emitted: the first measured turn's first audio", () => {
  const { path, marks } = stream();
  for (const [turn, reply] of [
    ["t1", "r1"],
    ["t2", "r2"],
  ] as const) {
    marks.observe({ type: "transcript.user", item_id: turn }, { sessionId: "sess_a", atMs: 1_000 });
    marks.observe({ type: "reply.started", reply_id: reply }, { sessionId: "sess_a", atMs: 1_100 });
    marks.observe({ type: "reply.audio", reply_id: reply }, { sessionId: "sess_a", atMs: 1_200 });
  }
  const events = readEvalEvents(path);
  const anchors = events.filter((event) => event.anchor === true);
  assert.equal(anchors.length, 1);
  assert.deepEqual(
    anchors.map((event) => ({ type: event.type, turnId: event.turnId, replyId: event.replyId, callMs: event.callMs })),
    [{ type: "reply.first_audio", turnId: "turn-1", replyId: "r1", callMs: 1_200 }],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "reply.first_audio").map((event) => event.turnId),
    ["turn-1", "turn-2"],
  );
});

test("missing marks are omitted, never synthesized", () => {
  const { path, marks } = stream();
  // Greeting audio: no caller turn to correlate, but the first-audio receipt is real.
  marks.observe({ type: "reply.audio", reply_id: "greeting" }, { sessionId: "sess_a", atMs: 200 });
  // An agent-initiated reply (check-in) with no pending caller turn: no turn mark.
  marks.observe({ type: "reply.started", reply_id: "checkin" }, { sessionId: "sess_a", atMs: 250 });
  assert.equal(marks.observe({ type: "reply.started", reply_id: "checkin" }, { sessionId: "sess_a", atMs: 260 }), null);
  // A caller turn whose reply never starts: only the transcript receipt exists.
  marks.observe({ type: "transcript.user", item_id: "item_1" }, { sessionId: "sess_a", atMs: 1_000 });
  // A repeat chunk of the greeting is not a new first-audio mark.
  marks.observe({ type: "reply.audio", reply_id: "greeting" }, { sessionId: "sess_a", atMs: 1_100 });

  assert.deepEqual(readEvalEvents(path), [
    { atMs: 200, type: "reply.first_audio", sessionId: "sess_a", replyId: "greeting", callMs: 200 },
    { atMs: 1_000, type: "turn.user_final", sessionId: "sess_a", turnId: "turn-1", callMs: 1_000 },
  ]);
});

test("a turn measured after an uncorrelated reply still carries the one anchor", () => {
  const { path, marks } = stream();
  marks.observe({ type: "reply.audio", reply_id: "greeting" }, { sessionId: "sess_a", atMs: 100 });
  marks.observe({ type: "transcript.user", item_id: "item_1" }, { sessionId: "sess_a", atMs: 1_000 });
  marks.observe({ type: "reply.started", reply_id: "r1" }, { sessionId: "sess_a", atMs: 1_100 });
  marks.observe({ type: "reply.audio", reply_id: "r1" }, { sessionId: "sess_a", atMs: 1_250 });

  const events = readEvalEvents(path);
  assert.equal(events.filter((event) => event.anchor === true).length, 1);
  assert.equal(events.find((event) => event.anchor === true)?.turnId, "turn-1");
});

test("a disabled stream records nothing", () => {
  const marks = createTurnMarks(createEvalEventWriter(null));
  assert.equal(marks.enabled, false);
  assert.equal(marks.observe({ type: "transcript.user" }, { sessionId: "sess_a", atMs: 1 }), null);
  assert.equal(marks.observe({ type: "reply.started", reply_id: "r1" }, { sessionId: "sess_a", atMs: 2 }), null);
  assert.equal(marks.observe({ type: "reply.audio", reply_id: "r1" }, { sessionId: "sess_a", atMs: 3 }), null);
});

test("the call helper reads the call context when the mark fires and rounds to whole ms", () => {
  const path = join(dir(), "events.jsonl");
  const writer = createEvalEventWriter(path, { startedAtMs: 0, now: () => 0 });
  let sessionId: string | null = "sess_a";
  let elapsedMs = 1_234.6;
  const mark = createCallTurnMarks(writer, () => ({ sessionId, atMs: elapsedMs }));
  mark({ type: "transcript.user" });
  sessionId = null;
  elapsedMs = 1_500.2;
  mark({ type: "reply.started", reply_id: "r1" });
  assert.deepEqual(readEvalEvents(path), [
    { atMs: 1_235, type: "turn.user_final", sessionId: "sess_a", turnId: "turn-1", callMs: 1_235 },
    { atMs: 1_500, type: "turn.reply_start", sessionId: null, turnId: "turn-1", replyId: "r1", callMs: 1_500 },
  ]);
});

test("the call helper is a no-op when the stream is off", () => {
  const mark = createCallTurnMarks(createEvalEventWriter(null), () => ({ sessionId: "sess_a", atMs: 1 }));
  assert.equal(mark({ type: "transcript.user" }), null);
});
