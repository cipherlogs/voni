import test from "node:test";
import assert from "node:assert/strict";
import {
  ADDRESS_SEPARATORS,
  COMMAND_INTENTS,
  DIGITS,
  EN_RECOGNITION,
  RECOGNITION_SLOTS,
  commandIntents,
  isCommandBargeIn,
  isEndCallRequest,
  isFillerOnly,
  isGoodbyeLine,
  isRecognitionLocale,
  normalizeSpokenAddress,
  missingSlots,
  resolveBundle,
  resolveRecognition,
} from "./index";

test("English is one rendering: it resolves as a complete recognition bundle", () => {
  const resolution = resolveRecognition("en");
  assert.equal(resolution.status, "complete");
  if (resolution.status !== "complete") return;
  assert.equal(resolution.recognition.locale, "en");
  assert.deepEqual(missingSlots(resolution.recognition), []);
});

test("a Locale without a rendering is a hole, never English", () => {
  for (const locale of ["ar", "xx", "", "auto"]) {
    const resolution = resolveRecognition(locale);
    assert.equal(resolution.status, "missing", locale);
    assert.equal("recognition" in resolution, false, `${locale} must not carry an English bundle`);
  }
});

test("the key space is the six spoken Locales, not the eighteen input languages", () => {
  for (const locale of ["en", "es", "fr", "de", "it", "pt"]) {
    assert.equal(isRecognitionLocale(locale), true, locale);
  }
  for (const locale of ["ar", "hi", "nl", "tr", "ja", "zh", "xx", ""]) {
    assert.equal(isRecognitionLocale(locale), false, locale);
  }
});

test("every slot the contract names has an English rendering", () => {
  for (const slot of RECOGNITION_SLOTS) {
    assert.notEqual(EN_RECOGNITION[slot], undefined, slot);
    assert.equal(missingSlots(EN_RECOGNITION).includes(slot), false, slot);
  }
  assert.deepEqual(missingSlots(EN_RECOGNITION), []);
});

test("digits are keyed by their numeric meaning, not by an English word", () => {
  assert.deepEqual(Object.keys(EN_RECOGNITION.digits).map(Number).sort((a, b) => a - b), [...DIGITS]);
  for (const digit of DIGITS) {
    const words = EN_RECOGNITION.digits[digit];
    assert.ok(words.length > 0, String(digit));
    for (const word of words) assert.equal(word.trim(), word, `${digit}: "${word}"`);
  }
});

test("address separators are keyed by their role, not by the English word", () => {
  assert.deepEqual(Object.keys(EN_RECOGNITION.address).sort(), [...ADDRESS_SEPARATORS].sort());
  for (const role of ADDRESS_SEPARATORS) {
    assert.ok(EN_RECOGNITION.address[role].length > 0, role);
  }
});

test("commands are keyed by intent, so English does not name the meaning", () => {
  assert.deepEqual(Object.keys(EN_RECOGNITION.commands).sort(), [...COMMAND_INTENTS].sort());
  for (const intent of COMMAND_INTENTS) {
    assert.ok(EN_RECOGNITION.commands[intent].length > 0, intent);
  }
});

test("the English rendering does not claim another Locale's words", () => {
  const english = [
    ...EN_RECOGNITION.endCall,
    ...EN_RECOGNITION.goodbye,
    ...EN_RECOGNITION.filler,
    ...COMMAND_INTENTS.flatMap((intent) => EN_RECOGNITION.commands[intent]),
  ].map((word) => word.toLowerCase());
  for (const foreign of ["adiós", "adios", "tschüss", "tschuss", "arrivederci", "tchau", "au revoir"]) {
    assert.equal(english.includes(foreign), false, foreign);
  }
});

test("an incomplete Locale names its holes instead of filling them from English", () => {
  const resolution = resolveBundle({ locale: "fr", slots: { vocabulary: ["Voni"] } });
  assert.equal(resolution.status, "incomplete");
  if (resolution.status !== "incomplete") return;
  assert.deepEqual(resolution.missing, [
    "scene",
    "digits",
    "address",
    "filler",
    "bargeIn",
    "commands",
    "endCall",
    "goodbye",
  ]);
  assert.equal("recognition" in resolution, false);
});

