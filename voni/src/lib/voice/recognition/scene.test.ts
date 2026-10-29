import test from "node:test";
import assert from "node:assert/strict";
import {
  DE_RECOGNITION,
  ES_RECOGNITION,
  FR_RECOGNITION,
  IT_RECOGNITION,
  PT_RECOGNITION,
} from "./locales";
import { recognitionScene, resolveBundle } from "./index";
import { EN_RECOGNITION } from "./en";
import type { SceneSubject } from "./types";

/**
 * The scene prompt is the description of the call the recogniser is hearing,
 * written in the call's own Locale. These tests assert what a call sends — the
 * rendered scene — never how a Locale is assembled.
 *
 * The one non-obvious rule is that a scene DESCRIBES and never INSTRUCTS: a
 * behavioural command ("transcribe verbatim", "do not add punctuation") is
 * ignored by the recogniser, so a scene carrying one is a defect. The rule is
 * proved able to fail below before it is applied to every Locale.
 */

const SUBJECT: SceneSubject = {
  agentName: "Nadia",
  role: "clinic coordinator",
  mission: "Book dental appointments and get urgent cases seen sooner.",
  topics: ["Reason for calling", "Urgency"],
};

const NON_ENGLISH = [
  ["es", ES_RECOGNITION, /llamada telefónica/],
  ["fr", FR_RECOGNITION, /appel téléphonique/],
  ["de", DE_RECOGNITION, /Telefonanruf/],
  ["it", IT_RECOGNITION, /chiamata telefonica/],
  ["pt", PT_RECOGNITION, /chamada telefónica/],
] as const;

/**
 * A behavioural command aimed at the recogniser, in any of the six Locales:
 * a transcription imperative or a negation/obligation word. A description of
 * a call contains none of these.
 */
const INSTRUCTS =
  /\b(?:transcri|transkrib|trascriv|transcrev)\w*|\b(?:write|use|add|ignore|preserve|always|never|must|should|do not|don't)\b|\b(?:escribe|escriba|usa|utiliza|añade|ignora|nunca|siempre)\b|\b(?:écris|utilise|ajoute|ignore|jamais|toujours)\b|\b(?:schreibe|verwende|füge|ignoriere|keine|nicht|nie|immer)\b|\b(?:scrivi|scriva|usa|aggiungi|ignora|mai|sempre)\b|\b(?:escreva|use|adicione|ignore|nunca|sempre)\b/i;

/** Whether a scene only describes the call. */
function describes(scene: string): boolean {
  return !INSTRUCTS.test(scene);
}

test("the describes-not-instructs rule can fail on a scene that carries a behaviour", () => {
  const instructions = [
    "Transcribe the caller verbatim. Do not add punctuation.",
    "Transcribe al cliente palabra por palabra. No añadas puntuación.",
    "Transcris l'appelant mot pour mot. N'ajoute pas de ponctuation.",
    "Transkribiere den Anrufer wörtlich. Füge keine Satzzeichen hinzu.",
    "Trascrivi il chiamante parola per parola. Non aggiungere punteggiatura.",
    "Transcreva o interlocutor palavra por palavra. Não adiciones pontuação.",
  ];
  for (const instruction of instructions) {
    assert.equal(describes(instruction), false, instruction);
  }
  // And it does not fire on a plain description.
  assert.equal(describes("A clinic coordinator phone call. Agent Nadia."), true);
});

test("each spoken Locale renders its own scene, in its own words", () => {
  for (const [locale, bundle, marker] of NON_ENGLISH) {
    const render = bundle.scene;
    assert.notEqual(render, undefined, locale);
    const scene = render?.(SUBJECT) ?? "";
    assert.match(scene, marker, locale);
    assert.match(scene, /Nadia/, locale);
    assert.match(scene, /clinic coordinator/, locale);
    assert.match(scene, /Book dental appointments/, locale);
    assert.match(scene, /Reason for calling, Urgency/, locale);
    // Not the English rendering, and not its English phrasing.
    assert.notEqual(scene, EN_RECOGNITION.scene(SUBJECT), locale);
    assert.doesNotMatch(scene, /phone call|Callers mention/, locale);
  }
});

test("a Spanish call is described in Spanish, not in an English scene", () => {
  assert.equal(
    ES_RECOGNITION.scene?.(SUBJECT),
    "Una llamada telefónica de clinic coordinator. " +
      "Book dental appointments and get urgent cases seen sooner. " +
      "Habla Nadia. Quien llama menciona Reason for calling, Urgency.",
  );
});

test("every spoken Locale's scene describes the call without instructing", () => {
  for (const [locale, bundle] of NON_ENGLISH) {
    const scene = bundle.scene?.(SUBJECT) ?? "";
    assert.ok(scene.length > 0, locale);
    assert.equal(describes(scene), true, `${locale}: ${scene}`);
  }
});

test("a Locale's scene omits the topics clause when the call has no topics", () => {
  for (const [locale, bundle] of NON_ENGLISH) {
    const scene = bundle.scene?.({ ...SUBJECT, topics: [] }) ?? "";
    assert.ok(scene.length > 0, locale);
    assert.doesNotMatch(scene, /Reason for calling/, locale);
    assert.equal(describes(scene), true, `${locale}: ${scene}`);
  }
});

test("a Locale with no scene is a hole, never English's rendering", () => {
  // Nothing registered under the key: the scene lookup returns nothing at all.
  for (const locale of ["ar", "xx", "", "auto"]) {
    assert.equal(recognitionScene(locale), undefined, locale);
  }

  // A Locale registered without a scene is reported as a hole, and cannot be
  // resolved into a recognition bundle that would quietly carry English text.
  const withoutScene = resolveBundle({
    locale: "es",
    slots: { ...ES_RECOGNITION, scene: undefined },
  });
  assert.equal(withoutScene.status, "incomplete");
  if (withoutScene.status !== "incomplete") return;
  assert.equal(withoutScene.missing.includes("scene"), true);
  assert.equal("recognition" in withoutScene, false);
});

test("each spoken Locale's scene is registered, so scene is no longer a hole", () => {
  for (const [locale] of NON_ENGLISH) {
    const resolution = resolveBundle({ locale, slots: { scene: recognitionScene(locale) } });
    assert.equal(resolution.status, "incomplete", locale);
    if (resolution.status !== "incomplete") continue;
    assert.equal(resolution.missing.includes("scene"), false, locale);
  }
});
