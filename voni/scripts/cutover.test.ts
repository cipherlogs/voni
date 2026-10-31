/**
 * The cutover proof command (demo-cascade ticket 25).
 *
 * These tests exercise the operator surface the way an operator does: real
 * argv, a real (in-process) kill-switch fake, and the process exit code. The
 * live proof against a real service is run by hand; see
 * `docs/deploy/cutover-runbook.md`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CutoverUsageError,
  parseCutoverArgs,
} from "./lib/cutover";

test("--show is the read-only action", () => {
  const options = parseCutoverArgs(["--show"]);
  assert.equal(options.action, "show");
  assert.equal(options.mode, undefined);
});

test("--set demo names the mode, the operator and the reason", () => {
  const options = parseCutoverArgs([
    "--set",
    "demo",
    "--operator",
    "rehearsal",
    "--reason",
    "demo cutover rehearsal",
  ]);
  assert.equal(options.action, "set");
  assert.equal(options.mode, "demo");
  assert.equal(options.operator, "rehearsal");
  assert.equal(options.reason, "demo cutover rehearsal");
});

test("--set refuses a missing operator by name", () => {
  assert.throws(
    () => parseCutoverArgs(["--set", "demo", "--reason", "because"]),
    (error: unknown) =>
      error instanceof CutoverUsageError && /--operator/.test(error.message),
  );
});

test("--set refuses a missing reason by name", () => {
  assert.throws(
    () => parseCutoverArgs(["--set", "demo", "--operator", "ops@voni"]),
    (error: unknown) =>
      error instanceof CutoverUsageError && /--reason/.test(error.message),
  );
});

test("--set refuses an unknown mode", () => {
  assert.throws(
    () => parseCutoverArgs([
      "--set",
      "sometimes",
      "--operator",
      "ops@voni",
      "--reason",
      "because",
    ]),
    (error: unknown) =>
      error instanceof CutoverUsageError && /unknown routing mode/.test(error.message),
  );
});

test("two actions in one command are refused", () => {
  assert.throws(
    () => parseCutoverArgs(["--show", "--prove-off"]),
    (error: unknown) =>
      error instanceof CutoverUsageError && /one of --show/.test(error.message),
  );
});

test("no action is a usage error, never a guessed read", () => {
  assert.throws(
    () => parseCutoverArgs([]),
    (error: unknown) =>
      error instanceof CutoverUsageError && /one of --show/.test(error.message),
  );
});

test("--keep-off only belongs to the kill-switch proof", () => {
  assert.throws(
    () => parseCutoverArgs(["--show", "--keep-off"]),
    (error: unknown) =>
      error instanceof CutoverUsageError && /--keep-off/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// The durable switch and its audit trail
// ---------------------------------------------------------------------------

import {
  describeStore,
  flipSwitch,
  formatCutoverReport,
  parseSwitchShow,
  readSwitch,
  type CliResult,
  type CliRunner,
} from "./lib/cutover";

/** An in-memory `routing_switch.py`, with the CLI's own refusal names. */
function fakeSwitch(mode: "off" | "demo" | "all" | null): {
  runner: CliRunner;
  calls: string[][];
  view: () => ReturnType<typeof parseSwitchShow>;
} {
  const calls: string[][] = [];
  let current = mode;
  let version = mode === null ? 0 : 1;
  let decidedAt = mode === null ? 0 : 1_700_000_000;
  const changes: Record<string, unknown>[] = mode === null ? [] : [
    { at: 1_700_000_000, actor: "seed", from: "unset", to: mode, reason: "initial" },
  ];
  const runner: CliRunner = (args) => {
    calls.push(args);
    const command = args[0];
    const json = args.includes("--json");
    if (command === "show") {
      return {
        status: 0,
        stdout: `${JSON.stringify(
          current === null
            ? {
                mode: "off",
                recordVersion: null,
                decidedAt: null,
                missing: true,
                failSafe: true,
                changes: [],
              }
            : {
                mode: current,
                recordVersion: version,
                decidedAt,
                missing: false,
                failSafe: false,
                changes,
              },
        )}\n`,
        stderr: "",
      };
    }
    const modeIndex = args.indexOf("--mode");
    const next = args[modeIndex + 1];
    const operator = args[args.indexOf("--operator") + 1];
    const reason = args[args.indexOf("--reason") + 1];
    if (next === current) {
      return {
        status: 1,
        stdout: "",
        stderr: `routing-switch: routing switch is already ${next}; nothing recorded\n`,
      };
    }
    const previous = current ?? "unset";
    current = next as "off" | "demo" | "all";
    version += 1;
    decidedAt += 60;
    changes.push({ at: decidedAt, actor: operator, from: previous, to: next, reason });
    return {
      status: 0,
      stdout: json ? `${JSON.stringify({ previous, mode: next, recordVersion: version })}\n` : "flipped\n",
      stderr: "",
    };
  };
  return {
    runner,
    calls,
    view: () =>
      parseSwitchShow(
        (runner(["show", "--json"]) as CliResult).stdout,
      ),
  };
}

