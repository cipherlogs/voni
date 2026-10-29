import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildStoredAgent,
  TENANT_LEGACY_TURN_DETECTION,
  type AgentProfile,
  type StoredAgentBody,
} from "./body";
import { agentBodyFingerprint } from "./fingerprint";
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
// Ticket 64 moves only the two tenant pins: their `turn_detection` object
// became the Turn preset (`null`). Every demo pin is unchanged, which is the
// proof the demo body is byte-identical.
const PUBLISHED_BYTES = {
  demoAnna: "9554dbda4854f8df0eaf25e9bbfe3357df60427c90bc6ed48466f6a50b91b597",
  demoResume: "3583837d631550d7c37e6be83587c55909544c93e7a281e8614c4b67e608db20",
  demoModel: "3451afdccde5603b77744bb39c989762806121ac459ecf49585a327ca43dd22c",
  demoExperiment: "50391e87369a16dd2e4db59f2c62bf62edd21655b2bcf4eceaaf536068725937",
  demoLola: "fddbc7bf159546cc44cec7ff9b3c0a21af3e7f6244ac4b5338540e61773a25f0",
  tenant: "57650aa5dd12bb77dc1f3efc91919b067b584e194072e27fda84f135a574896f",
  tenantLanguages:
    "6248ce46d206ff1ba3f6cc3a4f59dbf2991e9836492c86f991cedb5ec77a48f7",
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

test("the demo refresh fingerprint is unchanged by the unification", () => {
  assert.equal(
    demoAgentFingerprint(buildDemoAgentBody("anna"), "key"),
    "6545bd6c7037614d673f1d0964dd70ffbcb1ec95fbc5d04f50b33ff2f3607a7d",
  );
});

// ── One fingerprint over the whole body (ticket 62) ────────────────────────

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Every path at which two JSON-ish values differ. */
function changedPaths(before: unknown, after: unknown, at = ""): string[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      changedPaths(before[key], after[key], at ? `${at}.${key}` : key),
    );
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((item, index) =>
      changedPaths(item, after[index], `${at}[${index}]`),
    );
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [at];
}

test("demo and tenant refresh paths hash with the one whole-body function", () => {
  const demo = buildDemoAgentBody("anna");
  const tenant = storedAgentBody("Layla", REAL_ESTATE_TEMPLATE);

  assert.equal(
    demoAgentFingerprint(demo, "account"),
    agentBodyFingerprint(demo, "account"),
    "the demo path is the one function, not a second implementation",
  );
  assert.equal(
    deploymentFingerprint("Layla", REAL_ESTATE_TEMPLATE),
    agentBodyFingerprint(tenant),
    "the tenant path is the one function, not a second implementation",
  );

  // Both personas, both platforms, one shape: an overridden demo body is
  // hashed by exactly the same function as the tenant body above.
  const overridden = buildDemoAgentBody("anna", { llm: DEMO_LLM });
  assert.equal(demoAgentFingerprint(overridden, "account"), agentBodyFingerprint(overridden, "account"));
});

