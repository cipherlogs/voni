import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDemoAgentBody,
  demoAgentFingerprint,
  demoAgentName,
  demoAgentStorageKey,
} from "./stored-agents";
import { END_CALL_TOOL } from "@/lib/tools/definitions";
import { VONI_GREETINGS } from "./voni-agent";

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
  // A platform change (new tool description, prompt rule, tuning) must
  // invalidate the cache: any body difference flips the fingerprint.
  const changed = {
    ...buildDemoAgentBody("anna"),
    input: { ...buildDemoAgentBody("anna").input, transcription_mode: "max_accuracy" },
  };
  assert.notEqual(demoAgentFingerprint(changed), a);
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
    agent.HOLD_RETURN_SENT_INSTRUCTIONS,
    agent.inviteNowInstructions("Lime 42"),
    agent.testTagContext("Lime 42"),
    agent.emailArrivedInstructions(found, { fromLastCall: true }),
    agent.emailArrivedInstructions({ ...found, returning: true }),
    agent.checkEmailInstructions({ status: "not_arrived", address: null, name: null }),
    buildDemoAgentBody("anna").system_prompt,
  ];
  for (const text of lines) assert.doesNotMatch(text, /end_call|check_email|show_test_address/);
  assert.match(agent.checkEmailInstructions({ status: "free", address: "a@gmail.com" }), /hi at voni dot c c/);
  assert.match(agent.checkEmailInstructions({ status: "free", address: "a@gmail.com" }), /hang up/);
  assert.match(agent.LATE_EMAIL_INSTRUCTIONS, /reply the moment it lands/);
  assert.match(agent.emailArrivedInstructions({ ...found, returning: true }), /good to hear from them again/);
  assert.match(agent.emailArrivedInstructions(found, { fromLastCall: true }), /from an earlier call[\s\S]*Don't invite the email test again/);
  assert.doesNotMatch(buildDemoAgentBody("anna").system_prompt, /which address did you use/i, "never asked unprompted");
  assert.match(agent.inviteNowInstructions("Lime 42"), /with Lime 42 in the subject[\s\S]*Never say or spell the address/);
});
