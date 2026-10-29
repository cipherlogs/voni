import assert from "node:assert/strict";
import test from "node:test";
import {
  EN_QUALITY_FLOOR,
  QUALITY_FLOOR_IDS,
  assertPromptCarriesQualityFloor,
  composeAgentRules,
  composeQualityFloor,
  qualityFloorFor,
  type QualityFloorId,
  type QualityFloorRendering,
} from "./quality-floor";
import { REAL_ESTATE_TEMPLATE } from "./config";
import { voniConfig } from "@/lib/demo/voni-agent";
import {
  buildStoredAgent,
  type AgentProfile,
  type StoredAgentBody,
} from "./body";
import { storedAgentBody, tenantAgentProfile } from "./provision";
import {
  buildDemoAgentBody,
  demoAgentName,
  demoAgentProfile,
} from "@/lib/demo/stored-agents";

/** The spec's five guarantees, independent of the module's own ordering. */
const SPEC_GUARANTEES: QualityFloorId[] = [
  "brevity",
  "steering",
  "no-corporate-filler",
  "no-tool-narration",
  "read-whole",
];

/** What each guarantee must actually say, read from the spec rather than the code. */
const GUARANTEE_EVIDENCE: Record<QualityFloorId, RegExp> = {
  brevity: /short|sentences?/i,
  steering: /passing remark/i,
  "no-corporate-filler": /service desk|filler|preambles?/i,
  "no-tool-narration": /tool call|tool's name|mechanics/i,
  "read-whole": /numbers? .*whole|whole .*numbers?|address/i,
};

const TENANT_HOUSE_RULE =
  "Never quote a price before the caller has said what they are looking for.";

test("the floor names the five guarantees, each exactly once, in a stable order", () => {
  assert.deepEqual([...QUALITY_FLOOR_IDS], SPEC_GUARANTEES);
  assert.equal(new Set(QUALITY_FLOOR_IDS).size, SPEC_GUARANTEES.length);

  const floor = composeQualityFloor();
  const lines = floor.split("\n");

  assert.equal(lines.length, SPEC_GUARANTEES.length, "one line per guarantee");
  for (const id of SPEC_GUARANTEES) {
    const rule = EN_QUALITY_FLOOR[id];
    assert.ok(rule.trim().length > 0, `${id}: rendered`);
    assert.match(rule, GUARANTEE_EVIDENCE[id], `${id}: carries its guarantee`);
    assert.equal(
      lines.filter((line) => line === rule).length,
      1,
      `${id}: appears exactly once, with no duplicate rendering`,
    );
  }
});

