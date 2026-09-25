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
