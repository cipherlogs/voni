import test from "node:test";
import assert from "node:assert/strict";
import {
  TAG_TTL_S,
  TAG_WORDS,
  containsTag,
  countTags,
  pickTag,
} from "./test-tag";
import { signTagToken, verifyTagToken } from "./call-token";

test("every demo language has a list of short, accent-free, distinct words", () => {
  for (const [lang, words] of Object.entries(TAG_WORDS)) {
    assert.ok(words.length >= 30, `${lang}: ${words.length} words`);
    assert.equal(new Set(words.map((w) => w.toLowerCase())).size, words.length, `${lang}: duplicates`);
    for (const w of words) assert.match(w, /^[A-Z][a-z]{2,8}$/, `${lang}: ${w}`);
  }
  assert.deepEqual(Object.keys(TAG_WORDS).sort(), ["de", "en", "es", "fr", "it", "pt"]);
});

test("a tag is a word from the call's language and two digits, never one already live", () => {
  const seq = [0, 0, 0.5, 0.99];
  let i = 0;
  const random = () => seq[i++ % seq.length];
  const first = pickTag("es", new Set(), random);
  assert.match(first, /^[A-Z][a-z]+ [1-9][0-9]$/);
  assert.ok(TAG_WORDS.es.includes(first.split(" ")[0]));
  // A taken tag is skipped for a fresh draw.
  const taken = new Set([first.toLowerCase()]);
  i = 0;
  const second = pickTag("es", taken, random);
  assert.notEqual(second.toLowerCase(), first.toLowerCase());
  assert.match(pickTag("xx", new Set(), Math.random), /^[A-Z][a-z]+ [1-9][0-9]$/, "unknown language → English");
});

test("the tag is found however the visitor typed it, and nowhere else", () => {
  for (const typed of ["Lime 42", "lime42", "LIME-42", "Re: lime 42 test", "Tag: Lime #42", "hello (Lime 42).", "Lime 4 2", "lime 4-2"]) {
    assert.equal(containsTag(typed, "Lime 42"), true, typed);
  }
  for (const other of ["Lime 43", "Sublime 42", "Lime 420", "Lime 4 20", "Lime", "42"]) {
    assert.equal(containsTag(other, "Lime 42"), false, other);
  }
  assert.equal(containsTag("Asunto: Délfin 17", "Delfin 17"), true, "accents typed by the visitor still match");
});

test("the browser keeps a signed tag token; forged or expired ones are refused", () => {
  const now = 1_000_000_000;
  const token = signTagToken("k", "tag-id-1", now);
  assert.deepEqual(verifyTagToken("k", token, now + 1000), { id: "tag-id-1", issuedAt: now });
  assert.equal(verifyTagToken("k", token, now + TAG_TTL_S * 1000 + 1), null, "expired");
  assert.equal(verifyTagToken("other", token, now), null, "wrong key");
  assert.equal(verifyTagToken("k", token.replace("tag-id-1", "tag-id-2"), now), null, "tampered id");
  assert.equal(verifyTagToken("k", "garbage", now), null);
});

test("distinct tags in the tag's own language are counted (one email must not claim many visitors)", () => {
  assert.equal(countTags("Lime 42", "Lime 42"), 1);
  assert.equal(countTags("Re: meeting at 10, Lime 42", "Lime 42"), 1, "ordinary numbers are not tags");
  assert.equal(countTags("Lime 42 Coral 17 Pepper 90", "Lime 42"), 3);
  assert.equal(countTags("Lemon 93 Hi, Lemon93 here", "Lemon 93"), 1, "the same tag twice (subject + body, a quoted reply) is one");
  assert.equal(countTags("Lemon 93 — Pin 12 rue Mel 30", "Lemon 93"), 1, "other languages' words are ordinary text");
});

test("digits are joined only as a spoken pair ('4 2'), never across a phone number", () => {
  assert.equal(containsTag("Lemon 93 555 1234", "Lemon 93"), true);
  assert.equal(containsTag("Lemon 9 3", "Lemon 93"), true);
});
