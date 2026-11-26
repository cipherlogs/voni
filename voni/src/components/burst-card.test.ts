import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The burst card's outcome contract: one toast, never a second inline surface.
 *
 * A queued run carries the workflow action; a manual run carries the exact
 * `k6 cloud run` line with a copy action. Both are asserted here because the
 * two artifacts are the whole reason the toast is not just a sentence.
 */

const card = readFileSync(new URL("./burst-card.tsx", import.meta.url), "utf8");

test("a burst result is a toast only", () => {
  assert.match(card, /useActionToast\(state, "Burst not dispatched"/);
  assert.doesNotMatch(card, /<FeedbackAlert/);
  assert.doesNotMatch(card, /ManualRunFallback|FallbackPanel|BurstFeedback/);
  assert.doesNotMatch(card, /email-burst-run-link|email-burst-fallback/);
});

test("a queued burst toast opens the run in a new tab", () => {
  assert.match(card, /successTitle: command \? "Run it yourself" : "Burst dispatched"/);
  assert.match(card, /\{ label: "View run", href: state\.runUrl \}/);
  assert.match(card, /state\.message \?\? BURST_SUCCESS_DEFAULT/);
});

test("a manual burst toast carries the exact command and a copy action", () => {
  assert.match(card, /const command = state\.fallback\?\.command;/);
  assert.match(
    card,
    /<code className="[^"]*break-all whitespace-pre-wrap[^"]*">\s*\{command\}/,
    "the command wraps instead of being clipped",
  );
  assert.match(card, /\{ label: "Copy", onClick: \(\) => copyCommand\(command\) \}/);
  assert.match(card, /timeout: command \? 12_000 : undefined/);
  assert.doesNotMatch(card, /<pre/);
});

test("the plan preview still gates the dispatch and is unchanged", () => {
  assert.match(card, /data-testid="email-burst-preview"/);
  assert.match(card, /planBurst\(\{ clicks, durationSec, zoneIds: selected \}\)/);
  assert.match(card, /disabled=\{plan === null\}/);
});
