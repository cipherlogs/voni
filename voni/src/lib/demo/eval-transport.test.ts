import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EVAL_TRANSPORTS,
  evalRunnerArgv,
  evalSummaryIdentity,
  evalToolExecutor,
  parseEvalTransport,
  parseEvalTurnWindowsArg,
  parseEvalVariantArg,
  resolveEvalVariantSelection,
  storedAgentBinding,
} from "./eval-transport";
import { DEMO_TURN_WINDOW_DEFAULTS, type DemoTurnWindows } from "./stored-agents";

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

test("the variant flag names the experiment, and a typo is a usage error", () => {
  assert.equal(parseEvalVariantArg([]), null, "no flag leaves the environment in charge");
  assert.equal(parseEvalVariantArg(["--variant", "turn-window"]), "turn-window");
  assert.equal(parseEvalVariantArg(["--variant", " production "]), "production");
  assert.throws(() => parseEvalVariantArg(["--variant", "turn-windw"]), /--variant.*turn-window/);
  assert.throws(() => parseEvalVariantArg(["--variant"]), /--variant/);
});

test("--turn-windows takes min,max,interruption_delay and can omit the silence pair", () => {
  assert.equal(parseEvalTurnWindowsArg([]), null);
  assert.deepEqual(parseEvalTurnWindowsArg(["--turn-windows", "400,640,0"]), {
    min_silence: 400,
    max_silence: 640,
    interruption_delay: 0,
  });
  // Rung 3: interruption_delay alone, no silence windows.
  assert.deepEqual(parseEvalTurnWindowsArg(["--turn-windows", "-,-,0"]), {
    interruption_delay: 0,
  });
  // Misconfiguration must never silently become a window set.
  assert.throws(() => parseEvalTurnWindowsArg(["--turn-windows", "400,640"]), /min,max,interruption_delay/);
  assert.throws(() => parseEvalTurnWindowsArg(["--turn-windows", "400,640,-1"]), /non-negative/);
  assert.throws(() => parseEvalTurnWindowsArg(["--turn-windows", "400,-,0"]), /both min_silence and max_silence/);
  assert.throws(() => parseEvalTurnWindowsArg(["--turn-windows", "640,400,0"]), /must not exceed/);
  assert.throws(() => parseEvalTurnWindowsArg(["--turn-windows", "-,-,-"]), /at least one window/);
  assert.throws(() => parseEvalTurnWindowsArg(["--turn-windows"]), /min,max,interruption_delay/);
});

test("a stored run binds production by default, the env variant when selected, the flag over it", () => {
  const envWindows: DemoTurnWindows = { min_silence: 200, max_silence: 400, interruption_delay: 0 };
  const production = resolveEvalVariantSelection({
    argv: [],
    transport: "stored",
    voiceId: "anna",
    envVariant: "production",
    envWindows,
  });
  assert.deepEqual(production, {
    variant: "production",
    variantKey: null,
    turnWindows: null,
    source: "default",
  });

  const fromEnv = resolveEvalVariantSelection({
    argv: [],
    transport: "stored",
    voiceId: "anna",
    envVariant: "turn-window",
    envWindows,
  });
  assert.deepEqual(fromEnv, {
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows: envWindows,
    source: "env",
  });

  const fromFlag = resolveEvalVariantSelection({
    argv: ["--variant", "turn-window", "--turn-windows", "400,640,0"],
    transport: "stored",
    voiceId: "anna",
    envVariant: "turn-window",
    envWindows,
  });
  assert.deepEqual(fromFlag, {
    variant: "turn-window",
    variantKey: "anna:exp",
    turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
    source: "flag",
  });
  assert.deepEqual(fromFlag.turnWindows, DEMO_TURN_WINDOW_DEFAULTS, "flag rung beats env rung");

  // An explicit production flag overrides a variant in the environment.
  assert.equal(
    resolveEvalVariantSelection({
      argv: ["--variant", "production"],
      transport: "stored",
      voiceId: "anna",
      envVariant: "turn-window",
      envWindows,
    }).variant,
    "production",
  );
});

test("windows without a variant, or any variant on inline, fails loudly", () => {
  const base = {
    transport: "stored" as const,
    voiceId: "anna",
    envVariant: "production" as const,
    envWindows: DEMO_TURN_WINDOW_DEFAULTS,
  };
  assert.throws(
    () => resolveEvalVariantSelection({ ...base, argv: ["--turn-windows", "400,640,0"] }),
    /--turn-windows requires --variant turn-window/,
  );
  assert.throws(
    () => resolveEvalVariantSelection({ ...base, transport: "inline", argv: ["--variant", "turn-window"] }),
    /inline.*never measured/,
  );
  assert.throws(
    () => resolveEvalVariantSelection({ ...base, transport: "inline", argv: ["--turn-windows", "400,640,0"] }),
    /inline.*never measured/,
  );
  assert.throws(
    () => resolveEvalVariantSelection({ ...base, transport: "inline", argv: [], envVariant: "turn-window" }),
    /inline.*never measured/,
    "an environment selection is not a loophole around the inline debug path",
  );
  // Plain inline debugging is still allowed.
  assert.equal(
    resolveEvalVariantSelection({ ...base, transport: "inline", argv: [] }).variant,
    "production",
  );
  // An explicit production deselection is a deliberate debug choice: the
  // resolved variant is production, so inline is not secretly measuring one.
  assert.equal(
    resolveEvalVariantSelection({
      ...base,
      transport: "inline",
      argv: ["--variant", "production"],
      envVariant: "turn-window",
    }).variant,
    "production",
  );
});

