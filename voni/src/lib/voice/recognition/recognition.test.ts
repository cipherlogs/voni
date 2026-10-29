import test from "node:test";
import assert from "node:assert/strict";
import { containsTag } from "@/lib/demo/test-tag";
import {
  ADDRESS_SEPARATORS,
  COMMAND_INTENTS,
  DIGITS,
  EN_RECOGNITION,
  LOCALE_RECOGNITION,
  RECOGNITION_SLOTS,
  commandIntents,
  isCommandBargeIn,
  isEndCallRequest,
  isFillerOnly,
  isGoodbyeLine,
  isRecognitionLocale,
  normalizeSpokenAddress,
  missingSlots,
  callRecognitionLocale,
  recognitionVocabulary,
  resolveBundle,
  resolveRecognition,
  completeRecognitionFor,
  spokenDigitsToNumerals,
  type CompleteRecognition,
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

const SPOKEN_NON_ENGLISH = ["es", "fr", "de", "it", "pt"] as const;

/** Every Locale's vocabulary is its own words; the shared part is only the product's proper nouns. */
test("each spoken Locale has its own vocabulary", () => {
  for (const locale of SPOKEN_NON_ENGLISH) {
    const terms = recognitionVocabulary(locale);
    assert.ok(terms && terms.length > 0, locale);
    assert.equal(terms?.some((term) => !EN_RECOGNITION.vocabulary.includes(term)), true, locale);
    assert.notDeepEqual(terms, EN_RECOGNITION.vocabulary, locale);
  }
  const spanish = recognitionVocabulary("es") ?? [];
  assert.equal(spanish.includes("Voni"), true);
  assert.equal(spanish.includes("WhatsApp"), true);
});

test("an English keyterm is absent from a non-English vocabulary unless it is a proper noun", () => {
  // The product name and channel are the only English spellings a Locale may keep.
  const properNouns = new Set(["voni", "whatsapp"]);
  const englishCommonWords = [
    "phone", "call", "email", "address", "appointment", "budget",
    "calendar", "price", "property", "message", "number", "voice",
  ];
  for (const locale of SPOKEN_NON_ENGLISH) {
    for (const term of recognitionVocabulary(locale) ?? []) {
      const word = term.toLowerCase();
      if (properNouns.has(word)) continue;
      assert.equal(englishCommonWords.includes(word), false, `${locale}: "${term}"`);
    }
  }
});

test("each spoken Locale is registered with vocabulary, scene, digits and address filled and the rest a named hole", () => {
  for (const locale of SPOKEN_NON_ENGLISH) {
    const resolution = resolveRecognition(locale);
    assert.equal(resolution.status, "incomplete", locale);
    if (resolution.status !== "incomplete") continue;
    assert.equal(resolution.missing.includes("vocabulary"), false, locale);
    assert.equal(resolution.missing.includes("scene"), false, locale);
    assert.equal(resolution.missing.includes("digits"), false, locale);
    assert.equal(resolution.missing.includes("address"), false, locale);
    assert.deepEqual(
      resolution.missing,
      ["filler", "bargeIn", "commands", "endCall", "goodbye"],
      locale,
    );
  }
});

test("a call's Locale comes from its conversation language, then its pinned language list", () => {
  assert.equal(callRecognitionLocale({ conversationLanguage: "es" }), "es");
  assert.equal(callRecognitionLocale({ conversationLanguage: "es", languageCodes: ["fr"] }), "es");
  assert.equal(callRecognitionLocale({ languageCodes: ["en", "de"] }), "en");
  assert.equal(callRecognitionLocale({ languageCodes: ["ar", "pt"] }), "pt");
  // Nothing spoken pinned: automatic detection, which is the documented exception.
  assert.equal(callRecognitionLocale({}), null);
  assert.equal(callRecognitionLocale({ languageCodes: [] }), null);
});

/**
 * A Locale's own digits and address words, with English standing in for the
 * slots that arrive with their own tickets. Matching needs a whole bundle, and
 * this ticket judges only the two slots it renders; the fixture is the test's,
 * never a production fallback.
 */
function withLocaleWords(locale: (typeof SPOKEN_NON_ENGLISH)[number]): CompleteRecognition {
  return { ...EN_RECOGNITION, ...LOCALE_RECOGNITION[locale], locale };
}

/** The same address, said with each Locale's own separator words. */
const SPOKEN_ADDRESS: Record<(typeof SPOKEN_NON_ENGLISH)[number], string> = {
  es: "andres arroba acme punto com",
  fr: "andres arobase acme point com",
  de: "andres klammeraffe acme punkt com",
  it: "andres chiocciola acme punto com",
  pt: "andres arroba acme ponto com",
};

test("every spoken Locale renders its own digit words, keyed by numeric value", () => {
  for (const locale of SPOKEN_NON_ENGLISH) {
    const digits = LOCALE_RECOGNITION[locale].digits;
    assert.ok(digits, `${locale}: digits missing`);
    assert.deepEqual(Object.keys(digits).map(Number).sort((a, b) => a - b), [...DIGITS], locale);
    for (const digit of DIGITS) assert.ok((digits[digit] ?? []).length > 0, `${locale} ${digit}`);
    assert.notDeepEqual(digits, EN_RECOGNITION.digits, locale);
  }
  // The words are the Locale's own, not the English repertoire under another key.
  for (const [locale, digit, word] of [
    ["es", 4, "cuatro"],
    ["fr", 2, "deux"],
    ["de", 7, "sieben"],
    ["it", 5, "cinque"],
    ["pt", 3, "três"],
  ] as const) {
    assert.equal(LOCALE_RECOGNITION[locale].digits?.[digit]?.includes(word), true, `${locale} ${digit} ${word}`);
  }
  for (const locale of SPOKEN_NON_ENGLISH) {
    const words = DIGITS.flatMap((digit) => LOCALE_RECOGNITION[locale].digits?.[digit] ?? []).map((w) => w.toLowerCase());
    // "six" is French's own 6, so only English words no Locale shares count.
    for (const english of ["one", "two", "three", "four", "five", "seven", "eight", "nine"]) {
      assert.equal(words.includes(english), false, `${locale}: English "${english}"`);
    }
  }
});

test("a Spanish spoken digit string resolves to the same Test tag as English numerals", () => {
  const tag = "Lima 42";
  const spanish = withLocaleWords("es");
  assert.equal(spokenDigitsToNumerals("Lima cuatro dos", spanish), "lima 42");
  assert.equal(containsTag(spokenDigitsToNumerals("Lima cuatro dos", spanish), tag), true);
  assert.equal(containsTag(spokenDigitsToNumerals("Lima four two", EN_RECOGNITION), tag), true);
  // Digits the caller already typed are left alone.
  assert.equal(containsTag(spokenDigitsToNumerals("Lima 4 2", spanish), tag), true);
});

test("a digit string in the wrong Locale does not silently resolve", () => {
  const tag = "Lima 42";
  const spanish = withLocaleWords("es");
  // Spanish words stay words in English, and English words stay words in Spanish.
  assert.equal(spokenDigitsToNumerals("Lima four two", spanish), "lima four two");
  assert.equal(containsTag(spokenDigitsToNumerals("Lima four two", spanish), tag), false);
  assert.equal(spokenDigitsToNumerals("Lima cuatro dos", EN_RECOGNITION), "lima cuatro dos");
  assert.equal(containsTag(spokenDigitsToNumerals("Lima cuatro dos", EN_RECOGNITION), tag), false);
});

test("spoken-address matching accepts each Locale's own separator words", () => {
  for (const locale of SPOKEN_NON_ENGLISH) {
    assert.equal(
      normalizeSpokenAddress(SPOKEN_ADDRESS[locale], withLocaleWords(locale)),
      "andres@acme.com",
      locale,
    );
  }
  // A separator said as two words is still one separator, and the longer form
  // wins: "guion bajo" is an underscore, never a hyphen followed by "bajo".
  assert.equal(
    normalizeSpokenAddress("andres punto garcia arroba acme guion bajo ventas punto com", withLocaleWords("es")),
    "andres.garcia@acme_ventas.com",
  );
});

test("one Locale's address words do not resolve in another", () => {
  for (const locale of ["fr", "de", "it", "en"] as const) {
    const recognition = locale === "en" ? EN_RECOGNITION : withLocaleWords(locale);
    // A dot word can be shared ("punto" is Spanish and Italian); the @ word is
    // the Locale's own, so the address itself never resolves.
    assert.equal(normalizeSpokenAddress(SPOKEN_ADDRESS.es, recognition).includes("@"), false, locale);
  }
  assert.equal(normalizeSpokenAddress(SPOKEN_ADDRESS.fr, withLocaleWords("es")).includes("@"), false);
});

test("a Locale that is not whole matches nothing, never English", () => {
  for (const locale of [...SPOKEN_NON_ENGLISH, "ar"]) {
    assert.equal(completeRecognitionFor(locale), null, locale);
  }
  assert.equal(completeRecognitionFor("en")?.locale, "en");
});