const STORE = {
  sqlite: "/tmp/cutover-test.sqlite3",
  databaseUrl: "",
  python: "python3",
} as const;

test("a readable switch reports its mode, version and audit, with the read cited", () => {
  const fake = fakeSwitch("demo");
  const result = readSwitch(STORE, fake.runner);
  assert.equal(result.view?.mode, "demo");
  assert.equal(result.view?.recordVersion, 1);
  assert.deepEqual(result.checks.map((check) => check.code), ["routing-switch", "audit-trail"]);
  assert.match(result.checks[0].detail, /mode "demo"/);
  assert.equal(result.checks[0].source, "routing_switch.py show --json");
  assert.match(result.checks[1].detail, /1 change/);
});

test("an unreadable switch fails by name and is never read as off", () => {
  const result = readSwitch(STORE, () => ({
    status: 1,
    stdout: "",
    stderr: "routing-switch: the durable store could not be reached\n",
  }));
  assert.equal(result.view, null);
  assert.equal(result.checks[0].ok, false);
  assert.equal(result.checks[0].code, "routing-switch-unreadable");
  assert.match(result.checks[0].detail, /could not be reached/);
});

test("a switch document that is not a switch is refused, not guessed", () => {
  assert.throws(
    () => parseSwitchShow('{"mode":"sometimes","missing":false,"recordVersion":1}'),
    /unknown mode/,
  );
  assert.throws(
    () => parseSwitchShow('{"mode":"demo","missing":false,"recordVersion":1,"decidedAt":1,"changes":[{"at":1}]}'),
    /changes\[0\]/,
  );
});

test("a flip records who, when, from and to, and the re-read proves it", () => {
  const fake = fakeSwitch("demo");
  const result = flipSwitch(STORE, fake.runner, {
    mode: "off",
    operator: "rehearsal",
    reason: "kill switch rehearsal",
  });
  assert.deepEqual(
    result.checks.map((check) => [check.code, check.ok]),
    [
      ["flip", true],
      ["audit-entry", true],
    ],
  );
  const last = fake.view();
  assert.equal(last.mode, "off");
  assert.equal(last.changes.at(-1)?.actor, "rehearsal");
  assert.equal(last.changes.at(-1)?.reason, "kill switch rehearsal");
  assert.equal(last.changes.at(-1)?.from_mode, "demo");
  assert.equal(last.changes.at(-1)?.to_mode, "off");
});

test("a no-op is refused by the CLI and reported as a failure", () => {
  const fake = fakeSwitch("demo");
  const result = flipSwitch(STORE, fake.runner, {
    mode: "demo",
    operator: "rehearsal",
    reason: "demo cutover rehearsal",
  });
  assert.equal(result.checks[0].ok, false);
  assert.equal(result.checks[0].code, "flip-refused");
  assert.match(result.checks[0].detail, /already demo/);
  // The CLI was asked once, and no audit entry was invented afterwards.
  assert.equal(fake.calls.filter((args) => args[0] === "set").length, 1);
  assert.equal(fake.view().changes.length, 1);
});