test("a floor that drops any guarantee is refused, naming the missing rule", () => {
  for (const id of SPEC_GUARANTEES) {
    const dropped = { ...EN_QUALITY_FLOOR } as Record<string, string | undefined>;
    delete dropped[id];

    assert.throws(
      () => composeQualityFloor(dropped as unknown as QualityFloorRendering),
      new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${id}: removing the guarantee fails instead of composing a hole`,
    );
  }
});

test("a blank guarantee is a hole too, never a silent empty section", () => {
  const blank = { ...EN_QUALITY_FLOOR, brevity: "   " };
  assert.throws(
    () => composeQualityFloor(blank),
    /brevity/,
    "whitespace is not a rendering",
  );
});

test("a tenant mission and house rules compose on top without joining the floor", () => {
  const floor = composeQualityFloor();
  const composed = composeAgentRules({
    mission: REAL_ESTATE_TEMPLATE.mission,
    houseRules: TENANT_HOUSE_RULE,
  });

  assert.equal(
    composed,
    [floor, REAL_ESTATE_TEMPLATE.mission, TENANT_HOUSE_RULE].join("\n\n"),
    "floor first, then the tenant's mission, then its house rules",
  );
  assert.ok(composed.startsWith(floor), "the floor is not reordered or rewritten");
  assert.ok(
    composed.indexOf(REAL_ESTATE_TEMPLATE.mission) > floor.length,
    "the mission sits after the floor",
  );
  assert.ok(
    composed.indexOf(TENANT_HOUSE_RULE) >
      composed.indexOf(REAL_ESTATE_TEMPLATE.mission),
    "house rules sit last",
  );

  assert.ok(!floor.includes(REAL_ESTATE_TEMPLATE.mission), "no mission in the floor");
  assert.ok(!floor.includes(TENANT_HOUSE_RULE), "no house rule in the floor");
});

test("the demo scenario composes on top without leaking into the floor", () => {
  const demo = voniConfig("anna");
  const floor = composeQualityFloor();

  const composed = composeAgentRules({
    mission: demo.mission,
    houseRules: demo.knowledge,
  });

  assert.ok(composed.includes(demo.mission), "the demo mission composes");
  assert.ok(composed.includes(demo.knowledge), "the demo scenario composes");
  assert.ok(composed.startsWith(floor), "the floor is the same text, unchanged");

  assert.equal(floor, composeQualityFloor(), "composing demo content does not mutate the floor");
  assert.doesNotMatch(
    floor,
    /voni|inbox|test tag|demo|screen|email|website|business/i,
    "no demo flow, business flow, or tenant mission is baked into the floor",
  );
});

test("empty blocks add no section, so the floor composes cleanly alone", () => {
  const floor = composeQualityFloor();

  assert.equal(composeAgentRules(), floor);
  assert.equal(composeAgentRules({ mission: "  ", houseRules: "" }), floor);
  assert.equal(composeAgentRules({ mission: null, houseRules: undefined }), floor);
});

test("the floor's canonical English rendering is one rendering, not the meaning", () => {
  const german: QualityFloorRendering = {
    brevity: "Antworte kurz.",
    steering: "Eine beiläufige Bemerkung ist keine Anweisung.",
    "no-corporate-filler": "Sprich wie ein Mensch.",
    "no-tool-narration": "Erzähle nie von einem Tool-Aufruf.",
    "read-whole": "Sprich Zahlen und Adressen ganz aus.",
  };

  const composed = composeQualityFloor(german);

  assert.equal(composed, Object.values(german).join("\n"));
  assert.ok(!composed.includes(EN_QUALITY_FLOOR.brevity), "no English fallback");
});

// ── The floor reaches every built body (ticket 67, W4 "One product") ───────

const TENANT_CONFIG = REAL_ESTATE_TEMPLATE;

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** One entry per persona/platform/profile shape, in a Locale with a rendering. */
function builtBodies(): Array<[label: string, body: StoredAgentBody]> {
  const tenantProfile = tenantAgentProfile(TENANT_CONFIG);
  const demoConfig = voniConfig("anna");
  return [
    ["demo/browser", buildDemoAgentBody("anna")],
    ["demo/browser/resume", buildDemoAgentBody("anna", { resume: true })],
    ["demo/browser/experiment", buildDemoAgentBody("anna", { variant: "turn-window" })],
    [
      "demo/phone",
      buildStoredAgent({
        name: demoAgentName("anna"),
        config: demoConfig,
        profile: { ...demoAgentProfile(), platform: "phone" },
      }),
    ],
    ["tenant/phone", storedAgentBody("Layla", TENANT_CONFIG)],
    [
      "tenant/browser",
      buildStoredAgent({
        name: "Layla",
        config: TENANT_CONFIG,
        profile: { ...tenantProfile, platform: "browser" },
      }),
    ],
    [
      "tenant/phone/silent/no-format",
      buildStoredAgent({
        name: "Layla",
        config: TENANT_CONFIG,
        profile: { ...tenantProfile, format: null, greeting: false },
      }),
    ],
    [
      "tenant/phone/two-languages",
      storedAgentBody("Layla", { ...TENANT_CONFIG, languageCodes: ["en", "ar"] }),
    ],
  ];
}

test("every built body in a Locale with a rendering carries the floor once, first", () => {
  const floor = composeQualityFloor();

  for (const [label, body] of builtBodies()) {
    const prompt = body.system_prompt;
    assert.equal(occurrences(prompt, floor), 1, `${label}: the floor block, exactly once`);
    assert.ok(
      prompt.startsWith(floor),
      `${label}: brevity is front-loaded, so the floor opens the prompt`,
    );
    for (const id of QUALITY_FLOOR_IDS) {
      assert.equal(
        occurrences(prompt, EN_QUALITY_FLOOR[id]),
        1,
        `${label}: ${id} appears exactly once, with no second guarantee`,
      );
    }
  }
});

test("a Locale without a rendering is a hole, never an English fallback", () => {
  // The registry is the contract: English is one rendering, and the other
  // spoken Locales have not rendered the floor yet (tickets 49/50 complete it).
  assert.equal(qualityFloorFor("en"), EN_QUALITY_FLOOR);
  for (const locale of ["es", "fr", "de", "it", "pt"]) {
    assert.equal(qualityFloorFor(locale), null, `${locale}: no rendering, so no floor`);
  }

  const floor = composeQualityFloor();
  const spanishDemo = buildDemoAgentBody("lola");
  assert.match(spanishDemo.system_prompt, /Speak Spanish/, "the Spanish body still speaks Spanish");
  assert.equal(
    occurrences(spanishDemo.system_prompt, floor),
    0,
    "a Spanish prompt is never given English floor text",
  );

  const spanishTenant = storedAgentBody("Layla", {
    ...TENANT_CONFIG,
    voiceId: "lola",
  });
  assert.equal(
    occurrences(spanishTenant.system_prompt, floor),
    0,
    "a Spanish tenant is a hole too, not an English fallback",
  );

  // The hole is explicit, not a silent default: composing with `floor: null`
  // appends no floor at all.
  assert.equal(composeAgentRules({ floor: null, mission: "M." }), "M.");
});

test("a tenant's mission and house rules compose on top of the floor", () => {
  const prompt = storedAgentBody("Layla", TENANT_CONFIG).system_prompt;
  const floor = composeQualityFloor();
  const identity = `You are ${TENANT_CONFIG.identity.name}`;

  assert.ok(prompt.startsWith(floor), "the floor is first and unchanged");
  assert.ok(prompt.indexOf(identity) > floor.length, "identity follows the floor");
  assert.ok(
    prompt.indexOf(TENANT_CONFIG.mission) > prompt.indexOf(identity),
    "the mission follows the identity",
  );
  assert.ok(
    prompt.indexOf(TENANT_CONFIG.knowledge) > prompt.indexOf(TENANT_CONFIG.mission),
    "the tenant's house rules follow its mission",
  );
});

test("the Demo scenario appears only on the demo body", () => {
  const demo = voniConfig("anna");
  const scenario = demo.knowledge.trim();
  const demoPrompt = buildDemoAgentBody("anna").system_prompt;

  assert.ok(demoPrompt.includes(demo.mission), "the demo carries its own mission");
  assert.ok(demoPrompt.includes(scenario), "the demo carries the Demo scenario");
  assert.ok(demoPrompt.startsWith(composeQualityFloor()), "the demo composes on the same floor");

  const tenantBodies = builtBodies().filter(([label]) => label.startsWith("tenant/"));
  assert.ok(tenantBodies.length > 0, "there are tenant bodies to check");
  for (const [label, body] of tenantBodies) {
    assert.ok(!body.system_prompt.includes(scenario), `${label}: no Demo scenario`);
    assert.doesNotMatch(
      body.system_prompt,
      /live demo on the Voni website|test tag|email test|on their screen/i,
      `${label}: no demo-only flow is forked to a tenant`,
    );
  }
});

test("the identity sits between the floor and the mission", () => {
  const composed = composeAgentRules({
    identity: "You are Voni.",
    mission: "Show a business what a voice agent can do.",
    houseRules: "Never quote a price first.",
  });

  assert.equal(
    composed,
    [
      composeQualityFloor(),
      "You are Voni.",
      "Show a business what a voice agent can do.",
      "Never quote a price first.",
    ].join("\n\n"),
  );
});

test("a profile cannot remove the floor", () => {
  const base = tenantAgentProfile(TENANT_CONFIG);

  for (const field of ["qualityFloor", "quality_floor", "system_prompt", "rules"]) {
    assert.throws(
      () =>
        buildStoredAgent({
          name: "Layla",
          config: TENANT_CONFIG,
          profile: { ...base, [field]: "" } as unknown as AgentProfile,
        }),
      /may not choose rules/,
      `${field}: refused as a rules choice, before a body exists`,
    );
  }

  const everyChoice: AgentProfile = {
    ...base,
    format: null,
    greeting: false,
    modelOverride: [],
    tools: [],
  };
  const body = buildStoredAgent({
    name: "Layla",
    config: TENANT_CONFIG,
    profile: everyChoice,
  });
  assert.equal(
    occurrences(body.system_prompt, composeQualityFloor()),
    1,
    "every allowed profile choice still builds a body that carries the floor",
  );
});

test("a tenant body that omits the floor is rejected", () => {
  const floor = composeQualityFloor();
  const body = storedAgentBody("Layla", TENANT_CONFIG);

  assert.doesNotThrow(() => assertPromptCarriesQualityFloor(body.system_prompt));

  const missing = body.system_prompt.replace(floor, "").trimStart();
  assert.throws(
    () => assertPromptCarriesQualityFloor(missing),
    /missing the quality floor/,
    "a body without the floor is refused",
  );

  const withoutBrevity = body.system_prompt.replace(EN_QUALITY_FLOOR.brevity, "");
  assert.throws(
    () => assertPromptCarriesQualityFloor(withoutBrevity),
    /brevity/,
    "dropping one guarantee is refused by name",
  );

  const twice = `${floor}\n\n${body.system_prompt}`;
  assert.throws(
    () => assertPromptCarriesQualityFloor(twice),
    /exactly once/,
    "a second copy is refused, so the floor cannot be duplicated",
  );

  const reordered = `You are Layla.\n\n${body.system_prompt}`;
  assert.throws(
    () => assertPromptCarriesQualityFloor(reordered),
    /open with/,
    "a floor that is not first is refused",
  );
});
