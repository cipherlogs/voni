import test from "node:test";
import assert from "node:assert/strict";
import {
  completenessFromResolution,
  recognitionCompleteness,
  recognitionCompletenessReport,
} from "./completeness";
import { CONVERSATION_LANGUAGES } from "@/lib/agents/wizard";
import { EN_RECOGNITION } from "./en";
import { RECOGNITION_SLOTS, type RecognitionSlotName } from "./types";

/**
 * The completeness report is the gate's view of the recognition contract: one
 * verdict per Locale, naming every slot that Locale cannot render. These tests
 * assert the report's external behaviour — what a gate reads — never how it is
 * assembled.
 */

const NON_ENGLISH = CONVERSATION_LANGUAGES.filter((locale) => locale !== "en");

test("the report names every missing slot of every Locale that has no rendering", () => {
  const report = recognitionCompletenessReport();

  assert.deepEqual(
    report.locales.map((locale) => locale.locale),
    [...CONVERSATION_LANGUAGES],
  );
  assert.equal(report.complete, false);
  assert.deepEqual(report.incomplete, [...NON_ENGLISH]);

  for (const locale of report.locales.filter((entry) => entry.locale !== "en")) {
    assert.equal(locale.status, "missing", locale.locale);
    assert.equal(locale.complete, false, locale.locale);
    assert.deepEqual(locale.missing, [...RECOGNITION_SLOTS], locale.locale);
    assert.deepEqual(
      locale.holes.map((hole) => hole.slot),
      [...RECOGNITION_SLOTS],
      `${locale.locale} holes are listed in report order`,
    );
    for (const hole of locale.holes) {
      assert.match(hole.detail, new RegExp(locale.locale), `${locale.locale}: ${hole.slot} names its Locale`);
      assert.match(hole.detail, new RegExp(hole.slot), `${locale.locale}: ${hole.slot} names its slot`);
    }
  }
});

test("a Locale with holes names exactly those holes, not a whole repertoire of substitutes", () => {
  const report = completenessFromResolution({
    status: "incomplete",
    locale: "fr",
    missing: ["scene", "digits"],
  });

  assert.equal(report.status, "incomplete");
  assert.equal(report.complete, false);
  assert.deepEqual(report.missing, ["scene", "digits"]);
  assert.deepEqual(
    report.holes.map((hole) => hole.slot),
    ["scene", "digits"],
  );
  // Two holes stay two holes: nothing was filled in on the Locale's behalf.
  assert.equal(report.missing.length, 2);
  assert.equal(report.detail, "fr: 2 slots missing: scene, digits");
});

test("a Locale with no rendering is a hole on every slot, never an English substitute", () => {
  for (const locale of NON_ENGLISH) {
    const report = recognitionCompleteness(locale);
    assert.equal(report.complete, false, locale);
    // Every slot is a named hole. If any slot were quietly served by English,
    // it would be absent from this list.
    for (const slot of RECOGNITION_SLOTS) {
      assert.equal(report.missing.includes(slot), true, `${locale}: ${slot}`);
    }
    assert.deepEqual(report.missing, [...RECOGNITION_SLOTS], locale);
  }

  // The same rule at the top: English alone cannot make the report whole.
  assert.equal(recognitionCompleteness("en").complete, true);
  assert.equal(recognitionCompletenessReport().complete, false);
});

test("a complete Locale reports no holes", () => {
  const report = recognitionCompleteness("en");

  assert.equal(report.status, "complete");
  assert.equal(report.complete, true);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.holes, []);
  assert.equal(report.detail, "en: complete");

  const fromResolution = completenessFromResolution({ status: "complete", recognition: EN_RECOGNITION });
  assert.equal(fromResolution.complete, true);
  assert.deepEqual(fromResolution.missing, []);
});

test("the report is plain data a per-subject gate can store and print", () => {
  const subject = recognitionCompleteness("de");

  // Plain data: no functions, no class instances, stable through an artifact write.
  assert.deepEqual(JSON.parse(JSON.stringify(subject)), subject);
  assert.deepEqual(JSON.parse(JSON.stringify(recognitionCompletenessReport())), recognitionCompletenessReport());

  // A gate reads the Locale, the holes and a line to print — and makes its own verdict.
  assert.equal(subject.locale, "de");
  assert.equal(subject.complete, false);
  assert.ok(subject.missing.length > 0);
  assert.equal(typeof subject.detail, "string");
  assert.ok(subject.detail.length > 0);
  assert.match(subject.detail, /^de: /);
});

test("a Locale the gate has never seen is reported, not thrown", () => {
  for (const locale of ["xx", "", "auto", "ar"]) {
    const report = recognitionCompleteness(locale);
    assert.equal(report.locale, locale);
    assert.equal(report.status, "missing");
    assert.equal(report.complete, false);
    assert.deepEqual(report.missing, [...RECOGNITION_SLOTS]);
    assert.equal(typeof report.detail, "string");
  }
});

test("the report can be scoped to the Locales a caller asks for", () => {
  const report = recognitionCompletenessReport(["en"]);

  assert.equal(report.complete, true);
  assert.deepEqual(report.incomplete, []);
  assert.deepEqual(
    report.locales.map((locale) => locale.locale),
    ["en"],
  );

  const single: readonly RecognitionSlotName[] = recognitionCompletenessReport(["es"]).locales[0].missing;
  assert.deepEqual(single, [...RECOGNITION_SLOTS]);
});
