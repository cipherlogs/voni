/**
 * The pace card is the operator's control, and these assertions are about the
 * two ways it could stop being one: hiding behind a fold, or showing a number
 * the ticker will not deliver.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const card = readFileSync(
  fileURLToPath(new URL("./pace-card.tsx", import.meta.url)),
  "utf8",
);
const page = readFileSync(
  fileURLToPath(new URL("../app/email/page.tsx", import.meta.url)),
  "utf8",
);
const actions = readFileSync(
  fileURLToPath(new URL("../app/email/actions.ts", import.meta.url)),
  "utf8",
);

test("the pace control is on the page itself, not inside a folded card", () => {
  assert.match(page, /<PaceCard/, "the page renders it");
  assert.match(page, /<LivePanel[\s\S]*?<PaceCard/, "it sits under the live panel");
  // The GitHub card is folded by default, so a control inside it is invisible
  // until the operator opens a card they have no reason to open.
  assert.doesNotMatch(card, /Collapsible/, "the pace card is never folded");
});

test("the card offers the three intents an operator has: slower, half, fastest", () => {
  assert.match(card, /Slowest \(\{formatPerDay\(range\.minPerDay\)\}\)/);
  assert.match(card, /As fast as possible \(\{formatPerDay\(range\.maxPerDay\)\}\)/);
  assert.match(card, /Half \(\{(?:formatPerDay|Math\.round)/);
});

test("the ceiling is stated, with the reason it is the ceiling", () => {
  assert.match(card, /data-testid="email-pace-ceiling"/);
  assert.match(card, /RUNNER_STARTUP_SECONDS/);
  assert.match(card, /CLICKS_PER_SEGMENT_BUDGET/);
});

test("every number the card shows comes from the shared pace arithmetic", () => {
  assert.match(card, /import \{[^}]*planPace[^}]*\} from "@\/lib\/email\/pace"/);
  assert.doesNotMatch(card, /function clicksPerDay/, "no second formula");
  assert.match(card, /clicksPerDay\(/, "the configured number is the ticker's own");
});

test("saving shows a pending state and a toast, never a silent reset", () => {
  assert.match(card, /<LoadingButton/);
  assert.match(card, /pending=\{saving\}/);
  assert.match(card, /useActionToast/);
});

test("the action writes through the same schedule save, so the two cannot disagree", () => {
  const start = actions.indexOf("export async function saveGithubPace");
  const body = actions.slice(start, actions.indexOf("export async function", start + 10));
  assert.ok(start > 0, "saveGithubPace exists");
  assert.match(body, /saveSourceSchedule\(/, "one write path");
  assert.match(body, /planPace\(/, "the rate is turned into a pace");
  assert.match(body, /requirePageUnlock\(\)/, "behind the page password");
});