test("a write whose audit entry does not match the request fails", () => {
  // The set call reports success, but the durable record names a different
  // operator: the re-read must catch it rather than trust the write response.
  const fake = fakeSwitch("demo");
  const runner: CliRunner = (args) => {
    if (args[0] === "show") {
      return {
        status: 0,
        stdout: `${JSON.stringify({
          mode: "off",
          recordVersion: 2,
          decidedAt: 1_700_000_100,
          missing: false,
          failSafe: false,
          changes: [
            { at: 1_700_000_000, actor: "seed", from: "unset", to: "demo", reason: "initial" },
            { at: 1_700_000_100, actor: "someone-else", from: "demo", to: "off", reason: "x" },
          ],
        })}\n`,
        stderr: "",
      };
    }
    return { status: 0, stdout: "{}\n", stderr: "" };
  };
  const result = flipSwitch(STORE, runner, {
    mode: "off",
    operator: "rehearsal",
    reason: "kill switch rehearsal",
  });
  assert.equal(result.checks[0].ok, true);
  assert.equal(result.checks[1].ok, false);
  assert.equal(result.checks[1].code, "audit-entry-mismatch");
  assert.match(result.checks[1].detail, /someone-else/);
  void fake;
});

test("a failed flip is never reported as an audit entry", () => {
  const fake = fakeSwitch("demo");
  const result = flipSwitch(
    STORE,
    (args) =>
      args[0] === "show"
        ? fake.runner(args)
        : {
            status: 1,
            stdout: "",
            stderr: "routing-switch: another operator wrote first; re-read and retry\n",
          },
    { mode: "off", operator: "rehearsal", reason: "because" },
  );
  assert.deepEqual(result.checks.map((check) => check.code), ["flip-refused"]);
  assert.match(formatCutoverReport(result.checks), /FAIL\s+flip/);
});

// ---------------------------------------------------------------------------
// The kill-switch proof against a fake service
// ---------------------------------------------------------------------------

import { proveOff, type ProveOffDeps } from "./lib/cutover";
import type { DemoCascadeCall } from "../src/lib/demo/cascade-body";
import type { RealLegsSocket } from "./lib/real-legs";

const CALL = {
  agentId: "demo:audrey",
  voice: "audrey",
  callId: "call_cutover_1",
  body: {},
  signedBody: { envelope: {}, body: {} },
  bodyHash: "hash_cutover_1",
  fingerprint: "fingerprint_cutover_1",
  callToken: "ct1.test.cutover",
  envelopeTtlMs: 60_000,
  callTokenTtlMs: 60_000,
} as unknown as DemoCascadeCall;

function fakeSocket(script: { errorCode?: string | null; framesBefore?: string[] }): {
  connect: (url: string) => RealLegsSocket;
  sent: string[];
  closed: boolean;
} {
  const sent: string[] = [];
  const state = { closed: false };
  const connect = (): RealLegsSocket => {
    let onMessage: (data: string) => void = () => undefined;
    let onOpen: () => void = () => undefined;
    let onClose: () => void = () => undefined;
    return {
      send: (data) => {
        sent.push(data);
        for (const frame of script.framesBefore ?? []) onMessage(frame);
        if (script.errorCode === null) {
          onClose();
        } else {
          onMessage(
            JSON.stringify({
              type: "error",
              ...(script.errorCode ? { code: script.errorCode } : {}),
              message: "the service routes this call managed",
            }),
          );
        }
      },
      close: () => {
        state.closed = true;
      },
      onOpen: (handler) => {
        onOpen = handler;
        queueMicrotask(() => onOpen());
      },
      onMessage: (handler) => {
        onMessage = handler;
      },
      onError: () => undefined,
      onClose: (handler) => {
        onClose = handler;
      },
    };
  };
  return { connect, sent, get closed() { return state.closed; } };
}

