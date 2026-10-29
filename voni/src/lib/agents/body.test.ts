import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildStoredAgent,
  TENANT_LEGACY_TURN_DETECTION,
  type AgentProfile,
} from "./body";
import { REAL_ESTATE_TEMPLATE } from "./config";
import {
  deploymentFingerprint,
  storedAgentBody,
  tenantAgentProfile,
} from "./provision";
import {
  buildDemoAgentBody,
  demoAgentFingerprint,
  demoAgentName,
  demoAgentProfile,
} from "@/lib/demo/stored-agents";
import { voniConfig } from "@/lib/demo/voni-agent";

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const DEMO_LLM = [
  { base_url: "https://llm.example.test/v1", model: "m", api_key: "k" },
];

// ── One builder, two profiles ──────────────────────────────────────────────

test("the demo and tenant bodies are both built by the one builder", () => {
  const demo = buildStoredAgent({
    name: demoAgentName("anna"),
    config: voniConfig("anna"),
    profile: demoAgentProfile(),
  });
  assert.deepEqual(
    buildDemoAgentBody("anna"),
    demo,
    "the demo path is a builder call with the demo profile, not a second builder",
  );

  const tenant = buildStoredAgent({
    name: "Layla",
    config: REAL_ESTATE_TEMPLATE,
    profile: tenantAgentProfile(REAL_ESTATE_TEMPLATE),
  });
  assert.deepEqual(
    storedAgentBody("Layla", REAL_ESTATE_TEMPLATE),
    tenant,
    "the tenant path is a builder call with the tenant profile, not a second builder",
  );
});

test("every demo body variant is the same builder call with its own profile", () => {
  const resume = buildStoredAgent({
    name: demoAgentName("anna", true),
    config: voniConfig("anna"),
    profile: demoAgentProfile({ resume: true }),
  });
  assert.deepEqual(buildDemoAgentBody("anna", { resume: true }), resume);

  const withModel = buildStoredAgent({
    name: demoAgentName("anna"),
    config: voniConfig("anna"),
    profile: demoAgentProfile({ llm: DEMO_LLM }),
  });
  assert.deepEqual(buildDemoAgentBody("anna", { llm: DEMO_LLM }), withModel);

  const experiment = buildStoredAgent({
    name: demoAgentName("anna", false, "turn-window"),
    config: voniConfig("anna"),
    profile: demoAgentProfile(),
    turnTaking: {
      kind: "windows",
      windows: { min_silence: 200, max_silence: 400, interruption_delay: 0 },
    },
  });
  assert.deepEqual(
    buildDemoAgentBody("anna", {
      variant: "turn-window",
      turnWindows: { min_silence: 200, max_silence: 400, interruption_delay: 0 },
    }),
    experiment,
  );
});

// ── Existing bodies are byte-compatible ────────────────────────────────────

// Pinned from the two builders before they were unified. A change here means
// the unification altered a wire body (and would refresh every stored agent).
const PUBLISHED_BYTES = {
  demoAnna: "9554dbda4854f8df0eaf25e9bbfe3357df60427c90bc6ed48466f6a50b91b597",
  demoResume: "3583837d631550d7c37e6be83587c55909544c93e7a281e8614c4b67e608db20",
  demoModel: "3451afdccde5603b77744bb39c989762806121ac459ecf49585a327ca43dd22c",
  demoExperiment: "50391e87369a16dd2e4db59f2c62bf62edd21655b2bcf4eceaaf536068725937",
  demoLola: "fddbc7bf159546cc44cec7ff9b3c0a21af3e7f6244ac4b5338540e61773a25f0",
  tenant: "c454b3bb26cb789e3f049bbe2693d69200a695c4afb91dd58c61eca1c2f8cb64",
  tenantLanguages:
    "29e34674e289c2ab3814bfe7366c4dc89eefe16e9232e6dc6bbc818425160032",
};

