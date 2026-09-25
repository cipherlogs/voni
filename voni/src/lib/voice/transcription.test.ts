import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentKeyterms,
  buildAgentTranscriptionPrompt,
  NEUTRAL_KEYTERMS,
} from "./transcription";
import { REAL_ESTATE_TEMPLATE, type AgentConfig } from "@/lib/agents/config";

const DENTAL: AgentConfig = {
  ...REAL_ESTATE_TEMPLATE,
  mission: "Book dental appointments and get urgent cases seen sooner.",
  identity: { name: "Nadia", role: "clinic coordinator" },
  detect: [
    { key: "reason", label: "Reason for calling", description: "", sensitive: false },
    { key: "urgency", label: "Urgency", description: "", sensitive: false },
  ],
  tools: ["check_calendar", "schedule_follow_up", "transfer_to_human"],
  customTools: [],
  keyterms: ["Ozempic", "root canal"],
};

test("neutral fallback names no vertical", () => {
  assert.deepEqual(NEUTRAL_KEYTERMS, ["Voni", "WhatsApp"]);
});

test("keyterms derive from the agent's own config, not a global list", () => {
  const terms = buildAgentKeyterms(DENTAL);
  for (const term of ["Nadia", "Reason", "calling", "Urgency", "calendar", "Ozempic", "root canal", "manager"]) {
    assert.ok(terms.includes(term), term);
  }
  // No property nouns leak into a dental agent.
  for (const term of ["mortgage", "villa", "Yas Island", "Bayut"]) {
    assert.ok(!terms.includes(term), term);
  }
  assert.ok(terms.length <= 100);
});

test("the template's vertical flavor rides on its own keyterms field", () => {
  const terms = buildAgentKeyterms(REAL_ESTATE_TEMPLATE);
  for (const term of ["Yas Island", "AED", "VONI-AUH", "Bayut", "mortgage"]) {
    assert.ok(terms.includes(term), term);
  }
});

test("owner keyterms dedupe case-insensitively and cap at 100", () => {
  const terms = buildAgentKeyterms({
    ...DENTAL,
    keyterms: ["nadia", "NADIA", ...Array.from({ length: 200 }, (_, i) => `Term${i}`)],
  });
  assert.equal(terms.filter((t) => t.toLowerCase() === "nadia").length, 1);
  assert.equal(terms.length, 100);
});

test("transcription prompt describes the call without instructing", () => {
  const prompt = buildAgentTranscriptionPrompt(DENTAL);
  assert.match(prompt, /clinic coordinator/);
  assert.match(prompt, /Book dental appointments/);
  assert.match(prompt, /Nadia/);
  assert.doesNotMatch(prompt, /transcribe verbatim|do not|never/i);
  assert.ok(prompt.length <= 500);
});