test("the fingerprint covers every field of the stored body", () => {
  const base = storedAgentBody("Layla", REAL_ESTATE_TEMPLATE);
  assert.ok("greeting" in base, "the base body opens with a greeting");
  assert.ok(base.input.format, "the base body declares an audio format");
  assert.ok(base.input.voice_focus_threshold !== undefined, "the base body declares a focus threshold");
  assert.ok(!("llm" in base), "the base body has no model override");

  const mutate = (change: (body: StoredAgentBody) => void): StoredAgentBody => {
    const body = copy(base);
    change(body);
    return body;
  };

  // Every authored field; the path is the only difference the fingerprint sees.
  const mutations: Array<[path: string, body: StoredAgentBody]> = [
    ["name", mutate((body) => { body.name = `${body.name} 2`; })],
    ["system_prompt", mutate((body) => { body.system_prompt += "\nOne more rule."; })],
    ["greeting", mutate((body) => { body.greeting = `${body.greeting} Welcome.`; })],
    ["greeting", mutate((body) => { delete body.greeting; })],
    ["voice.voice_id", mutate((body) => { body.voice.voice_id = "lola"; })],
    ["output.volume", mutate((body) => { body.output.volume -= 1; })],
    ["output.voice", mutate((body) => { body.output.voice = "lola"; })],
    ["output.format.sample_rate", mutate((body) => { body.output.format!.sample_rate = 16000; })],
    ["tools[0].description", mutate((body) => { body.tools[0].description += " Updated."; })],
    ["tools", mutate((body) => { body.tools = []; })],
    ["llm", mutate((body) => { body.llm = copy(DEMO_LLM); })],
    ["llm", mutate((body) => { body.llm = []; })],
    ["input.format.encoding", mutate((body) => { body.input.format!.encoding = "audio/pcm"; })],
    ["input.language_codes", mutate((body) => { body.input.language_codes = ["en", "ar"]; })],
    ["input.transcription_mode", mutate((body) => { body.input.transcription_mode = "manual"; })],
    ["input.transcription_prompt", mutate((body) => { body.input.transcription_prompt += " Expect digits."; })],
    ["input.keyterms", mutate((body) => { body.input.keyterms.push("Layla"); })],
    ["input.voice_focus", mutate((body) => { body.input.voice_focus = "near-field"; })],
    ["input.voice_focus_threshold", mutate((body) => { body.input.voice_focus_threshold = 0.5; })],
    ["input.turn_detection", mutate((body) => { body.input.turn_detection = { ...TENANT_LEGACY_TURN_DETECTION }; })],
  ];

  const seen = new Map<string, string>([[agentBodyFingerprint(base), "the base body"]]);
  for (const [path, mutated] of mutations) {
    assert.deepEqual(changedPaths(base, mutated), [path], `${path}: the field is the only difference`);
    const fingerprint = agentBodyFingerprint(mutated);
    const collision = seen.get(fingerprint);
    assert.equal(collision, undefined, `${path} must not fingerprint like ${collision}`);
    seen.set(fingerprint, path);
  }
  assert.equal(seen.size, mutations.length + 1, "every field moves the fingerprint on its own");
});

test("a body that differs only by the model override is a different fingerprint", () => {
  const managed = storedAgentBody("Layla", REAL_ESTATE_TEMPLATE);
  const withLlm = (body: StoredAgentBody, llm: StoredAgentBody["llm"]): StoredAgentBody => ({
    ...copy(body),
    llm,
  });
  const overridden = withLlm(managed, copy(DEMO_LLM));
  const reverted = withLlm(managed, []);

  assert.deepEqual(
    changedPaths(managed, overridden),
    ["llm"],
    "the override is the only difference between the two bodies",
  );
  assert.notEqual(
    agentBodyFingerprint(overridden),
    agentBodyFingerprint(managed),
    "an override the tenant subset used to omit is now inside the fingerprint",
  );
  assert.notEqual(
    agentBodyFingerprint(reverted),
    agentBodyFingerprint(managed),
    "the documented revert is distinguishable from an absent override",
  );
  assert.notEqual(agentBodyFingerprint(reverted), agentBodyFingerprint(overridden));
});

test("an unchanged body keeps its fingerprint, whatever the key order", () => {
  const body = storedAgentBody("Layla", REAL_ESTATE_TEMPLATE);

  assert.equal(agentBodyFingerprint(copy(body)), agentBodyFingerprint(body));
  assert.equal(
    agentBodyFingerprint(storedAgentBody("Layla", REAL_ESTATE_TEMPLATE)),
    agentBodyFingerprint(body),
  );

  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reversed);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record).reverse().map((key) => [key, reversed(record[key])]),
      );
    }
    return value;
  };
  const reordered = reversed(body) as StoredAgentBody;
  assert.notDeepEqual(Object.keys(reordered), Object.keys(body), "the key order really changed");
  assert.equal(agentBodyFingerprint(reordered), agentBodyFingerprint(body));
});

