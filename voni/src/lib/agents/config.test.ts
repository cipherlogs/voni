import assert from "node:assert/strict";
import test from "node:test";
import {
  agentConfigSchema,
  normalizeConfig,
  REAL_ESTATE_TEMPLATE,
} from "./config";

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
  // `sensitive` survives: it drives mid-call endpointer widening and is
  // authored by the wizard/generator, even though the detail form has no
  // control for it.
  assert.deepEqual(parsed.data.detect, [
    { key: "budget", label: "Budget", description: "", sensitive: true },
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

test("keeps LLM tool ideas verbatim while dropping unknown executable tools", () => {
  const parsed = agentConfigSchema.safeParse({
    ...REAL_ESTATE_TEMPLATE,
    tools: ["search_properties", "send_brochure"],
    toolIdeas: [
      {
        name: "check_order_status",
        label: "Check order status",
        description: "Look up the caller's latest order by phone number.",
      },
    ],
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const normalized = normalizeConfig(parsed.data);
  assert.deepEqual(normalized.tools, ["search_properties"]);
  assert.deepEqual(normalized.toolIdeas, [
    {
      name: "check_order_status",
      label: "Check order status",
      description: "Look up the caller's latest order by phone number.",
    },
  ]);
});

test("preserves user-added custom webhook tools through normalize", () => {
  const custom = {
    id: "order_status",
    label: "Check order status",
    description: "Look up the caller's latest order by phone number.",
    mode: "interactive",
    kind: "webhook",
    url: "https://example.com/tools/order-status",
  };
  const parsed = agentConfigSchema.safeParse({
    ...REAL_ESTATE_TEMPLATE,
    customTools: [custom],
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(normalizeConfig(parsed.data).customTools, [custom]);
});

test("keeps known provider namespaced keys while dropping unknown namespaces", () => {
  const parsed = agentConfigSchema.safeParse({
    ...REAL_ESTATE_TEMPLATE,
    tools: [
      "search_properties",
      "gmail.send_email",
      "zoho.log_call",
      "google-docs.append_note",
      "outlook.send_email",
      "gmail.delete_everything",
      "not.a.real.tool.key",
    ],
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const normalized = normalizeConfig(parsed.data);
  assert.deepEqual(normalized.tools, [
    "search_properties",
    "gmail.send_email",
    "zoho.log_call",
    "google-docs.append_note",
  ]);
});

test("legacy rows without ideas or customs parse to empty lists", () => {
  const { ...legacy } = REAL_ESTATE_TEMPLATE;
  delete (legacy as { toolIdeas?: unknown }).toolIdeas;
  delete (legacy as { customTools?: unknown }).customTools;
  const parsed = agentConfigSchema.safeParse(legacy);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.toolIdeas, []);
  assert.deepEqual(parsed.data.customTools, []);
});