function fakeDelivery(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        status: "accepted",
        call_id: CALL.callId,
        agent_id: CALL.agentId,
        body_hash: CALL.bodyHash,
      }),
      { status: 202, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

function proveDeps(overrides: Partial<ProveOffDeps> = {}): ProveOffDeps {
  return {
    store: STORE,
    runner: fakeSwitch("demo").runner,
    target: { httpBase: "http://127.0.0.1:8767", wsUrl: "ws://127.0.0.1:8767/v1/browser-call", local: true },
    eventsDir: "/tmp/cutover-events",
    voice: "audrey",
    timeoutMs: 2_000,
    keepOff: false,
    buildBody: async () => CALL,
    fetchImpl: fakeDelivery(),
    connect: fakeSocket({ errorCode: "managed" }).connect,
    traceExists: () => false,
    readTrace: () => "",
    sleep: async () => undefined,
    citationPath: new URL("../tests/e2e/cascade-delivery.spec.ts", import.meta.url).pathname,
    readCitation: () =>
      [
        'test("a refused cascade connect shows the demo unavailable state and opens no managed session"',
        'page.getByTestId("demo-unavailable")',
        "DEMO_UNAVAILABLE_MESSAGES.managed",
      ].join("\n"),
    ...overrides,
  };
}

test("--prove-off flips off, proves the managed refusal and restores the mode it found", async () => {
  const fake = fakeSwitch("demo");
  const result = await proveOff(proveDeps({ runner: fake.runner }));
  assert.deepEqual(
    result.checks.filter((check) => !check.ok),
    [],
  );
  assert.deepEqual(
    result.checks.map((check) => check.code),
    [
      "routing-switch",
      "audit-trail",
      "flip",
      "audit-entry",
      "signed-body",
      "delivery",
      "refusal",
      "no-vendor-work",
      "no-trace",
      "unavailable-citation",
      "flip",
      "audit-entry",
      "routing-switch",
      "audit-trail",
    ],
  );
  const last = fake.view();
  assert.equal(last.mode, "demo");
  assert.equal(last.changes.at(-1)?.actor, "cutover-check");
  assert.equal(last.changes.at(-1)?.to_mode, "demo");
});

test("--prove-off --keep-off leaves the switch off for the operator's restore", async () => {
  const fake = fakeSwitch("demo");
  const result = await proveOff(proveDeps({ runner: fake.runner, keepOff: true }));
  assert.deepEqual(result.checks.filter((check) => !check.ok), []);
  assert.equal(fake.view().mode, "off");
  assert.equal(
    result.checks.some((check) => check.code === "left-off"),
    true,
  );
});

test("a refusal other than the named kill-switch one fails the proof", async () => {
  const fake = fakeSwitch("demo");
  const result = await proveOff(
    proveDeps({
      runner: fake.runner,
      connect: fakeSocket({ errorCode: "draining" }).connect,
    }),
  );
  const refusal = result.checks.find((check) => check.code === "refusal-code");
  assert.equal(refusal?.ok, false);
  assert.match(refusal?.detail ?? "", /draining/);
  assert.equal(result.checks.some((check) => !check.ok), true);
});

test("an unnamed refusal is a failure, not an accepted refusal", async () => {
  const fake = fakeSwitch("demo");
  const result = await proveOff(
    proveDeps({
      runner: fake.runner,
      connect: fakeSocket({ errorCode: null }).connect,
    }),
  );
  const refusal = result.checks.find((check) => check.code === "refusal-code");
  assert.equal(refusal?.ok, false);
  assert.match(refusal?.detail ?? "", /no named refusal/);
});

test("audio or a caption before the refusal is vendor work and fails the proof", async () => {
  const fake = fakeSwitch("demo");
  const result = await proveOff(
    proveDeps({
      runner: fake.runner,
      connect: fakeSocket({
        errorCode: "managed",
        framesBefore: [JSON.stringify({ type: "audio", seq: 1, data: "AAAA" })],
      }).connect,
    }),
  );
  const work = result.checks.find((check) => check.code === "vendor-work");
  assert.equal(work?.ok, false);
  assert.match(work?.detail ?? "", /audio/);
});

test("a greeting row in the call's trace fails the no-vendor-work assertion", async () => {
  const fake = fakeSwitch("demo");
  const trace = [
    { schemaVersion: 1, pipeline: "cascade", callId: CALL.callId, type: "greeting.start", subject: CALL.agentId },
    { schemaVersion: 1, pipeline: "cascade", callId: CALL.callId, type: "greeting.done", subject: CALL.agentId },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  const result = await proveOff(
    proveDeps({
      runner: fake.runner,
      traceExists: () => true,
      readTrace: () => `${trace}\n`,
    }),
  );
  const traceCheck = result.checks.find((check) => check.code === "no-trace-rows");
  assert.equal(traceCheck?.ok, false);
  assert.match(traceCheck?.detail ?? "", /greeting\.start/);
  assert.equal(result.checks.some((check) => !check.ok), true);
});

test("a turn row in the call's trace also fails the no-vendor-work assertion", async () => {
  const fake = fakeSwitch("demo");
  const result = await proveOff(
    proveDeps({
      runner: fake.runner,
      traceExists: () => true,
      readTrace: () =>
        `${JSON.stringify({
          schemaVersion: 1,
          pipeline: "cascade",
          callId: CALL.callId,
          type: "turn.attribution",
          subject: CALL.agentId,
        })}\n`,
    }),
  );
  const traceCheck = result.checks.find((check) => check.code === "no-trace-rows");
  assert.equal(traceCheck?.ok, false);
  assert.match(traceCheck?.detail ?? "", /turn\.attribution/);
});

test("the unavailable state is cited from the ticket-16 rig, never re-run", async () => {
  const fake = fakeSwitch("demo");
  const result = await proveOff(
    proveDeps({
      runner: fake.runner,
      readCitation: () => "nothing useful here",
    }),
  );
  const citation = result.checks.find((check) => check.code === "unavailable-citation");
  assert.equal(citation?.ok, false);
  assert.match(citation?.source ?? "", /cascade-delivery\.spec\.ts/);
});

// ---------------------------------------------------------------------------
// The runbook pins the deploy window, the rollback and the human step
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

const RUNBOOK = new URL("../../docs/deploy/cutover-runbook.md", import.meta.url);

function runbook(): string {
  return readFileSync(RUNBOOK, "utf8");
}

test("the runbook records routing=demo as production and routing=off as the one rollback", () => {
  const text = runbook();
  assert.match(text, /routing=demo/);
  assert.match(text, /routing=off/);
  assert.match(text, /rollback/i);
  assert.match(text, /production/i);
});

test("the runbook records the one-instance deploy window and its 30-second drain", () => {
  const text = runbook();
  assert.match(text, /one instance/i);
  assert.match(text, /30[- ]second|30\s?s\b/i);
  assert.match(text, /drain/i);
  assert.match(text, /refus/i);
  assert.match(text, /unavailable/i);
});

test("the runbook says to deploy outside demo hours", () => {
  assert.match(runbook(), /outside demo hours/i);
});

test("the runbook names the pre-demo and post-deploy checks", () => {
  const text = runbook();
  assert.match(text, /parity:check/);
  assert.match(text, /check:real-legs/);
  assert.match(text, /before (a|the) demo|pre-demo/i);
  assert.match(text, /after (a|the) deploy|post-deploy/i);
});

test("the runbook cites ADR-0012 and the ticket-16 refusal rig", () => {
  const text = runbook();
  assert.match(text, /ADR-0012/);
  assert.match(text, /cascade-delivery\.spec\.ts/);
});

test("the runbook gives the exact production flip as the operator's human step", () => {
  const text = runbook();
  assert.match(text, /routing_switch\.py show/);
  assert.match(text, /routing_switch\.py set --mode demo/);
  assert.match(text, /--operator/);
  assert.match(text, /--reason/);
  assert.match(text, /--database-url "\$DATABASE_URL"/);
  assert.match(text, /human step/i);
});

test("the runbook never claims the production flip was executed here", () => {
  const text = runbook();
  assert.match(text, /has not been executed|not been executed/i);
  assert.doesNotMatch(text, /I (ran|executed) the production/i);
  // No credential, DSN with userinfo or production host is written into the doc.
  assert.doesNotMatch(text, /postgres(ql)?:\/\/[^"$\s]*@/);
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{10,}/);
});

test("the report names the store without ever printing a Postgres DSN", () => {
  const postgres = describeStore({
    sqlite: "",
    databaseUrl: "postgresql://user:secret@db.example/voni",
    python: "python3",
  });
  assert.equal(postgres, "postgres (DSN not printed)");
  assert.doesNotMatch(postgres, /user|secret|db\.example/);
  assert.equal(
    describeStore({ sqlite: "/tmp/switch.sqlite3", databaseUrl: "", python: "python3" }),
    "sqlite /tmp/switch.sqlite3",
  );
});
