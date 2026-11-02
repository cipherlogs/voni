import test from "node:test";
import assert from "node:assert/strict";

import { compileSystemPrompt } from "@/lib/agents/compile";
import { voniConfig } from "./voni-agent";

/**
 * The emotion-hostile call (164f344e) asked "That's fair — what went wrong?"
 * on two turns and restated the complaint back at the caller. The demo rules
 * own that: one repair question per call, no echo, and no tag-on question
 * after an answer.
 */

const prompt = () => compileSystemPrompt(voniConfig("audrey"));

test("a complaint is acknowledged, never restated, and the repair question is asked once per call", () => {
  const rules = prompt();
  assert.match(rules, /never restate their complaint or their own words back at them/);
  assert.match(rules, /Ask 'what went wrong\?' at most once in the whole call/);
  assert.match(rules, /even when a new complaint arrives[\s\S]*never that question again and never a new wording of it/);
  assert.doesNotMatch(rules, /name the specific complaint and ask one repair question/);
});

test("an answered question ends the turn: no appended repair question", () => {
  const rules = prompt();
  assert.match(rules, /I don't know that one', then stop: add a question only if it moves the call forward/);
  assert.match(rules, /never 'what went wrong\?' after an answer/);
});

test("the acknowledgement bans and the no-reflex pitch still stand", () => {
  const rules = prompt();
  assert.match(rules, /'Got it', 'Mhm', 'Right' or 'Okay'/);
  assert.match(rules, /never as a reflex, and never twice in a row/);
});
