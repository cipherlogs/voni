import test from "node:test";
import assert from "node:assert/strict";
import { executeDemoTool } from "./demo-tools";

test("end_call with a closing line hangs up", async () => {
  const result = await executeDemoTool("end_call", { closing_line: "Bye for now!" });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.hangup, true);
});

test("end_call without a closing line fails closed", async () => {
  const result = await executeDemoTool("end_call", {});
  assert.equal(result.ok, false);
});

test("tools the demo agent does not have are refused", async () => {
  const result = await executeDemoTool("book_viewing", {});
  assert.deepEqual(result, { ok: false, error: "Unknown tool.", retryable: false });
});

test("show_test_address puts the inbox and the call's tag on screen; its result is the invite", async () => {
  const result = await executeDemoTool("show_test_address", {}, { testTag: "Lime 42" });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.data.address, "test@voni.cc");
  assert.equal(result.ok && result.data.testTag, "Lime 42");
  const instructions = String(result.ok && result.data.instructions);
  assert.match(instructions, /"Lime 42"/);
  assert.match(instructions, /Say only the invite, once[\s\S]*with Lime 42 in the subject/, "Voni's own reply is the one invite");
  assert.doesNotMatch(instructions, /test@voni|test at voni/);
  assert.equal((await executeDemoTool("show_test_address", {})).ok, false, "no tag, no invite");
});

test("demo tools outlast a long invite reply, and the address is optional", async () => {
  const { DEMO_VOICE_TOOLS } = await import("./demo-tools");
  for (const tool of DEMO_VOICE_TOOLS.filter((t) => t.name !== "end_call")) {
    assert.ok(tool.timeout_seconds >= 30, `${tool.name}: ${tool.timeout_seconds}s`);
  }
  const check = DEMO_VOICE_TOOLS.find((t) => t.name === "check_email");
  assert.equal((check?.parameters as { required?: string[] }).required, undefined);
});

test("the reply and the code check are route tools, never answered in the browser", async () => {
  const { DEMO_VOICE_TOOLS } = await import("./demo-tools");
  const reply = DEMO_VOICE_TOOLS.find((t) => t.name === "send_code_reply");
  const check = DEMO_VOICE_TOOLS.find((t) => t.name === "check_code");
  assert.deepEqual((reply?.parameters as { required?: string[] }).required, ["warm_line"]);
  assert.deepEqual((check?.parameters as { required?: string[] }).required, ["code"]);
  assert.equal((await executeDemoTool("send_code_reply", { warm_line: "hi" })).ok, false);
  assert.equal((await executeDemoTool("check_code", { code: "1234" })).ok, false);
});