// The tenant fingerprint moved in ticket 62: it used to hash the read-back
// subset (which omitted the model override). Pinned so a later change to the
// whole-body contract is a reviewable diff, not a silent refresh of every
// deployed tenant agent.
//
// It moved again in ticket 64: the body swapped the explicit turn-detection
// object for the Turn preset (`turn_detection: null`), so every tenant agent is
// owed exactly one redeploy. The pre-64 value is kept so the change is proved,
// not merely repinned.
const PRE_64_TENANT_FINGERPRINT =
  "0006f91074018cfb8cc554d8d82e6691f3f3299040d0b3ea08dfb8c5403d06ce";

test("the tenant fingerprint moves when the Turn preset replaces the legacy object", () => {
  const fingerprint = deploymentFingerprint("Layla", REAL_ESTATE_TEMPLATE);
  assert.notEqual(
    fingerprint,
    PRE_64_TENANT_FINGERPRINT,
    "the body changed, so the stored fingerprint must change with it",
  );
  assert.equal(
    fingerprint,
    "dbbed9a5d246f2efee8fd83fd626e9035c25621969427e97d55511dee60b95cc",
    "the post-64 tenant fingerprint is pinned",
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

// ── The Turn preset reaches every agent (ticket 64) ────────────────────────

// `CONTEXT.md` **Turn preset**: "The single turn-taking setting shared by every
// demo call, test call, and copilot session: meaning-based end-of-turn, and a
// barge-in delay that holds out while the agent explains and drops while it
// asks something." A stored body sends `turn_detection: null`; any object
// disables adaptive end-of-turn and measured 3.6–4.7s replies (ADR-0003).
test("the Turn preset reaches every persona and platform, browser and phone", () => {
  const demoConfig = voniConfig("anna");
  const tenantConfig = REAL_ESTATE_TEMPLATE;

  const bodies: Array<[label: string, body: StoredAgentBody]> = [
    ["demo/browser", buildDemoAgentBody("anna")],
    [
      "demo/phone",
      buildStoredAgent({
        name: "demo:voni:anna",
        config: demoConfig,
        profile: { ...demoAgentProfile(), platform: "phone" },
      }),
    ],
    ["tenant/phone", storedAgentBody("Layla", tenantConfig)],
    [
      "tenant/browser",
      buildStoredAgent({
        name: "Layla",
        config: tenantConfig,
        profile: { ...tenantAgentProfile(tenantConfig), platform: "browser" },
      }),
    ],
  ];

  for (const [label, body] of bodies) {
    assert.ok(
      "turn_detection" in body.input,
      `${label}: the body shape is unchanged; null is how the Turn preset is sent`,
    );
    assert.equal(
      body.input.turn_detection,
      null,
      `${label}: the Turn preset (meaning-based end-of-turn), never an object`,
    );
  }
});

test("no profile can produce the tenant legacy turn-detection object", () => {
  const profiles: AgentProfile[] = [
    demoAgentProfile(),
    demoAgentProfile({ resume: true }),
    { ...demoAgentProfile(), platform: "phone" },
    tenantAgentProfile(REAL_ESTATE_TEMPLATE),
    { ...tenantAgentProfile(REAL_ESTATE_TEMPLATE), platform: "browser" },
    { ...tenantAgentProfile(REAL_ESTATE_TEMPLATE), format: null, greeting: false },
  ];

  for (const profile of profiles) {
    const body = buildStoredAgent({
      name: "Layla",
      config: REAL_ESTATE_TEMPLATE,
      profile,
    });
    assert.equal(
      body.input.turn_detection,
      null,
      `${profile.persona}/${profile.platform}: profile cannot reintroduce the legacy object`,
    );
    assert.notDeepEqual(
      body.input.turn_detection,
      TENANT_LEGACY_TURN_DETECTION,
      `${profile.persona}/${profile.platform}: the pre-64 object is unreachable`,
    );
  }

  // The explicit preset input is the same value as the default; the legacy
  // constant survives only for ticket 65's removal proof.
  assert.equal(
    buildStoredAgent({
      name: "Layla",
      config: REAL_ESTATE_TEMPLATE,
      profile: tenantAgentProfile(REAL_ESTATE_TEMPLATE),
      turnTaking: { kind: "preset" },
    }).input.turn_detection,
    null,
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
