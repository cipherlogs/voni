import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStoredAgent,
  type AgentProfile,
  type StoredAgentBody,
} from "./body";
import { REAL_ESTATE_TEMPLATE } from "./config";
import { storedAgentBody, tenantAgentProfile } from "./provision";
import { composeQualityFloor } from "./quality-floor";
import {
  assertMechanicsParity,
  mechanicsDrift,
  mechanicsOf,
  type SessionMechanic,
} from "./mechanics-parity";
import {
  buildDemoAgentBody,
  demoAgentName,
  demoAgentProfile,
} from "@/lib/demo/stored-agents";
import { voniConfig } from "@/lib/demo/voni-agent";

/**
 * Tenant/demo mechanics parity (voice-parity ticket 68, spec W4 "One product").
 *
 * The demo and a tenant agent are built by one builder, but a configuration
 * assertion is still owed: Turn preset, transcription mode, quality floor and
 * recognition policy are the product's promises, so a body that drifts on any
 * of them must fail a test instead of surprising a customer.
 *
 * Everything here is asserted on BUILT BODIES — the exact `StoredAgentBody` a
 * visitor or a caller receives — never on profile/config input types. The
 * mutations below are made to a built body precisely because that is what the
 * assertion has to notice.
 */

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** An English-bound tenant: the Locale the demo reference speaks. */
const EN_TENANT_CONFIG = {
  ...REAL_ESTATE_TEMPLATE,
  languageCodes: ["en"],
};

const DEMO_BROWSER = buildDemoAgentBody("anna");

const DEMO_PHONE = buildStoredAgent({
  name: demoAgentName("anna"),
  config: voniConfig("anna"),
  profile: { ...demoAgentProfile(), platform: "phone" },
});

function tenantBody(
  config = EN_TENANT_CONFIG,
  patch: Partial<AgentProfile> = {},
): StoredAgentBody {
  return buildStoredAgent({
    name: "Layla",
    config,
    profile: { ...tenantAgentProfile(config), ...patch },
  });
}

const TENANT_PHONE = tenantBody();
const TENANT_BROWSER = tenantBody(EN_TENANT_CONFIG, { platform: "browser" });

const PAIRS: Array<
  [label: string, demo: StoredAgentBody, tenant: StoredAgentBody]
> = [
  ["demo/browser vs tenant/phone", DEMO_BROWSER, TENANT_PHONE],
  ["demo/browser vs tenant/browser", DEMO_BROWSER, TENANT_BROWSER],
  ["demo/phone vs tenant/phone", DEMO_PHONE, TENANT_PHONE],
  ["demo/phone vs tenant/browser", DEMO_PHONE, TENANT_BROWSER],
];

const MECHANICS: SessionMechanic[] = [
  "Turn preset",
  "transcription mode",
  "quality floor",
  "recognition policy",
];

// ── The matching body passes ───────────────────────────────────────────────

test("an English-bound tenant matches the demo's mechanics on browser and phone", () => {
  for (const [label, demo, tenant] of PAIRS) {
    assert.deepEqual(
      mechanicsDrift(demo, tenant),
      [],
      `${label}: no mechanic drifts`,
    );
    assert.doesNotThrow(
      () => assertMechanicsParity(demo, tenant),
      `${label}: the parity assertion accepts a matching body`,
    );
  }
});

test("automatic detection is the documented English scaffolding, so it matches a pinned English demo", () => {
  // REAL_ESTATE_TEMPLATE pins no language; the demo pins its voice's Locale.
  // Both run the same English recognition policy — automatic detection is the
  // one documented exception, not a second policy.
  const automatic = storedAgentBody("Layla", REAL_ESTATE_TEMPLATE);
  assert.equal(
    automatic.input.language_codes,
    undefined,
    "the automatic tenant really carries no pinned codes",
  );
  assert.deepEqual(mechanicsDrift(DEMO_BROWSER, automatic), []);
});

