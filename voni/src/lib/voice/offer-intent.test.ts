import test from "node:test";
import assert from "node:assert/strict";
import { callerIsWilling, shouldSpeakInvite } from "./offer-intent";

test("an acceptance or a question about what Voni does is willing", () => {
  for (const final of [
    "Yes.",
    "Yes, let's do it.",
    "Sure, go ahead.",
    "Okay.",
    "Try it.",
    "I'm ready.",
    "What can you do?",
    "What do you do?",
    "How does it work?",
    "How do you work?",
    "Tell me what you do.",
    "Tell me what you can actually do.",
    "Show me.",
    "Can you check my email?",
  ]) {
    assert.equal(callerIsWilling(final), true, final);
  }
});

test("a complaint, a challenge, a neutral turn or small talk is not willing", () => {
  for (const final of [
    "This is ridiculous. Your service is useless.",
    "Are you a real person?",
    "Prove it.",
    "I'm not sure.",
    "Nice weather today.",
    "How are you?",
    "That sounds interesting.",
  ]) {
    assert.equal(callerIsWilling(final), false, final);
  }
});

test("the hard invite fires only on a willing turn with a tag", () => {
  assert.equal(
    shouldSpeakInvite("show-and-speak", "Lime 42", "This is ridiculous. Your service is useless."),
    false,
    "an upset turn never hears the invite",
  );
  assert.equal(
    shouldSpeakInvite("show-and-speak", "Lime 42", "How are you?"),
    false,
    "a neutral or small-talk turn never hears the invite",
  );
  assert.equal(
    shouldSpeakInvite("show-and-speak", "Lime 42", "What can you do?"),
    true,
    "a willing turn hears the invite",
  );
  assert.equal(
    shouldSpeakInvite("show-and-speak", null, "What can you do?"),
    false,
    "no tag means no spoken invite",
  );
  assert.equal(
    shouldSpeakInvite("show-only", "Lime 42", "What can you do?"),
    false,
    "a tagged agent line is the invite; the fallback stays silent",
  );
});
