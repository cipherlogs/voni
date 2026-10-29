import assert from "node:assert/strict";
import test from "node:test";
import {
  EN_QUALITY_FLOOR,
  QUALITY_FLOOR_IDS,
  composeAgentRules,
  composeQualityFloor,
  type QualityFloorId,
  type QualityFloorRendering,
} from "./quality-floor";
import { REAL_ESTATE_TEMPLATE } from "./config";
import { voniConfig } from "@/lib/demo/voni-agent";

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
