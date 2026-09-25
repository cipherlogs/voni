import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDemoAgentBody,
  demoAgentFingerprint,
  demoAgentName,
} from "./stored-agents";
import { getPersona } from "@/lib/agents/personas";
import { END_CALL_TOOL } from "@/lib/tools/definitions";

const layla = getPersona("real-estate")!;

test("demo agent names are deterministic per persona and voice", () => {
  assert.equal(demoAgentName("real-estate", "anna"), "demo:real-estate:anna");
});

test("demo body carries call control, tuning, and per-agent vocabulary", () => {
  const body = buildDemoAgentBody(layla, "anna");
  assert.deepEqual(
    body.tools.map((tool) => tool.name),
    [END_CALL_TOOL],
  );
  assert.equal(body.input.transcription_mode, "max_accuracy");
  assert.deepEqual(body.input.turn_detection, {
    min_silence: 100,
    max_silence: 1000,
    interrupt_response: true,
    interruption_delay: 500,
  });
  assert.equal(body.input.voice_focus, "near-field");
  assert.ok(body.input.keyterms.includes("Layla"), "agent's own name is heard");
  assert.match(body.system_prompt, /end_call/, "the hang-up rule ships on demo");
  // REST shape: the Agents API tool object has no `type` field. Sending it
  // risks the tool being dropped while the prompt still mentions it — the
  // model then improvises the call as speech (`end_call{...}` out loud).
  for (const tool of body.tools) {
    assert.ok(!("type" in tool), "stored-agent tools carry no `type`");
  }
});

test("fingerprints are stable and move with platform content", () => {
  const a = demoAgentFingerprint(buildDemoAgentBody(layla, "anna"));
  const b = demoAgentFingerprint(buildDemoAgentBody(layla, "anna"));
  assert.equal(a, b);
  // A platform change (new tool description, prompt rule, tuning) must
  // invalidate the cache: any body difference flips the fingerprint.
  const changed = {
    ...buildDemoAgentBody(layla, "anna"),
    input: { ...buildDemoAgentBody(layla, "anna").input, transcription_mode: "balanced" },
  };
  assert.notEqual(demoAgentFingerprint(changed), a);
});
