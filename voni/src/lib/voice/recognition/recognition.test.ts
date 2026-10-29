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
  callRecognition,
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
  spokenDigitsToNumerals,
  type CompleteRecognition,
} from "./index";
import { DE_FILLER } from "./locales/de/filler";
import { ES_FILLER } from "./locales/es/filler";
import { FR_FILLER } from "./locales/fr/filler";
import { IT_FILLER } from "./locales/it/filler";
import { PT_FILLER } from "./locales/pt/filler";

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

test("every spoken Locale is whole: every slot renders in its own words", () => {
  for (const locale of SPOKEN_NON_ENGLISH) {
    const resolution = resolveRecognition(locale);
    assert.equal(resolution.status, "complete", locale);
    if (resolution.status !== "complete") continue;
    assert.deepEqual(missingSlots(resolution.recognition), [], locale);
  }
});

/**
 * Filler, barge-in, commands, end-call and goodbyes are what a passing remark
 * and an end request are judged by, so they are tested as the caller's own
 * words: a Spanish back-channel is never answered, a Spanish command is
 * steering, a Spanish goodbye ends the call, and English words do not decide
 * any of it.
 */

test("a Spanish back-channel is filler and is never answered", () => {
  const es = callRecognition({ conversationLanguage: "es" });
  for (const text of ["Vale, vale.", "Pues...", "Ajá", "Mmm", "Bueno, gracias"]) {
    assert.equal(isFillerOnly(text, es), true, text);
  }
  for (const text of ["Vale, pero quiero una cita", "Somos una panadería", ""]) {
    assert.equal(isFillerOnly(text, es), false, text);
  }
});

test("a Spanish command token is recognised as a command", () => {
  const es = callRecognition({ conversationLanguage: "es" });
  assert.deepEqual(commandIntents("Para, espera un momento.", es), ["stop", "wait"]);
  assert.deepEqual(commandIntents("No, repite eso.", es), ["deny", "repeat"]);
  assert.equal(isCommandBargeIn("Para", es), true);
  assert.equal(isCommandBargeIn("Somos una panadería", es), false);
});

test("a Spanish goodbye is recognised as an ending", () => {
  const es = callRecognition({ conversationLanguage: "es" });
  for (const text of ["Adiós", "Cuelga la llamada", "Me tengo que ir", "Hasta luego"]) {
    assert.equal(isEndCallRequest(text, es), true, text);
  }
  for (const text of ["Somos una panadería", "Espera un momento", ""]) {
    assert.equal(isEndCallRequest(text, es), false, text);
  }
  for (const text of ["Adiós", "Hasta luego", "Cuídate"]) {
    assert.equal(isGoodbyeLine(text, es), true, text);
  }
  for (const text of ["Cuelga la llamada", "Somos una panadería", ""]) {
    assert.equal(isGoodbyeLine(text, es), false, text);
  }
});

test("English tokens do not leak into the Spanish set", () => {
  const es = callRecognition({ conversationLanguage: "es" });
  const spanish = [
    ...es.filler,
    ...es.bargeIn,
    ...es.endCall,
    ...es.goodbye,
    ...COMMAND_INTENTS.flatMap((intent) => es.commands[intent]),
  ].map((word) => word.toLowerCase());
  const englishOnly = [
    "stop", "wait", "bye", "goodbye", "thanks", "hold on", "hang on",
    "repeat", "listen", "sorry", "excuse me", "see you", "take care",
    "talk soon", "okay", "right", "sure", "gotta go",
  ];
  for (const word of englishOnly) {
    assert.equal(spanish.includes(word), false, `"${word}" is English, not Spanish`);
  }
  for (const text of ["stop", "hang up", "goodbye", "okay", "sorry"]) {
    assert.equal(isCommandBargeIn(text, es), false, text);
    assert.equal(isEndCallRequest(text, es), false, text);
    assert.equal(isGoodbyeLine(text, es), false, text);
    assert.equal(isFillerOnly(text, es), false, text);
  }
  // And the reverse: English does not accept Spanish words.
  assert.equal(isCommandBargeIn("Para", EN_RECOGNITION), false);
  assert.equal(isFillerOnly("Vale", EN_RECOGNITION), false);
});

