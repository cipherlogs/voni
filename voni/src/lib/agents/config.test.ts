import assert from "node:assert/strict";
import test from "node:test";
import { agentConfigSchema, REAL_ESTATE_TEMPLATE } from "./config";

/**
 * `knowledge` used to be a `string[]` and stored rows were never migrated, so
 * the schema has to fold a legacy array back into one string. Without that,
 * `safeParse` rejects every pre-existing agent — which breaks saving and
 * retrying deployment on all of them, not just editing House rules.
 */

const legacyConfig = {
  ...REAL_ESTATE_TEMPLATE,
  knowledge: [
    "Never invent property information.",
    "Respect the campaign's calling-hours window.",
  ],
};

test("parses a legacy string[] knowledge into one string", () => {
  const parsed = agentConfigSchema.safeParse(legacyConfig);
  assert.equal(parsed.success, true);
  assert.equal(
    parsed.success && parsed.data.knowledge,
    "Never invent property information. Respect the campaign's calling-hours window.",
  );
});

test("drops empty and non-string entries from a legacy knowledge array", () => {
  const parsed = agentConfigSchema.safeParse({
    ...REAL_ESTATE_TEMPLATE,
    knowledge: ["  Keep it short.  ", "", "   ", 42, null],
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.knowledge, "Keep it short.");
});

test("an empty legacy array becomes an empty string, not a failure", () => {
  const parsed = agentConfigSchema.safeParse({
    ...REAL_ESTATE_TEMPLATE,
    knowledge: [],
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.knowledge, "");
});

test("a current single-string knowledge passes through untouched", () => {
  const parsed = agentConfigSchema.safeParse({
    ...REAL_ESTATE_TEMPLATE,
    knowledge: "One block of house rules.",
  });
  assert.equal(parsed.success, true);
  assert.equal(
    parsed.success && parsed.data.knowledge,
    "One block of house rules.",
  );
});

/**
 * The same stored rows also carry keys this schema no longer declares. Zod
 * strips unknown keys rather than failing, and that is what keeps legacy rows
 * loadable — assert it rather than trusting the default to stay put.
 */
test("strips fields removed from the schema instead of rejecting the row", () => {
  const parsed = agentConfigSchema.safeParse({
    ...REAL_ESTATE_TEMPLATE,
    identity: { name: "Vera", role: "coordinator", company: "Harborline" },
    detect: [
      { key: "budget", label: "Budget", description: "", sensitive: true },
    ],
    intents: ["Wants a viewing"],
    blockers: ["Budget too low"],
    successCondition: "A viewing is booked.",
    fallback: "Offer a callback.",
    followUpPolicy: "Retry tomorrow.",
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  assert.deepEqual(parsed.data.identity, { name: "Vera", role: "coordinator" });
  assert.deepEqual(parsed.data.detect, [
    { key: "budget", label: "Budget", description: "" },
  ]);
  for (const removed of [
    "intents",
    "blockers",
    "successCondition",
    "fallback",
    "followUpPolicy",
  ]) {
    assert.equal(removed in parsed.data, false, `${removed} should be stripped`);
  }
});
