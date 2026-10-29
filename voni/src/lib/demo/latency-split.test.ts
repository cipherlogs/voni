/**
 * Behaviour of the per-turn latency split (demo-latency ticket 02): one Call
 * trace turn plus that turn's client receipt marks and the call's one clock
 * anchor, yielding the three waits, the interaction band and the report-only
 * caller-perceived number.
 *
 * Fixtures are crafted turns and marks, the prior art of the scoreboard gate
 * tests: expected values are worked through by hand on both clocks, never
 * recomputed the way the implementation does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { latencySplit, type LatencySplitInput } from "./latency-split";

/** The anchor's call-relative and Call-trace instants. Offset = server - client. */
const ANCHOR_SERVER_MS = 1_700_000_000_000;
const ANCHOR_CLIENT_MS = 5_000;
const OFFSET_MS = ANCHOR_SERVER_MS - ANCHOR_CLIENT_MS;

/** Client receipt of a server instant, so a fixture can move the clock offset. */
const receiptOf = (serverMs: number, offsetMs = OFFSET_MS) => serverMs - offsetMs;

type Fixture = {
  speechStartedMs: number;
  speechEndedMs: number;
  userFinalMs: number;
  replyStartMs: number;
  firstAudioMs: number;
  previousReplyEndedMs: number | null;
};

/** A worked turn: endpointing 300ms, generation 200ms, delivery 120ms. */
const ordinary: Fixture = {
  speechStartedMs: ANCHOR_SERVER_MS - 2_500,
  speechEndedMs: ANCHOR_SERVER_MS - 2_000,
  userFinalMs: ANCHOR_SERVER_MS - 1_700,
  replyStartMs: ANCHOR_SERVER_MS - 1_500,
  firstAudioMs: ANCHOR_SERVER_MS - 1_380,
  previousReplyEndedMs: ANCHOR_SERVER_MS - 3_000,
};

function input(fixture: Fixture, { offsetMs = OFFSET_MS } = {}): LatencySplitInput {
  const clientAnchorMs = ANCHOR_SERVER_MS - offsetMs;
  return {
    turn: {
      user_speech_started_at_ms: fixture.speechStartedMs,
      user_speech_ended_at_ms: fixture.speechEndedMs,
    },
    previousReply:
      fixture.previousReplyEndedMs === null ? null : { endedAtMs: fixture.previousReplyEndedMs },
    marks: {
      userFinalAtMs: receiptOf(fixture.userFinalMs, offsetMs),
      replyStartAtMs: receiptOf(fixture.replyStartMs, offsetMs),
      firstAudioAtMs: receiptOf(fixture.firstAudioMs, offsetMs),
    },
    anchor: { clientAtMs: clientAnchorMs, serverAtMs: ANCHOR_SERVER_MS },
  };
}

test("a caller turn that started after the previous reply ended is ordinary", () => {
  const split = latencySplit(input(ordinary));

  assert.deepEqual(split, {
    endpointingMs: 300,
    generationMs: 200,
    deliveryMs: 120,
    band: "ordinary",
    perceivedMs: 1_120,
  });
});

test("a caller turn that began while the previous reply was still sounding is post-cut", () => {
  // The whole turn is 2.6s earlier, so the waits are unchanged; the previous
  // reply is interrupted 400ms after the caller started talking.
  const shiftMs = -2_600;
  const fixture = {
    speechStartedMs: ordinary.speechStartedMs + shiftMs,
    speechEndedMs: ordinary.speechEndedMs + shiftMs,
    userFinalMs: ordinary.userFinalMs + shiftMs,
    replyStartMs: ordinary.replyStartMs + shiftMs,
    firstAudioMs: ordinary.firstAudioMs + shiftMs,
    previousReplyEndedMs: ordinary.speechStartedMs + shiftMs + 400,
  };

  const split = latencySplit(input(fixture));

  assert.equal(split?.band, "post-cut");
  // Same arithmetic: the band never changes a duration.
  assert.deepEqual(split, {
    endpointingMs: 300,
    generationMs: 200,
    deliveryMs: 120,
    band: "post-cut",
    perceivedMs: 1_120,
  });
});

test("a turn with no previous reply is ordinary", () => {
  const split = latencySplit(input({ ...ordinary, previousReplyEndedMs: null }));

  assert.equal(split?.band, "ordinary");
});

test("a missing required mark yields no sample, never a zero or a partial split", () => {
  const complete = input(ordinary);
  const without = [
    ["caller end of speech", { ...complete, turn: { ...complete.turn, user_speech_ended_at_ms: null } }],
    ["caller speech start", { ...complete, turn: { ...complete.turn, user_speech_started_at_ms: undefined } }],
    ["final caller transcript receipt", { ...complete, marks: { ...complete.marks, userFinalAtMs: undefined } }],
    ["reply-start receipt", { ...complete, marks: { ...complete.marks, replyStartAtMs: null } }],
    ["first audio receipt", { ...complete, marks: { ...complete.marks, firstAudioAtMs: NaN } }],
    ["anchor client instant", { ...complete, anchor: { ...complete.anchor, clientAtMs: undefined } }],
    ["anchor server instant", { ...complete, anchor: { ...complete.anchor, serverAtMs: null } }],
  ] as const;

  for (const [mark, sample] of without) {
    assert.equal(latencySplit(sample as unknown as LatencySplitInput), null, `missing ${mark}`);
  }
});

test("a previous reply with no end mark cannot be classified, so it yields no sample", () => {
  const sample = input(ordinary);
  sample.previousReply = { endedAtMs: null };

  assert.equal(latencySplit(sample), null);
});

test("the anchor reconciles the two clocks once: a non-zero offset yields the same true durations", () => {
  // The same call instants, read by a client whose clock is a day behind.
  const shifted = input(ordinary, { offsetMs: 86_400_000 + OFFSET_MS });

  assert.deepEqual(latencySplit(shifted), latencySplit(input(ordinary)));
  assert.deepEqual(latencySplit(shifted), {
    endpointingMs: 300,
    generationMs: 200,
    deliveryMs: 120,
    band: "ordinary",
    perceivedMs: 1_120,
  });
});

test("the playback pre-roll is added only to perceived, never to delivery", () => {
  const split = latencySplit(input(ordinary))!;

  assert.equal(split.deliveryMs, 120);
  // The worklet's fixed 500ms pre-roll (public/playout-processor.js) is what
  // the caller hears on top of the measured waits.
  assert.equal(split.perceivedMs - (split.endpointingMs + split.generationMs + split.deliveryMs), 500);
  assert.equal(split.perceivedMs, 1_120);
});