test("each spoken Locale renders filler, barge-in, commands, end call and goodbye from its own file", () => {
  const fillerFiles = {
    es: ES_FILLER,
    fr: FR_FILLER,
    de: DE_FILLER,
    it: IT_FILLER,
    pt: PT_FILLER,
  } as const;
  for (const locale of SPOKEN_NON_ENGLISH) {
    const slots = LOCALE_RECOGNITION[locale];
    assert.equal(slots.filler, fillerFiles[locale], `${locale}: filler is wired from filler.ts`);
    assert.ok((slots.filler ?? []).length > 0, locale);
    assert.ok((slots.bargeIn ?? []).length > 0, `${locale}: bargeIn`);
    assert.ok((slots.endCall ?? []).length > 0, `${locale}: endCall`);
    assert.ok((slots.goodbye ?? []).length > 0, `${locale}: goodbye`);
    assert.deepEqual(
      Object.keys(slots.commands ?? {}).sort(),
      [...COMMAND_INTENTS].sort(),
      `${locale}: commands are keyed by intent`,
    );
    for (const intent of COMMAND_INTENTS) {
      assert.ok((slots.commands?.[intent] ?? []).length > 0, `${locale}: ${intent}`);
    }
    // The Locale's own words steer a call in that Locale.
    const recognition = callRecognition({ conversationLanguage: locale });
    assert.equal(isCommandBargeIn(slots.commands?.stop?.[0] ?? "", recognition), true, locale);
    assert.equal(isGoodbyeLine(slots.goodbye?.[0] ?? "", recognition), true, locale);
  }
});

test("an unpinned call runs on the documented English scaffolding, a pinned one never does", () => {
  // Automatic detection cannot know the Locale before the caller speaks: the
  // one documented exception (see NEUTRAL_KEYTERMS in ./transcription).
  assert.equal(callRecognition({}), EN_RECOGNITION);
  assert.equal(callRecognition({ languageCodes: [] }), EN_RECOGNITION);
  assert.equal(callRecognition({ languageCodes: ["ar", "hi"] }), EN_RECOGNITION);

  const spanish = callRecognition({ languageCodes: ["es"] });
  assert.equal(spanish.locale, "es");
  assert.equal(isEndCallRequest("Adiós", spanish), true);
  assert.equal(isFillerOnly("Vale", spanish), true);
  // The scaffolding is English scaffolding: it does not become the Spanish set.
  assert.equal(isEndCallRequest("Adiós", callRecognition({})), false);
  assert.equal(isFillerOnly("Vale", callRecognition({})), false);
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

/** The bundle a call in this Locale runs under: its own words, slot by slot. */
function localeWords(locale: (typeof SPOKEN_NON_ENGLISH)[number]): CompleteRecognition {
  return callRecognition({ conversationLanguage: locale });
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
  const spanish = localeWords("es");
  assert.equal(spokenDigitsToNumerals("Lima cuatro dos", spanish), "lima 42");
  assert.equal(containsTag(spokenDigitsToNumerals("Lima cuatro dos", spanish), tag), true);
  assert.equal(containsTag(spokenDigitsToNumerals("Lima four two", EN_RECOGNITION), tag), true);
  // Digits the caller already typed are left alone.
  assert.equal(containsTag(spokenDigitsToNumerals("Lima 4 2", spanish), tag), true);
});

test("a digit string in the wrong Locale does not silently resolve", () => {
  const tag = "Lima 42";
  const spanish = localeWords("es");
  // Spanish words stay words in English, and English words stay words in Spanish.
  assert.equal(spokenDigitsToNumerals("Lima four two", spanish), "lima four two");
  assert.equal(containsTag(spokenDigitsToNumerals("Lima four two", spanish), tag), false);
  assert.equal(spokenDigitsToNumerals("Lima cuatro dos", EN_RECOGNITION), "lima cuatro dos");
  assert.equal(containsTag(spokenDigitsToNumerals("Lima cuatro dos", EN_RECOGNITION), tag), false);
});

test("spoken-address matching accepts each Locale's own separator words", () => {
  for (const locale of SPOKEN_NON_ENGLISH) {
    assert.equal(
      normalizeSpokenAddress(SPOKEN_ADDRESS[locale], localeWords(locale)),
      "andres@acme.com",
      locale,
    );
  }
  // A separator said as two words is still one separator, and the longer form
  // wins: "guion bajo" is an underscore, never a hyphen followed by "bajo".
  assert.equal(
    normalizeSpokenAddress("andres punto garcia arroba acme guion bajo ventas punto com", localeWords("es")),
    "andres.garcia@acme_ventas.com",
  );
});

test("one Locale's address words do not resolve in another", () => {
  for (const locale of ["fr", "de", "it", "en"] as const) {
    const recognition = locale === "en" ? EN_RECOGNITION : localeWords(locale);
    // A dot word can be shared ("punto" is Spanish and Italian); the @ word is
    // the Locale's own, so the address itself never resolves.
    assert.equal(normalizeSpokenAddress(SPOKEN_ADDRESS.es, recognition).includes("@"), false, locale);
  }
  assert.equal(normalizeSpokenAddress(SPOKEN_ADDRESS.fr, localeWords("es")).includes("@"), false);
});