test("the unified builder leaves every published body byte-identical", () => {
  assert.equal(sha(buildDemoAgentBody("anna")), PUBLISHED_BYTES.demoAnna);
  assert.equal(sha(buildDemoAgentBody("lola")), PUBLISHED_BYTES.demoLola);
  assert.equal(
    sha(buildDemoAgentBody("anna", { resume: true })),
    PUBLISHED_BYTES.demoResume,
  );
  assert.equal(
    sha(buildDemoAgentBody("anna", { llm: DEMO_LLM })),
    PUBLISHED_BYTES.demoModel,
  );
  assert.equal(
    sha(
      buildDemoAgentBody("anna", {
        variant: "turn-window",
        turnWindows: { min_silence: 200, max_silence: 400, interruption_delay: 0 },
      }),
    ),
    PUBLISHED_BYTES.demoExperiment,
  );
  assert.equal(
    sha(storedAgentBody("Layla", REAL_ESTATE_TEMPLATE)),
    PUBLISHED_BYTES.tenant,
  );
  assert.equal(
    sha(
      storedAgentBody("Layla", {
        ...REAL_ESTATE_TEMPLATE,
        languageCodes: ["en", "ar"],
      }),
    ),
    PUBLISHED_BYTES.tenantLanguages,
  );
});

test("the unified builder leaves both refresh fingerprints unchanged", () => {
  assert.equal(
    demoAgentFingerprint(buildDemoAgentBody("anna"), "key"),
    "6545bd6c7037614d673f1d0964dd70ffbcb1ec95fbc5d04f50b33ff2f3607a7d",
  );
  assert.equal(
    deploymentFingerprint("Layla", REAL_ESTATE_TEMPLATE),
    "8a2416220fe2f13eaee875f4f89592bf2a4e3ade52e75be1ec14511a4415c38b",
  );
});

// ── What a profile may choose ──────────────────────────────────────────────

function tenantBody(profile: AgentProfile) {
  return buildStoredAgent({
    name: "Layla",
    config: REAL_ESTATE_TEMPLATE,
    profile,
  });
}

test("a profile chooses the audio format", () => {
  const profile = tenantAgentProfile(REAL_ESTATE_TEMPLATE);
  const base = tenantBody(profile);
  const format = { encoding: "audio/pcm", sample_rate: 24000 };
  const changed = tenantBody({ ...profile, format });

  assert.deepEqual(changed.input.format, format);
  assert.deepEqual(changed.output.format, format);
  assert.deepEqual(
    {
      ...changed,
      input: { ...changed.input, format: base.input.format },
      output: { ...changed.output, format: base.output.format },
    },
    base,
    "the format is the only difference",
  );
});

test("a profile chooses the microphone focus", () => {
  const profile = tenantAgentProfile(REAL_ESTATE_TEMPLATE);
  const base = tenantBody(profile);
  const changed = tenantBody({
    ...profile,
    microphoneFocus: { mode: "near-field" },
  });

  assert.equal(changed.input.voice_focus, "near-field");
  assert.equal("voice_focus_threshold" in changed.input, false);
  assert.deepEqual(
    {
      ...changed,
      input: {
        ...changed.input,
        voice_focus: base.input.voice_focus,
        voice_focus_threshold: base.input.voice_focus_threshold,
      },
    },
    base,
    "the microphone focus is the only difference",
  );
});

test("a profile chooses the tool set", () => {
  const profile = tenantAgentProfile(REAL_ESTATE_TEMPLATE);
  const base = tenantBody(profile);
  const changed = tenantBody({ ...profile, tools: [] });

  assert.deepEqual(changed.tools, []);
  assert.deepEqual({ ...changed, tools: base.tools }, base, "the tools are the only difference");
});

test("a profile chooses whether a greeting is present", () => {
  const profile = tenantAgentProfile(REAL_ESTATE_TEMPLATE);
  const base = tenantBody(profile);
  assert.equal(base.greeting, REAL_ESTATE_TEMPLATE.greeting);

  const silent = tenantBody({ ...profile, greeting: false });
  assert.equal("greeting" in silent, false, "an absent greeting waits for the first reply");
  assert.deepEqual({ ...silent, greeting: base.greeting }, base);
});

test("a profile chooses the model override, and its absence omits the field", () => {
  const profile = tenantAgentProfile(REAL_ESTATE_TEMPLATE);
  const base = tenantBody(profile);
  assert.equal("llm" in base, false, "no override means the managed model, no field");

  const overridden = tenantBody({ ...profile, modelOverride: DEMO_LLM });
  assert.deepEqual(overridden.llm, DEMO_LLM);
  const rest = { ...overridden };
  delete rest.llm;
  assert.deepEqual(rest, base, "the model override is the only difference");

  assert.deepEqual(
    tenantBody({ ...profile, modelOverride: [] }).llm,
    [],
    "[] is the documented revert to the managed model",
  );
});

