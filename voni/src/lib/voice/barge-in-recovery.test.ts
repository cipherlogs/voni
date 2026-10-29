/**
 * The unheard-tail barge-in recovery (voice-parity 70).
 *
 * The browser owns the design (docs/adr/0003-barge-in-recovery.md): after a
 * barge-in, the session re-says exactly the unheard rest of the cut line, and
 * a filler resumes instead of restarting. The phone bridge keeps its own
 * implementation (ADR 0007) but is pinned to the same behaviour, so both sides
 * run the same recorded table:
 * `telephony-bot/test_barge_in_recovery.py` reads this file too.
 *
 * The table is the external contract: a line, how much of it played, the words
 * the caller heard, the exact tail, and the instruction the agent is given.
 * Nothing here reads a private field or a call order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  heardWords,
  resumeForBargeIn,
  resumeInstructions,
  unheardRest,
  worthResuming,
} from "./session";

type Case = {
  name: string;
  line: string;
  playedMs: number;
  heard: string;
  rest: string;
  callerText: string;
  instruction: string | null;
};

const fixture = JSON.parse(
  readFileSync(new URL("./barge-in-recovery.cases.json", import.meta.url), "utf8"),
) as { contract: string; cases: Case[] };

test("the recovery table belongs to the contract the phone bridge pins", () => {
  assert.equal(fixture.contract, "barge-in-recovery/1");
  assert.ok(fixture.cases.length >= 6, "the shared table lost its cases");
});

test("every recorded barge-in case matches the browser", () => {
  for (const c of fixture.cases) {
    assert.equal(heardWords(c.line, c.playedMs), c.heard, `${c.name}: heard`);
    assert.equal(unheardRest(c.line, c.heard), c.rest, `${c.name}: tail`);
    assert.equal(
      resumeForBargeIn(c.callerText, c.rest),
      c.instruction,
      `${c.name}: instruction`,
    );
  }
});

test("the resume says the exact tail, never the heard part", () => {
  const c = fixture.cases[0]!;
  const instructions = resumeForBargeIn(c.callerText, c.rest);
  assert.ok(instructions, "the tail was dropped");
  assert.match(instructions, /word for word: "booking and reminders for you"/);
  assert.doesNotMatch(instructions, /I'd handle/, "the heard part is repeated");
});

test("a tail of three words or fewer is not worth resuming", () => {
  assert.equal(worthResuming("check that now."), false);
  assert.equal(worthResuming("me check that for you"), true);
  assert.equal(resumeForBargeIn("okay", "check that now."), null);
});

test("a cut goodbye with nothing left still says the goodbye once", () => {
  // The empty-rest sentence is only reachable for a goodbye; the phone-side
  // mirror returns the same line for the same input.
  assert.equal(
    resumeInstructions("", ""),
    "A noise on the caller's side cut you off; they didn't say anything." +
      " Say your short goodbye once more, nothing else.",
  );
});