test("the assertion compares mechanics, not the rest of the profile", () => {
  // A tenant is allowed to differ on format, microphone focus, tools, greeting
  // and model override. None of those is a session mechanic, so parity holds.
  const differentProfile = buildStoredAgent({
    name: "Layla (hold rejoin)",
    config: EN_TENANT_CONFIG,
    profile: {
      ...tenantAgentProfile(EN_TENANT_CONFIG),
      format: null,
      microphoneFocus: { mode: "near-field" },
      tools: [],
      greeting: false,
      modelOverride: [],
    },
  });

  assert.deepEqual(
    mechanicsDrift(DEMO_BROWSER, differentProfile),
    [],
    "a legitimate profile difference is not reported as mechanic drift",
  );
});

test("the mechanics are read from the built body, not from a config or an input type", () => {
  const body = tenantBody();
  const mechanics = mechanicsOf(body);

  assert.equal(mechanics.turn_preset, body.input.turn_detection);
  assert.equal(mechanics.transcription_mode, body.input.transcription_mode);
  assert.equal(
    body.input.turn_detection,
    null,
    "the Turn preset is the body's null",
  );
  assert.equal(body.input.transcription_mode, "balanced");

  const mutated = copy(body);
  mutated.input.turn_detection = { min_silence: 200 };
  mutated.input.transcription_mode = "max_accuracy";
  const after = mechanicsOf(mutated);
  assert.deepEqual(after.turn_preset, { min_silence: 200 });
  assert.equal(after.transcription_mode, "max_accuracy");
});

// ── Each mechanic drifts and fails by name ─────────────────────────────────

type DriftCase = {
  mechanic: SessionMechanic;
  mutate: (body: StoredAgentBody) => void;
  /** Evidence in the failure text, beyond the mechanic's own name. */
  evidence: RegExp;
};

const DRIFT_CASES: DriftCase[] = [
  {
    mechanic: "Turn preset",
    mutate: (body) => {
      body.input.turn_detection = { min_silence: 200, max_silence: 400 };
    },
    evidence: /turn_detection/,
  },
  {
    mechanic: "transcription mode",
    mutate: (body) => {
      body.input.transcription_mode = "max_accuracy";
    },
    evidence: /max_accuracy/,
  },
  {
    mechanic: "quality floor",
    mutate: (body) => {
      body.system_prompt = body.system_prompt
        .replace(composeQualityFloor(), "")
        .trimStart();
    },
    evidence: /missing the quality floor/,
  },
  {
    mechanic: "recognition policy",
    mutate: (body) => {
      body.input.language_codes = ["es"];
    },
    evidence: /"es"/,
  },
];

test("a tenant body with a different Turn preset fails, naming the Turn preset", () => {
  const tenant = copy(TENANT_PHONE);
  tenant.input.turn_detection = { min_silence: 200, max_silence: 400 };

  assert.throws(
    () => assertMechanicsParity(DEMO_BROWSER, tenant),
    /Turn preset/,
    "an explicit turn-detection object is drift, and the mechanic is named",
  );
});

test("a tenant body with a different transcription mode fails, naming the mode", () => {
  const tenant = copy(TENANT_PHONE);
  tenant.input.transcription_mode = "max_accuracy";

  assert.throws(
    () => assertMechanicsParity(DEMO_BROWSER, tenant),
    /transcription mode/,
    "a different transcription mode is drift, and the mechanic is named",
  );
});

test("a tenant body missing the floor fails by name", () => {
  const tenant = copy(TENANT_PHONE);
  // Construct the body the builder refuses to make: a built body whose prompt
  // no longer carries the persona-neutral floor.
  tenant.system_prompt = tenant.system_prompt
    .replace(composeQualityFloor(), "")
    .trimStart();
  assert.ok(
    !tenant.system_prompt.startsWith(composeQualityFloor()),
    "the constructed body really lost the floor",
  );

  assert.throws(
    () => assertMechanicsParity(DEMO_BROWSER, tenant),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /quality floor/, "the mechanic is named");
      assert.match(
        error.message,
        /missing the quality floor/,
        "the guarantee that is missing is named too",
      );
      return true;
    },
  );
});