// ── What a profile may not choose ──────────────────────────────────────────

const FORBIDDEN: Array<[string, string]> = [
  ["system_prompt", "rules"],
  ["mission", "rules"],
  ["turn_detection", "turn-taking"],
  ["interruption_delay", "turn-taking"],
  ["keyterms", "recognition vocabulary"],
  ["transcription_prompt", "recognition vocabulary"],
  ["language_codes", "language policy"],
  ["locale", "language policy"],
];

test("a profile cannot smuggle rules, turn-taking, recognition or language through", () => {
  const profile = tenantAgentProfile(REAL_ESTATE_TEMPLATE);
  for (const [field, category] of FORBIDDEN) {
    const smuggled = { ...profile, [field]: "smuggled" } as unknown as AgentProfile;
    assert.throws(
      () =>
        buildStoredAgent({
          name: "Layla",
          config: REAL_ESTATE_TEMPLATE,
          profile: smuggled,
        }),
      new RegExp(`may not choose ${category}.*"${field}"`),
      `${field} must be rejected as ${category}, by name`,
    );
  }
});

test("a profile field nobody whitelisted is rejected rather than ignored", () => {
  const profile = { ...tenantAgentProfile(REAL_ESTATE_TEMPLATE), voiceFocus: "near-field" };
  assert.throws(
    () =>
      buildStoredAgent({
        name: "Layla",
        config: REAL_ESTATE_TEMPLATE,
        profile: profile as unknown as AgentProfile,
      }),
    /Unknown agent profile field "voiceFocus"/,
  );
});

test("the profile type admits only the whitelisted fields", () => {
  const profile: AgentProfile = {
    persona: "demo",
    platform: "browser",
    format: { encoding: "audio/pcm", sample_rate: 24000 },
    microphoneFocus: { mode: "near-field", threshold: 0.5 },
    tools: [],
    greeting: true,
    modelOverride: [],
  };
  assert.equal(profile.persona, "demo");

  // @ts-expect-error — rules are agent content, not a profile choice
  const withRules: AgentProfile = { ...profile, system_prompt: "x" };
  // @ts-expect-error — turn-taking is session mechanics, not a profile choice
  const withTurns: AgentProfile = { ...profile, turn_detection: null };
  // @ts-expect-error — recognition vocabulary is session mechanics
  const withTerms: AgentProfile = { ...profile, keyterms: [] };
  // @ts-expect-error — language policy is session mechanics
  const withLanguage: AgentProfile = { ...profile, language_codes: ["en"] };
  assert.equal([withRules, withTurns, withTerms, withLanguage].length, 4);
});

// ── Turn-taking stays the builder's, unchanged by this ticket ──────────────

test("turn-taking is the builder's, and this ticket changes neither path", () => {
  assert.equal(
    buildDemoAgentBody("anna").input.turn_detection,
    null,
    "the demo stays on the Turn preset (adaptive end-of-turn)",
  );
  assert.deepEqual(
    storedAgentBody("Layla", REAL_ESTATE_TEMPLATE).input.turn_detection,
    TENANT_LEGACY_TURN_DETECTION,
    "the tenant body still carries its pre-64 object until ticket 64/65 removes it",
  );
});

test("the turn-window experiment is demo-only and cannot be a profile field", () => {
  assert.throws(
    () =>
      buildStoredAgent({
        name: "Layla",
        config: REAL_ESTATE_TEMPLATE,
        profile: tenantAgentProfile(REAL_ESTATE_TEMPLATE),
        turnTaking: { kind: "windows", windows: { min_silence: 100 } },
      }),
    /demo-only/,
  );
  assert.throws(
    () =>
      buildStoredAgent({
        name: "demo:voni:anna:exp",
        config: voniConfig("anna"),
        profile: demoAgentProfile(),
        turnTaking: { kind: "windows", windows: {} },
      }),
    /at least one configured window/,
  );
});
