import test from "node:test";
import assert from "node:assert/strict";
import { judgeOverlap } from "./barge-in";
import { EN_RECOGNITION, callRecognition } from "./recognition";

const agent = "I'd handle booking, reminders, and after-hours calls for your clinic.";

test("steering over the agent cuts it at once", () => {
  for (const text of ["Wait, stop.", "No.", "Hold on", "Sorry, can you repeat that?"]) {
    assert.equal(judgeOverlap(text, agent, EN_RECOGNITION), "yield", text);
  }
});

test("asking to end the call is always real, never an aside", () => {
  for (const text of ["I want you to hang up this call.", "Okay, bye.", "Please end the call"]) {
    assert.equal(judgeOverlap(text, agent, EN_RECOGNITION), "yield", text);
  }
});

test("filler and back-channels never cut and are not answered", () => {
  for (const text of ["Okaay so", "mm-hmm", "Uh huh.", "Yeah.", "Okay.", "Right, right", "Sooo"]) {
    assert.equal(judgeOverlap(text, agent, EN_RECOGNITION), "ignore", text);
  }
});

test("the agent's own voice leaking back is ignored", () => {
  assert.equal(judgeOverlap("booking reminders and after hours calls", agent, EN_RECOGNITION), "ignore");
});

test("real content in the middle goes to the judge", () => {
  for (const text of ["What about pricing?", "We're a bakery actually."]) {
    assert.equal(judgeOverlap(text, agent, EN_RECOGNITION), "judge", text);
  }
});

test("nothing heard is ignored", () => {
  assert.equal(judgeOverlap("", agent, EN_RECOGNITION), "ignore");
  assert.equal(judgeOverlap("...", agent, EN_RECOGNITION), "ignore");
});

/** A Spanish call is judged by Spanish words, not English ones (voice-parity 47). */
test("a Spanish back-channel is ignored and a Spanish command yields", () => {
  const es = callRecognition({ conversationLanguage: "es" });
  const agentEs = "Me encargo de las citas, los recordatorios y las llamadas de tu clínica.";
  for (const text of ["Vale, vale.", "Pues...", "Ajá", "Bueno, gracias"]) {
    assert.equal(judgeOverlap(text, agentEs, es), "ignore", text);
  }
  for (const text of ["Para.", "Espera un momento.", "Adiós"]) {
    assert.equal(judgeOverlap(text, agentEs, es), "yield", text);
  }
  // Content still goes to the judge, and an English token is not a Spanish rule.
  assert.equal(judgeOverlap("¿Cuánto cuesta?", agentEs, es), "judge");
  assert.equal(judgeOverlap("stop", agentEs, es), "judge");
});