test("dropping one guarantee is drift too, named by guarantee", () => {
  const tenant = copy(TENANT_PHONE);
  tenant.system_prompt = tenant.system_prompt.replace(
    "Keep every reply short",
    "Keep every reply",
  );

  assert.throws(
    () => assertMechanicsParity(DEMO_BROWSER, tenant),
    /quality floor[\s\S]*brevity|brevity[\s\S]*quality floor/,
    "a body that lost brevity fails, naming the guarantee",
  );
});

test("a tenant body with a different recognition policy fails, naming the policy", () => {
  const tenant = copy(TENANT_PHONE);
  tenant.input.language_codes = ["es"];

  assert.throws(
    () => assertMechanicsParity(DEMO_BROWSER, tenant),
    /recognition policy/,
    "a recognition policy that is not the demo's is drift, and the mechanic is named",
  );
});

test("every mechanic's drift is reported on its own, with the mechanic named", () => {
  assert.deepEqual(
    DRIFT_CASES.map((item) => item.mechanic),
    MECHANICS,
    "each of the four mechanics has its own drift case",
  );

  for (const { mechanic, mutate, evidence } of DRIFT_CASES) {
    const tenant = copy(TENANT_PHONE);
    mutate(tenant);

    const drifts = mechanicsDrift(DEMO_BROWSER, tenant);
    assert.deepEqual(
      drifts.map((drift) => drift.mechanic),
      [mechanic],
      `${mechanic}: drift is reported for this mechanic and only this one`,
    );

    assert.throws(
      () => assertMechanicsParity(DEMO_BROWSER, tenant),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes(mechanic),
          `${mechanic}: the failure names the mechanic`,
        );
        assert.match(
          error.message,
          evidence,
          `${mechanic}: the failure carries its evidence`,
        );
        return true;
      },
    );
  }
});

// ── The floor is a guarantee, never a hole that passes ─────────────────────

test("a non-English floor is reported as a hole, never a silent pass", () => {
  const spanishDemo = buildDemoAgentBody("lola");
  const spanishTenant = storedAgentBody("Layla", {
    ...REAL_ESTATE_TEMPLATE,
    voiceId: "lola",
    languageCodes: ["es"],
  });

  const drifts = mechanicsDrift(spanishDemo, spanishTenant);
  const holes = drifts.filter(
    (drift) => drift.mechanic === "quality floor" && drift.kind === "hole",
  );

  assert.equal(
    holes.length,
    2,
    "both non-English bodies report their missing floor rendering as a hole",
  );
  for (const hole of holes) {
    assert.match(hole.detail, /"es"/, "the hole names the Locale");
    assert.match(
      hole.detail,
      /49\/50/,
      "the hole names the ticket that closes it",
    );
    assert.match(
      hole.detail,
      /never replaced with English/i,
      "the hole is not a fallback",
    );
  }

  assert.throws(
    () => assertMechanicsParity(spanishDemo, spanishTenant),
    /quality floor \(hole\)/,
    "two identical holes do not compare equal; the missing rendering is a FAIL",
  );
});

test("a non-English body is never given the English floor", () => {
  const spanish = storedAgentBody("Layla", {
    ...REAL_ESTATE_TEMPLATE,
    voiceId: "lola",
    languageCodes: ["es"],
  });

  assert.ok(
    !spanish.system_prompt.startsWith(composeQualityFloor()),
    "the Spanish prompt is not opened with English floor text",
  );
  assert.equal(
    mechanicsOf(spanish).quality_floor.status,
    "hole",
    "the mechanics report the floor as a hole",
  );
});

// ── The assertion is the whole set, not a sample ───────────────────────────

test("the drift report is empty exactly when the assertion passes", () => {
  const drifts = mechanicsDrift(DEMO_BROWSER, TENANT_PHONE);
  assert.deepEqual(drifts, []);
  assert.doesNotThrow(() => assertMechanicsParity(DEMO_BROWSER, TENANT_PHONE));

  const drifted = copy(TENANT_PHONE);
  drifted.input.transcription_mode = "max_accuracy";
  assert.ok(mechanicsDrift(DEMO_BROWSER, drifted).length > 0);
  assert.throws(() => assertMechanicsParity(DEMO_BROWSER, drifted));
});
