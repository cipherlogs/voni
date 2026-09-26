import test from "node:test";
import assert from "node:assert/strict";
import { judgeOverlap } from "./barge-in";

const agent = "I'd handle booking, reminders, and after-hours calls for your clinic.";

test("steering over the agent cuts it at once", () => {
  for (const text of ["Wait, stop.", "No.", "Hold on", "Sorry, can you repeat that?"]) {
    assert.equal(judgeOverlap(text, agent), "yield", text);
  }
});

test("filler and back-channels never cut and are not answered", () => {
  for (const text of ["Okaay so", "mm-hmm", "Uh huh.", "Yeah.", "Okay.", "Right, right", "Sooo"]) {
    assert.equal(judgeOverlap(text, agent), "ignore", text);
  }
});

test("the agent's own voice leaking back is ignored", () => {
  assert.equal(judgeOverlap("booking reminders and after hours calls", agent), "ignore");
});

test("real content in the middle goes to the judge", () => {
  for (const text of ["What about pricing?", "We're a bakery actually."]) {
    assert.equal(judgeOverlap(text, agent), "judge", text);
  }
});

test("nothing heard is ignored", () => {
  assert.equal(judgeOverlap("", agent), "ignore");
  assert.equal(judgeOverlap("...", agent), "ignore");
});
