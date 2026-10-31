import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalEmails,
  canonicalNumbers,
  languageLeaks,
  lastCanonicalEmail,
  normalizeWords,
  spokenName,
  wordError,
} from "./text";

/**
 * The caller text is authored, and these helpers are the one place that turns
 * its spoken form into the exact entity a tool or transcript must carry.
 * Every expected value is a hand-written literal from the scenario wording,
 * not a re-derivation from the helper.
 */

test("a spelled local part and domain become one canonical address", () => {
  assert.deepEqual(
    canonicalEmails("My email is j dot c h e n at example dot com."),
    ["j.chen@example.com"],
  );
  assert.deepEqual(
    canonicalEmails("It is amara dot rao at example dot org."),
    ["amara.rao@example.org"],
  );
});

test("a correction leaves the last complete address as the expectation", () => {
  const text =
    "My email is j dot c h a n at example dot com. Sorry, no. " +
    "J dot c h e n at example dot com.";
  assert.equal(lastCanonicalEmail(text), "j.chen@example.com");
});

test("a partial re-spelling with no domain is not an address", () => {
  assert.deepEqual(canonicalEmails("C h a n was wrong. C h e n is right."), []);
});

test("addresses outside the spelling grammar are refused rather than guessed", () => {
  assert.deepEqual(canonicalEmails("Mail me at the usual place."), []);
  assert.deepEqual(canonicalEmails("j.chen@example.com"), []);
});

test("a spoken digit run becomes the exact number the caller said", () => {
  assert.deepEqual(
    canonicalNumbers("My reference number is 4 1 5 2 0 8 7 6."),
    ["41520876"],
  );
  assert.deepEqual(
    canonicalNumbers("It is four one five, two zero eight, seven six."),
    ["41520876"],
  );
  assert.deepEqual(canonicalNumbers("Call 415-208-76, please."), ["41520876"]);
});

test("a short prose number is not a readback entity", () => {
  assert.deepEqual(canonicalNumbers("I have one of the things for you."), []);
  assert.deepEqual(canonicalNumbers("It is on Friday at ten."), []);
});

test("the caller's name is the name they gave, not a later noun", () => {
  assert.equal(spokenName("My name is Amara. A m a r a."), "amara");
  assert.equal(spokenName("My name is Amara and I need help."), "amara");
  assert.equal(spokenName("I need help with my account."), null);
});

test("word error compares words against the reference, including insertions and deletions", () => {
  const same = wordError("my email is j dot chen at example dot com", "my email is j dot chen at example dot com");
  assert.deepEqual(same, { errors: 0, words: 10, rate: 0 });

  const oneWrong = wordError("my email is j dot chen", "my email is j dot chan");
  assert.equal(oneWrong.errors, 1);
  assert.equal(oneWrong.words, 6);
  assert.equal(Number(oneWrong.rate.toFixed(3)), 0.167);

  const dropped = wordError("my email is j dot chen", "my email is j dot");
  assert.equal(dropped.errors, 1);
});

test("normalising words drops punctuation and case but keeps the spoken form", () => {
  assert.deepEqual(normalizeWords("J dot C.H.E.N, at example dot com!"), [
    "j",
    "dot",
    "c",
    "h",
    "e",
    "n",
    "at",
    "example",
    "dot",
    "com",
  ]);
});

test("an English Locale leaks a non-English marker, a Spanish Locale leaks English", () => {
  assert.deepEqual(languageLeaks("Claro, perfecto, thank you.", "en"), ["claro", "perfecto"]);
  assert.deepEqual(languageLeaks("I will check that for you.", "es"), [
    "i",
    "will",
    "that",
    "for",
    "you",
  ]);
  assert.deepEqual(languageLeaks("Of course, I can check that.", "en"), []);
});

test("single-letter function words are not markers: they collide with ordinary words", () => {
  // `a`, `e` and `o` are Portuguese words and ordinary English letters.
  assert.deepEqual(languageLeaks("A quick check, e-mail is fine.", "pt"), [
    "is",
    "fine",
  ]);
  assert.deepEqual(languageLeaks("A la carte.", "en"), []);
});