test("the runner argv is unchanged by default and carries each rung's flag additively", () => {
  assert.deepEqual(evalRunnerArgv({ voice: "anna", scenario: "stop-over", runs: "1" }), [
    "run",
    "eval:demo-agent",
    "--",
    "--voice",
    "anna",
    "--scenario",
    "stop-over",
    "--runs",
    "1",
  ]);
  assert.deepEqual(
    evalRunnerArgv({
      voice: "anna",
      scenario: "stop-over",
      runs: "1",
      transport: "stored",
      variant: "turn-window",
      turnWindows: { min_silence: 200, max_silence: 400, interruption_delay: 0 },
    }),
    [
      "run",
      "eval:demo-agent",
      "--",
      "--voice",
      "anna",
      "--scenario",
      "stop-over",
      "--runs",
      "1",
      "--transport",
      "stored",
      "--variant",
      "turn-window",
      "--turn-windows",
      "200,400,0",
    ],
  );
  assert.deepEqual(
    evalRunnerArgv({
      voice: "anna",
      scenario: "stop-over",
      runs: "1",
      variant: "turn-window",
      turnWindows: { interruption_delay: 0 },
    }).slice(-2),
    ["--turn-windows", "-,-,0"],
    "rung 3 keeps min/max omitted end to end",
  );
  assert.deepEqual(
    evalRunnerArgv({ voice: "anna", scenario: "stop-over", runs: "1", variant: "production" }).slice(-2),
    ["--variant", "production"],
    "an explicit production flag reaches the child so an env variant cannot win",
  );
  assert.deepEqual(
    evalRunnerArgv({
      voice: "anna",
      scenario: "stop-over",
      runs: "1",
      variant: "turn-window",
      turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
      eventsPath: "/tmp/run.jsonl",
    }).slice(-4),
    ["--turn-windows", "400,640,0", "--events", "/tmp/run.jsonl"],
    "the opt-in event stream rides the same invocation, last, without disturbing the rest",
  );
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
      variant: "production",
      variantKey: null,
      turnWindows: null,
    },
  );
  assert.deepEqual(
    evalSummaryIdentity("stored", {
      agentId: "agent_exp",
      fingerprint: "abc",
      llmModel: null,
      variant: "turn-window",
      variantKey: "anna:exp",
      turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
    }),
    {
      transport: "stored",
      agentId: "agent_exp",
      agentFingerprint: "abc",
      llmModel: "managed",
      variant: "turn-window",
      variantKey: "anna:exp",
      turnWindows: { min_silence: 400, max_silence: 640, interruption_delay: 0 },
    },
  );
  assert.deepEqual(evalSummaryIdentity("inline", null), {
    transport: "inline",
    agentId: null,
    agentFingerprint: null,
    llmModel: "managed",
    variant: "production",
    variantKey: null,
    turnWindows: null,
  });
  assert.deepEqual(
    evalSummaryIdentity("stored", null, {
      variant: "turn-window",
      variantKey: "anna:exp",
      turnWindows: { interruption_delay: 0 },
      source: "flag",
    }),
    {
      transport: "stored",
      agentId: null,
      agentFingerprint: null,
      llmModel: "managed",
      variant: "turn-window",
      variantKey: "anna:exp",
      turnWindows: { interruption_delay: 0 },
    },
    "a variant run that never bound still reports the selection, never production",
  );
});

test("the runner actually wires the stored transport, its tools, and the summary identity", () => {
  assert.match(SCRIPT, /parseEvalTransport\(process\.argv\)/);
  assert.match(SCRIPT, /getOrCreateDemoAgent\(voiceId,/);
  assert.match(SCRIPT, /variant: VARIANT_SELECTION\.variant/);
  assert.match(SCRIPT, /storedAgentBinding\(\(await storedAgentFor\(voiceId\)\)\.agentId, token\)/);
  assert.match(SCRIPT, /internals\.connect\(callToken, binding\.config, gen\)/);
  assert.match(SCRIPT, /internals\["boundAgent"\] = binding\.boundAgent/);
  assert.match(SCRIPT, /internals\["tokenFetcher"\] = binding\.tokenFetcher/);
  assert.match(SCRIPT, /toolExecutor: async \(call\) =>/);
  assert.match(SCRIPT, /assertToolsAnswered\(\)/);
  assert.match(SCRIPT, /\.\.\.evalSummaryIdentity\(TRANSPORT, storedAgent, VARIANT_SELECTION\)/);
});
