import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDemoAgentBody,
  DEMO_AGENT_VARIANT,
  DEMO_LLM_BASE_URL,
  DEMO_LLM_MODEL,
  DEMO_TURN_INTERRUPTION_DELAY,
  DEMO_TURN_MAX_SILENCE,
  DEMO_TURN_MIN_SILENCE,
  demoAgentFingerprint,
  demoAgentName,
  demoAgentStorageKey,
  demoAgentVariantFromEnv,
  demoLlmOverride,
  demoTurnWindowsFromEnv,
  planDemoAgent,
  readServedDemoAgentBody,
} from "./stored-agents";
import { END_CALL_TOOL } from "@/lib/tools/definitions";
import { VONI_GREETINGS, DEMO_VOICE_IDS } from "./voni-agent";
import { VOICE_OUTPUT_VOLUME, voicePlaybackGain } from "@/lib/agents/voices";

test("the served stored body is read from the platform, never rebuilt", async () => {
  const calls: string[] = [];
  const result = await readServedDemoAgentBody("agent_stored", {
    apiKey: "test-key",
    fetchFn: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          id: "agent_stored",
          name: "demo:voni:anna",
          greeting: "Dropped body field",
          input: { turn_detection: null, language_codes: ["en"] },
          output: { volume: 1 },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  assert.deepEqual(calls, ["https://agents.assemblyai.com/v1/agents/agent_stored"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body.agentId, "agent_stored");
  assert.deepEqual(result.body.input, { turn_detection: null, language_codes: ["en"] });
});

test("a served body that cannot be read reports an error, never a body", async () => {
  const result = await readServedDemoAgentBody("agent_missing", {
    apiKey: "test-key",
    fetchFn: (async () => new Response("not found", { status: 404 })) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /agent_missing/);
});

test("a served body with no input object reports an error, never a body", async () => {
  const result = await readServedDemoAgentBody("agent_stored", {
    apiKey: "test-key",
    fetchFn: (async () =>
      new Response(JSON.stringify({ id: "agent_stored" }), { status: 200 })) as typeof fetch,
  });
  assert.equal(result.ok, false);
});

test("the served body read refuses to invent a body without an API key", async () => {
  const result = await readServedDemoAgentBody("agent_stored", {
    apiKey: null,
    fetchFn: (async () => {
      throw new Error("must not fetch without a key");
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
});

test("demo agent names are deterministic per voice", () => {
  assert.equal(demoAgentName("anna"), "demo:voni:anna");
});

test("Voni never invents a business and leaves when asked", () => {
  const prompt = buildDemoAgentBody("anna").system_prompt;
  assert.match(prompt, /only for real businesses/);
  assert.match(prompt, /Never suggest, invent, or role-play a fake/);
  assert.match(prompt, /asks to end, hang up, or says goodbye/);
});

test("Voni opens as itself, in the picked voice's language", () => {
  const english = buildDemoAgentBody("anna");
  assert.equal(english.greeting, VONI_GREETINGS.en);
  assert.match(english.system_prompt, /You are Voni/);
  assert.deepEqual(english.input.language_codes, ["en"]);
  const spanish = buildDemoAgentBody("lola");
  assert.equal(spanish.greeting, VONI_GREETINGS.es);
  assert.match(spanish.system_prompt, /Speak Spanish/);
  assert.deepEqual(spanish.input.language_codes, ["es"]);
});

test("the resume variant drops the greeting but keeps everything else", () => {
  const resume = buildDemoAgentBody("anna", { resume: true });
  assert.ok(!("greeting" in resume), "omitted greeting waits silently for the welcome-back reply");
  assert.equal(resume.name, "demo:voni:anna:resume");
  assert.equal(resume.system_prompt, buildDemoAgentBody("anna").system_prompt);
  assert.deepEqual(resume.tools, buildDemoAgentBody("anna").tools);
  assert.equal(demoAgentName("anna"), "demo:voni:anna", "regular agent unchanged");
  assert.equal(demoAgentStorageKey("anna", true), "anna:resume");
  assert.equal(demoAgentStorageKey("anna"), "anna");
  assert.notEqual(
    demoAgentFingerprint(resume),
    demoAgentFingerprint(buildDemoAgentBody("anna")),
    "the variant refreshes its own cached row, never the intro agent",
  );
});

test("the experimental variant differs from production only by identity and windows", () => {
  const production = buildDemoAgentBody("anna");
  const variant = buildDemoAgentBody("anna", {
    variant: "turn-window",
    turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
  });

  assert.equal(variant.name, "demo:voni:anna:exp");
  assert.equal(demoAgentStorageKey("anna", false, "turn-window"), "anna:exp");
  assert.equal(production.name, "demo:voni:anna");
  assert.equal(production.input.turn_detection, null, "production stays adaptive");
  assert.deepEqual(variant.input.turn_detection, {
    min_silence: 400,
    max_silence: 640,
    interruption_delay: 0,
  });
  assert.deepEqual(
    { ...variant, name: production.name, input: { ...variant.input, turn_detection: null } },
    production,
    "identity and the window are the only differences: same prompt, tools, greeting, voice, model and keyterms",
  );
});

test("an omitted window setting is ladder rung 1, and only the three fields ship", () => {
  const variant = buildDemoAgentBody("anna", { variant: "turn-window" });
  assert.deepEqual(variant.input.turn_detection, {
    min_silence: 400,
    max_silence: 640,
    interruption_delay: 0,
  });
  const withStray = buildDemoAgentBody("anna", {
    variant: "turn-window",
    turnWindows: {
      min_silence: 200,
      max_silence: 400,
      interruption_delay: 0,
      interrupt_response: true,
    } as never,
  });
  assert.deepEqual(Object.keys(withStray.input.turn_detection ?? {}), [
    "min_silence",
    "max_silence",
    "interruption_delay",
  ]);
});

test("ladder rung 3 configures interruption_delay alone, with no silence pair", () => {
  const variant = buildDemoAgentBody("anna", {
    variant: "turn-window",
    turnWindows: { interruption_delay: 0 },
  });
  assert.deepEqual(variant.input.turn_detection, { interruption_delay: 0 });
  assert.notEqual(
    demoAgentFingerprint(variant, "account"),
    demoAgentFingerprint(buildDemoAgentBody("anna"), "account"),
    "rung 3 is still its own variant row",
  );
  assert.throws(
    () => buildDemoAgentBody("anna", { variant: "turn-window", turnWindows: {} }),
    /at least one configured window/,
  );
});

test("a window change moves only the experimental variant's fingerprint", () => {
  const production = buildDemoAgentBody("anna");
  const rung1 = buildDemoAgentBody("anna", {
    variant: "turn-window",
    turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
  });
  const rung2 = buildDemoAgentBody("anna", {
    variant: "turn-window",
    turnWindows: { min_silence: 200, max_silence: 400, interruption_delay: 0 },
  });

  assert.notEqual(
    demoAgentFingerprint(rung1, "account"),
    demoAgentFingerprint(rung2, "account"),
    "the variant fingerprint covers the window, so a rung change refreshes it",
  );
  assert.notEqual(
    demoAgentFingerprint(rung1, "account"),
    demoAgentFingerprint(production, "account"),
    "the variant is never the production row",
  );
  assert.equal(
    demoAgentFingerprint(production, "account"),
    demoAgentFingerprint(buildDemoAgentBody("anna"), "account"),
    "building a variant leaves the production body's hash unchanged",
  );
});

test("a stray window object cannot reach the production body", () => {
  const production = buildDemoAgentBody("anna");
  const stray = buildDemoAgentBody("anna", {
    variant: "production",
    turnWindows: { min_silence: 1, max_silence: 2, interruption_delay: 3 },
  });
  assert.equal(stray.input.turn_detection, null);
  assert.equal(
    demoAgentFingerprint(stray, "account"),
    demoAgentFingerprint(production, "account"),
    "an unselected variant is byte-identical to production",
  );
});

test("the variant is selected only by environment, production by default", async () => {
  const keys = [
    DEMO_AGENT_VARIANT,
    DEMO_TURN_MIN_SILENCE,
    DEMO_TURN_MAX_SILENCE,
    DEMO_TURN_INTERRUPTION_DELAY,
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(await demoAgentVariantFromEnv(), "production", "no selection means production");
    assert.deepEqual(await demoTurnWindowsFromEnv(), {
      min_silence: 400,
      max_silence: 640,
      interruption_delay: 0,
    });

    const productionFingerprint = demoAgentFingerprint(buildDemoAgentBody("anna"), "account");
    process.env[DEMO_AGENT_VARIANT] = "turn-window";
    process.env[DEMO_TURN_MIN_SILENCE] = "200";
    process.env[DEMO_TURN_MAX_SILENCE] = "400";
    process.env[DEMO_TURN_INTERRUPTION_DELAY] = "0";
    assert.equal(await demoAgentVariantFromEnv(), "turn-window");
    assert.deepEqual(await demoTurnWindowsFromEnv(), {
      min_silence: 200,
      max_silence: 400,
      interruption_delay: 0,
    });
    assert.equal(
      demoAgentFingerprint(buildDemoAgentBody("anna"), "account"),
      productionFingerprint,
      "the experiment's environment never moves the production fingerprint",
    );

    process.env[DEMO_AGENT_VARIANT] = "turn-windw";
    await assert.rejects(demoAgentVariantFromEnv(), /Unknown DEMO_AGENT_VARIANT/);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("provisioning plans the variant as its own row, leaving production untouched", () => {
  const production = planDemoAgent("anna", { variant: "production" });
  const variant = planDemoAgent("anna", {
    variant: "turn-window",
    turnWindows: { min_silence: 200, max_silence: 400, interruption_delay: 0 },
  });

  assert.equal(production.storageKey, "anna");
  assert.equal(production.body.name, "demo:voni:anna");
  assert.equal(variant.storageKey, "anna:exp", "a distinct demo_agents row");
  assert.equal(variant.body.name, "demo:voni:anna:exp", "a distinct remote agent");
  assert.deepEqual(variant.body.input.turn_detection, {
    min_silence: 200,
    max_silence: 400,
    interruption_delay: 0,
  });
  assert.deepEqual(
    { ...variant.body, name: production.body.name, input: { ...variant.body.input, turn_detection: null } },
    production.body,
    "same prompt, tools, greeting, voice, model and keyterms as production",
  );
});

test("the visitor token route can only reach the variant by environment", () => {
  const route = readFileSync(
    new URL("../../app/api/demo/token/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /getOrCreateDemoAgent\(voiceId, \{ resume \}\)/);
  assert.doesNotMatch(route, /body\.variant|variant:\s*body/, "no request field selects the experiment");
});

test("the turn preset stays meaning-based on the intro and the resume agent", () => {
  for (const resume of [false, true]) {
    const body = buildDemoAgentBody("anna", { resume });
    assert.equal(
      body.input.turn_detection,
      null,
      `${resume ? "resume" : "intro"} agent: adaptive end-of-turn, never a turn-detection object`,
    );
  }
});

test("demo body carries call control, tuning, and per-agent vocabulary", () => {
  const body = buildDemoAgentBody("anna");
  assert.deepEqual(
    body.tools.map((tool) => tool.name),
    [END_CALL_TOOL, "show_test_address", "check_email", "send_code_reply", "check_code"],
  );
  assert.equal(body.input.transcription_mode, "balanced");
  assert.equal(body.input.turn_detection, null, "adaptive defaults; clears any stored object");
  assert.equal(body.input.voice_focus, "near-field");
  assert.deepEqual(body.output, { volume: 100 }, "loudest level; client gain matches voices");
  assert.ok(body.input.keyterms.includes("Voni"), "agent's own name is heard");
  assert.match(body.system_prompt, /use your hang-up tool/, "the hang-up rule ships on demo");
  // Naming the tool in prose makes the model speak it instead of calling it.
  assert.doesNotMatch(body.system_prompt, /end_call/);
  // REST shape: the Agents API tool object has no `type` field. Sending it
  // risks the tool being dropped while the prompt still mentions it — the
  // model then improvises the call as speech (`end_call{...}` out loud).
  for (const tool of body.tools) {
    assert.ok(!("type" in tool), "stored-agent tools carry no `type`");
  }
});

test("every demo voice ships the registry output level with no per-agent gain", () => {
  for (const voice of DEMO_VOICE_IDS) {
    const body = buildDemoAgentBody(voice);
    assert.deepEqual(body.output, { volume: VOICE_OUTPUT_VOLUME });
    assert.deepEqual(Object.keys(body.output), ["volume"], "no gain or loudness knob on the agent");
    assert.ok(!JSON.stringify(body).includes('"gain"'), `${voice} body carries no gain field`);
    assert.ok(voicePlaybackGain(voice) > 0, `${voice} client gain comes from the registry`);
  }
});

test("a new API key (another account) moves the fingerprint, so its agents are re-checked", () => {
  const body = buildDemoAgentBody("anna");
  assert.equal(demoAgentFingerprint(body, "key-a"), demoAgentFingerprint(body, "key-a"));
  assert.notEqual(demoAgentFingerprint(body, "key-a"), demoAgentFingerprint(body, "key-b"));
  assert.doesNotMatch(demoAgentFingerprint(body, "sk-secret-key"), /sk-secret-key/, "never stores the key");
});

test("fingerprints are stable and move with platform content", () => {
  const a = demoAgentFingerprint(buildDemoAgentBody("anna"));
  const b = demoAgentFingerprint(buildDemoAgentBody("anna"));
  assert.equal(a, b);
  // A platform change (new tool description, prompt rule, tuning, LLM) must
  // invalidate the cache: any body difference flips the fingerprint.
  const changed = {
    ...buildDemoAgentBody("anna"),
    system_prompt: `${buildDemoAgentBody("anna").system_prompt} One more rule.`,
  };
  assert.notEqual(demoAgentFingerprint(changed), a);
});

test("the fast LLM override rides the body only when supplied", () => {
  const llm = [
    {
      base_url: DEMO_LLM_BASE_URL,
      model: DEMO_LLM_MODEL,
      api_key: "sk-write-only",
    },
  ];
  const overridden = buildDemoAgentBody("anna", { llm });
  assert.deepEqual(overridden.llm, llm, "the exact connect-your-own-LLM config");
  assert.equal(overridden.name, buildDemoAgentBody("anna").name, "same agent row, same name");

  // The managed default must stay byte-identical, or every cached demo agent
  // would refresh just for shipping this.
  const managed = buildDemoAgentBody("anna");
  assert.ok(!("llm" in managed), "no key at all on the managed body");
  assert.deepEqual(
    buildDemoAgentBody("anna", { llm: [] }).llm,
    [],
    "[] is the documented revert to the managed model",
  );

  // The body is hashed whole, so a model swap refreshes the cached agent.
  assert.notEqual(
    demoAgentFingerprint(overridden, "account"),
    demoAgentFingerprint(managed, "account"),
    "a different LLM is a different fingerprint",
  );
  assert.notEqual(
    demoAgentFingerprint(overridden, "account"),
    demoAgentFingerprint(buildDemoAgentBody("anna", { llm: [{ ...llm[0], model: "openai/gpt-4.1-nano" }] }), "account"),
    "a different model is a different fingerprint too",
  );
  assert.doesNotMatch(
    demoAgentFingerprint(overridden, "account"),
    /sk-write-only/,
    "the fingerprint never carries the key",
  );
  // The resume variant must agree with its intro sibling about the LLM.
  const resume = buildDemoAgentBody("anna", { resume: true, llm });
  assert.deepEqual(resume.llm, llm);
  assert.ok(!("greeting" in resume), "resume still drops the greeting");
});

test("the LLM override comes from the gateway key, with the fast model by default", async () => {
  const keys = ["AI_GATEWAY_API_KEY", "DEMO_LLM_BASE_URL", "DEMO_LLM_MODEL", "DEMO_LLM_REASONING_EFFORT"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(await demoLlmOverride(), null, "no key, no override: managed model");

    process.env.AI_GATEWAY_API_KEY = "gw-key";
    assert.deepEqual(await demoLlmOverride(), [
      {
        base_url: DEMO_LLM_BASE_URL,
        model: DEMO_LLM_MODEL,
        api_key: "gw-key",
        reasoning_effort: "none",
      },
    ]);
    assert.equal(DEMO_LLM_MODEL, "google/gemini-2.5-flash");

    process.env.DEMO_LLM_MODEL = "google/gemini-2.5-flash";
    process.env.DEMO_LLM_BASE_URL = "https://llm.example.test/v1";
    assert.deepEqual(await demoLlmOverride(), [
      {
        base_url: "https://llm.example.test/v1",
        model: "google/gemini-2.5-flash",
        api_key: "gw-key",
        reasoning_effort: "none",
      },
    ]);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("the browser never receives the write-only LLM key", () => {
  // getOrCreateDemoAgent's result carries agentId/fingerprint/model, all safe
  // to log; the route returns only the client fields, and the key exists
  // nowhere but the agent body (write-only on the platform too).
  const route = readFileSync(
    new URL("../../app/api/demo/token/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(route, /api_key/, "the token response never names the key");
  assert.doesNotMatch(route, /\bllm\b/, "the token route never forwards the override");
  assert.match(route, /agentId: agent\.agentId/);
});

test("ladder and time-up instructions describe hanging up without naming the tool", async () => {
  const { rungInstructions, TIME_UP_INSTRUCTIONS, OPEN_BEAT_GOAL } = await import("./voni-agent");
  for (const text of [
    rungInstructions("nudge", OPEN_BEAT_GOAL),
    rungInstructions("warning", OPEN_BEAT_GOAL),
    rungInstructions("end", OPEN_BEAT_GOAL),
    TIME_UP_INSTRUCTIONS,
  ]) {
    assert.doesNotMatch(text, /end_call/);
  }
  assert.match(rungInstructions("end", OPEN_BEAT_GOAL), /hang up/);
});

test("the email-test lines never name a tool", async () => {
  const agent = await import("./voni-agent");
  const found = { status: "found", address: "a@acme.com", from: "a@acme.com", name: "Andres", exact: true, messageId: "m", threadId: "t" } as const;
  const lines = [
    agent.checkEmailInstructions({ status: "invalid" }),
    agent.checkEmailInstructions({ status: "free", address: "a@gmail.com" }),
    agent.checkEmailInstructions({ status: "not_arrived", address: "a@acme.com", name: null }),
    agent.checkEmailInstructions(found),
    agent.checkEmailInstructions({ ...found, exact: false, name: null }),
    agent.emailArrivedInstructions(found),
    agent.LATE_EMAIL_INSTRUCTIONS,
    agent.SILENCE_CHECK_IN_INSTRUCTIONS,
    agent.inviteNowInstructions("Lime 42"),
    agent.testTagContext("Lime 42"),
    agent.emailArrivedInstructions(found, { fromLastCall: true }),
    agent.emailArrivedInstructions({ ...found, returning: true }),
    agent.checkEmailInstructions({ status: "not_arrived", address: null, name: null }),
    buildDemoAgentBody("anna").system_prompt,
  ];
  for (const text of lines) assert.doesNotMatch(text, /end_call|check_email|show_test_address/);
  assert.match(agent.checkEmailInstructions({ status: "free", address: "a@gmail.com" }), /carry on the conversation warmly/);
  assert.match(agent.LATE_EMAIL_INSTRUCTIONS, /reply the moment it lands/);
  assert.match(agent.emailArrivedInstructions({ ...found, returning: true }), /good to hear from them again/);
  assert.match(agent.emailArrivedInstructions(found, { fromLastCall: true }), /from an earlier call[\s\S]*Don't invite the email test again/);
  assert.doesNotMatch(buildDemoAgentBody("anna").system_prompt, /which address did you use/i, "never asked unprompted");
  assert.match(agent.inviteNowInstructions("Lime 42"), /with Lime 42 in the subject[\s\S]*never say or spell the address/);
});
