import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EVAL_TRANSPORTS,
  evalSummaryIdentity,
  evalToolExecutor,
  parseEvalTransport,
  storedAgentBinding,
} from "./eval-transport";

const SCRIPT = readFileSync(new URL("../../../scripts/eval-demo-agent.mts", import.meta.url), "utf8");

test("the transport flag defaults to the real stored agent and rejects typos", () => {
  assert.equal(parseEvalTransport([]), "stored");
  assert.equal(parseEvalTransport(["--transport", "stored"]), "stored");
  assert.equal(parseEvalTransport(["--voice", "anna", "--transport", "inline"]), "inline");
  assert.deepEqual(EVAL_TRANSPORTS, ["stored", "inline"]);
  // Never a silent fallback: a typo must not quietly measure the inline body.
  assert.throws(() => parseEvalTransport(["--transport", "inline "]), /stored or inline/);
  assert.throws(() => parseEvalTransport(["--transport"]), /stored or inline/);
});

test("a stored eval call binds the agent with the same shims the browser gets", async () => {
  let minted = 0;
  const binding = storedAgentBinding("agent_123", async () => `tok-${++minted}`);
  assert.deepEqual(binding.config, { mode: "agent", agentId: "agent_123" });
  assert.equal(binding.boundAgent, true, "post-ready recognition preset is pushed");
  assert.deepEqual(await binding.tokenFetcher(), { token: "tok-1", agentId: "agent_123" });
  // A resume mints a fresh single-use token but keeps the same binding.
  assert.deepEqual(await binding.tokenFetcher(), { token: "tok-2", agentId: "agent_123" });
});

test("every tool the stored demo agent carries gets an answer", async () => {
  const routeOnly: string[] = [];
  const executor = evalToolExecutor({
    testTag: "Lime 42",
    checkEmail: async () => ({ ok: true, data: { status: "not_arrived" } }),
    onRouteOnlyTool: (name) => routeOnly.push(name),
  });
  const call = (name: string, args: Record<string, unknown> = {}) => ({ callId: `c-${name}`, name, arguments: args });

  const check = await executor(call("check_email", {}));
  assert.equal(check.ok && check.data?.status, "not_arrived");

  const show = await executor(call("show_test_address"));
  assert.equal(show.ok && show.data?.testTag, "Lime 42");
  assert.match(String(show.ok && show.data?.instructions), /Lime 42/);

  const ended = await executor(call("end_call", { closing_line: "Bye!" }));
  assert.equal(ended.ok && ended.hangup, true);
  assert.equal((await executor(call("end_call", {}))).ok, false, "no closing line, no hangup");

  // Route-only tools still answer (their turn never stalls) but say so, and
  // the runner is told so it can print it.
  for (const name of ["send_code_reply", "check_code"]) {
    const result = await executor(call(name, name === "send_code_reply" ? { warm_line: "hi" } : { code: "1234" }));
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error, `${name} needs the call's inbox thread, which this eval call does not have. Carry on without it.`);
    assert.equal(result.ok ? null : result.retryable, false);
  }
  assert.deepEqual(routeOnly, ["send_code_reply", "check_code"]);
});

test("a tool this eval cannot answer is a loud harness break, never a silent reply", async () => {
  const executor = evalToolExecutor({ checkEmail: async () => ({ ok: true, data: {} }) });
  await assert.rejects(executor({ callId: "c1", name: "book_viewing", arguments: {} }), /Unhandled demo tool/);
});

test("the summary names the transport, agent, fingerprint and model", () => {
  assert.deepEqual(
    evalSummaryIdentity("stored", {
      agentId: "agent_123",
      fingerprint: "f".repeat(64),
      llmModel: "google/gemini-2.5-flash",
    }),
    {
      transport: "stored",
      agentId: "agent_123",
      agentFingerprint: "f".repeat(64),
      llmModel: "google/gemini-2.5-flash",
    },
  );
  assert.deepEqual(evalSummaryIdentity("stored", { agentId: "agent_123", fingerprint: "abc", llmModel: null }), {
    transport: "stored",
    agentId: "agent_123",
    agentFingerprint: "abc",
    llmModel: "managed",
  });
  assert.deepEqual(evalSummaryIdentity("inline", null), {
    transport: "inline",
    agentId: null,
    agentFingerprint: null,
    llmModel: "managed",
  });
});

test("the runner actually wires the stored transport, its tools, and the summary identity", () => {
  assert.match(SCRIPT, /parseEvalTransport\(process\.argv\)/);
  assert.match(SCRIPT, /getOrCreateDemoAgent\(voiceId\)/);
  assert.match(SCRIPT, /storedAgentBinding\(\(await storedAgentFor\(voiceId\)\)\.agentId, token\)/);
  assert.match(SCRIPT, /internals\.connect\(callToken, binding\.config, gen\)/);
  assert.match(SCRIPT, /internals\["boundAgent"\] = binding\.boundAgent/);
  assert.match(SCRIPT, /internals\["tokenFetcher"\] = binding\.tokenFetcher/);
  assert.match(SCRIPT, /toolExecutor: async \(call\) =>/);
  assert.match(SCRIPT, /assertToolsAnswered\(\)/);
  assert.match(SCRIPT, /\.\.\.evalSummaryIdentity\(TRANSPORT, storedAgent\)/);
});