test("the English scene describes the call in English, without instructing", () => {
  const scene = EN_RECOGNITION.scene({
    agentName: "Nadia",
    role: "clinic coordinator",
    mission: "Book dental appointments.",
    topics: ["Reason for calling", "Urgency"],
  });
  assert.equal(
    scene,
    "A clinic coordinator phone call. Book dental appointments. Agent Nadia. Callers mention Reason for calling, Urgency.",
  );
  assert.doesNotMatch(scene, /transcribe|do not|never|always/i);
  assert.doesNotMatch(
    EN_RECOGNITION.scene({ agentName: "Nadia", role: "clinic coordinator", mission: "Help.", topics: [] }),
    /Callers mention/,
  );
});

test("a command is reported by intent, so the caller's meaning is locale-independent", () => {
  assert.deepEqual(commandIntents("Wait, stop.", EN_RECOGNITION), ["stop", "wait"]);
  assert.deepEqual(commandIntents("No.", EN_RECOGNITION), ["deny"]);
  assert.deepEqual(commandIntents("Sorry, can you repeat that?", EN_RECOGNITION), ["repeat", "interject"]);
  assert.deepEqual(commandIntents("We run a bakery", EN_RECOGNITION), []);
  assert.equal(isCommandBargeIn("Hold on", EN_RECOGNITION), true);
  assert.equal(isCommandBargeIn("We run a bakery", EN_RECOGNITION), false);
});

test("filler is a back-channel only when every word is one", () => {
  for (const text of ["Uh huh.", "mm-hmm", "Okay.", "Right, right"]) {
    assert.equal(isFillerOnly(text, EN_RECOGNITION), true, text);
  }
  for (const text of ["Okay so let's start", "We run a bakery", ""]) {
    assert.equal(isFillerOnly(text, EN_RECOGNITION), false, text);
  }
});

test("an end request and a goodbye line are matched from the Locale's own words", () => {
  for (const text of ["I want you to hang up this call.", "Please end the call", "Okay, bye!"]) {
    assert.equal(isEndCallRequest(text, EN_RECOGNITION), true, text);
  }
  for (const text of ["We run a bakery", "Hold on", "Byron Bay is where we are"]) {
    assert.equal(isEndCallRequest(text, EN_RECOGNITION), false, text);
  }
  for (const text of ["Okay, bye!", "No problem. Goodbye!", "Alright, take care", "See you soon"]) {
    assert.equal(isGoodbyeLine(text, EN_RECOGNITION), true, text);
  }
  for (const text of ["I'll answer that after the test.", "Please hang up", ""]) {
    assert.equal(isGoodbyeLine(text, EN_RECOGNITION), false, text);
  }
});

test("words are matched in the caller's Locale only: another language does not resolve", () => {
  assert.equal(isEndCallRequest("Adiós", EN_RECOGNITION), false);
  assert.equal(isGoodbyeLine("Au revoir", EN_RECOGNITION), false);
  assert.equal(isCommandBargeIn("Para", EN_RECOGNITION), false);
});

test("a spoken address is written from the Locale's own separator words", () => {
  assert.equal(normalizeSpokenAddress("Andres at Acme dash Realty dot com", EN_RECOGNITION), "andres@acme-realty.com");
  assert.equal(normalizeSpokenAddress("andres underscore g at acme dot io", EN_RECOGNITION), "andres_g@acme.io");
  assert.equal(normalizeSpokenAddress(" andres.garcia @ acme.co.uk. ", EN_RECOGNITION), "andres.garcia@acme.co.uk");
});

test("another Locale's separator words do not resolve in English", () => {
  const raw = normalizeSpokenAddress("andres arroba acme punto com", EN_RECOGNITION);
  assert.doesNotMatch(raw, /[@.]/);
});
