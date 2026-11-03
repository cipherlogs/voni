/**
 * The key-gated real-legs check (demo-cascade ticket 22).
 *
 * Two seams are exercised here, both without a vendor key:
 *
 *  1. The command's own surface: the skip decision, flag parsing, target
 *     derivation, the printed report and the exit code. These are what an
 *     operator reads and what the no-key run proves.
 *  2. The call's flow against a fake service over the real wire: a real
 *     `POST /v1/call-body` and a real WebSocket handshake, with the app's own
 *     body builder and signer producing the bytes. The fake verifies the call
 *     token with the app's verifier, then scripts a greeting, three caller
 *     turns, audio, the trace artifact and the `cost.priced` row. The third
 *     turn spends the hidden context note (the second connection's history
 *     also proves the hold return).
 *
 * A missing `META_API_KEY` / `ASSEMBLYAI_API_KEY` must never stop this file:
 * the flow test injects values into the environment it controls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  INGRESS_FRAME_BYTES,
  INGRESS_FRAME_MS,
  KEY_SKIP_REASON,
  TURN_TAIL_MS,
  UsageError,
  assessTrace,
  carriedHistory,
  createIngressPump,
  defaultCallerClip,
  formatRealLegsReport,
  loadCallerAudio,
  parseRealLegsArgs,
  realLegsExitCode,
  resolveTargets,
  runRealLegs,
  skipDecision,
  type RealLegsCheck,
  type RealLegsOptions,
} from "./lib/real-legs";
import { verifyCallToken } from "../src/lib/voice/cascade-token";
import { envelopeBodyHash } from "../src/lib/voice/envelope";
import {
  DEMO_VOICE_IDS,
  rungInstructions,
} from "../src/lib/demo/voni-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const VONI_ROOT = resolve(HERE, "..");
const SCRIPT = resolve(HERE, "real-legs.mts");
const CI_WORKFLOW = resolve(VONI_ROOT, "../.github/workflows/ci.yml");
const PACKAGE_JSON = resolve(VONI_ROOT, "package.json");

const require = createRequire(import.meta.url);

function env(pairs: Record<string, string | undefined>): Record<string, string | undefined> {
  return pairs;
}

function check(
  name: string,
  code: string,
  status: "pass" | "fail" | "skip" | "info",
  detail: string,
): RealLegsCheck {
  return { name, code, status, detail };
}

// --------------------------------------------------------------------------
// The skip decision
// --------------------------------------------------------------------------

test("the check is skipped by name when either real vendor key is absent", () => {
  for (const missing of [
    { META_API_KEY: undefined, ASSEMBLYAI_API_KEY: "aai-test" },
    { META_API_KEY: "meta-test", ASSEMBLYAI_API_KEY: undefined },
    { META_API_KEY: undefined, ASSEMBLYAI_API_KEY: undefined },
    { META_API_KEY: "", ASSEMBLYAI_API_KEY: "aai-test" },
    { META_API_KEY: "meta-test", ASSEMBLYAI_API_KEY: "   " },
  ]) {
    const decision = skipDecision(env(missing));
    assert.equal(decision.skip, true, `must skip for ${JSON.stringify(missing)}`);
    assert.equal(decision.skip && decision.reason, KEY_SKIP_REASON);
  }
});

test("one key is not enough, and the reason names both", () => {
  assert.equal(KEY_SKIP_REASON, "META_API_KEY and ASSEMBLYAI_API_KEY are required for the real legs");
  assert.match(KEY_SKIP_REASON, /META_API_KEY/);
  assert.match(KEY_SKIP_REASON, /ASSEMBLYAI_API_KEY/);
});

test("both keys present lets the check run", () => {
  assert.deepEqual(
    skipDecision(env({ META_API_KEY: "meta-test", ASSEMBLYAI_API_KEY: "aai-test" })),
    { skip: false },
  );
});

// --------------------------------------------------------------------------
// Flags
// --------------------------------------------------------------------------

test("no flags means the committed German caller clip and its voice", () => {
  const options = parseRealLegsArgs([]);
  assert.equal(options.voice, "jorg");
  assert.ok((DEMO_VOICE_IDS as readonly string[]).includes(options.voice));
  assert.equal(options.audioPath, undefined);
  assert.equal(options.baseUrl, undefined);
  assert.equal(options.wsUrl, undefined);
  assert.equal(options.eventsDir, undefined);
  assert.equal(options.timeoutMs, 120_000);
  assert.equal(options.json, false);
  assert.equal(options.help, false);
});

test("every documented flag is accepted", () => {
  const options = parseRealLegsArgs([
    "--base-url",
    "http://127.0.0.1:8767",
    "--ws-url",
    "ws://127.0.0.1:8767/v1/browser-call",
    "--voice",
    "audrey",
    "--audio",
    "/tmp/caller.wav",
    "--events-dir",
    "/tmp/events",
    "--timeout-ms",
    "5000",
    "--json",
  ]);
  assert.equal(options.baseUrl, "http://127.0.0.1:8767");
  assert.equal(options.wsUrl, "ws://127.0.0.1:8767/v1/browser-call");
  assert.equal(options.voice, "audrey");
  assert.equal(options.audioPath, "/tmp/caller.wav");
  assert.equal(options.eventsDir, "/tmp/events");
  assert.equal(options.timeoutMs, 5000);
  assert.equal(options.json, true);
  assert.equal(options.withResume, true, "the hold-return phase runs by default");
  assert.equal(options.withHangup, true, "the caller hang-up phase runs by default");
});

test("--with-resume is explicit and --no-resume is the named opt-out", () => {
  assert.equal(parseRealLegsArgs(["--with-resume"]).withResume, true);
  assert.equal(parseRealLegsArgs(["--no-resume"]).withResume, false);
});

test("the caller hang-up phase runs by default and has a named opt-out", () => {
  assert.equal(parseRealLegsArgs([]).withHangup, true);
  assert.equal(parseRealLegsArgs(["--with-hangup"]).withHangup, true);
  assert.equal(parseRealLegsArgs(["--no-hangup"]).withHangup, false);
});

test("an unknown flag, a missing value and a bad timeout are named usage errors", () => {
  assert.throws(() => parseRealLegsArgs(["--nope"]), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /unknown option "--nope"/);
    return true;
  });
  assert.throws(() => parseRealLegsArgs(["--base-url"]), (error: unknown) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /--base-url needs a value/);
    return true;
  });
  for (const bad of ["0", "-1", "1.5", "soon"]) {
    assert.throws(() => parseRealLegsArgs(["--timeout-ms", bad]), UsageError);
  }
});

test("--help is a request, not an error", () => {
  for (const flag of ["--help", "-h"]) {
    assert.equal(parseRealLegsArgs([flag]).help, true);
  }
});

// --------------------------------------------------------------------------
// Local or deployed target
// --------------------------------------------------------------------------

test("an https base derives the wss connect URL on the service path", () => {
  const target = resolveTargets({ baseUrl: "https://pipeline.example.com/" });
  assert.equal(target.httpBase, "https://pipeline.example.com");
  assert.equal(target.wsUrl, "wss://pipeline.example.com/v1/browser-call");
  assert.equal(target.local, false);
});

test("a local http base is allowed only on loopback and derives ws", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const target = resolveTargets({ baseUrl: `http://${host}:8767` });
    assert.equal(target.httpBase, `http://${host}:8767`);
    assert.equal(target.wsUrl, `ws://${host}:8767/v1/browser-call`);
    assert.equal(target.local, true);
  }
});

test("a public http base is refused: the deployed app speaks https", () => {
  assert.throws(
    () => resolveTargets({ baseUrl: "http://pipeline.example.com" }),
    /https/,
  );
});

test("a ws URL alone derives the HTTP delivery base", () => {
  const target = resolveTargets({ wsUrl: "ws://127.0.0.1:8767/v1/browser-call" });
  assert.equal(target.httpBase, "http://127.0.0.1:8767");
  assert.equal(target.wsUrl, "ws://127.0.0.1:8767/v1/browser-call");
  assert.equal(target.local, true);
});

test("base and ws URL must name the same service", () => {
  assert.throws(
    () =>
      resolveTargets({
        baseUrl: "https://pipeline.example.com",
        wsUrl: "wss://other.example.com/v1/browser-call",
      }),
    /same service/,
  );
});

test("a missing target and a URL without the service path are named refusals", () => {
  assert.throws(() => resolveTargets({}), /--base-url or --ws-url/);
  assert.throws(
    () => resolveTargets({ wsUrl: "wss://pipeline.example.com/socket" }),
    /browser-call/,
  );
  assert.throws(
    () => resolveTargets({ baseUrl: "https://pipeline.example.com?key=1" }),
    /no query string/,
  );
});

// --------------------------------------------------------------------------
// The report and the exit code
// --------------------------------------------------------------------------

test("a passing report says how many checks passed and exits zero", () => {
  const checks = [
    check("delivery", "delivery", "pass", "POST → 202 accepted"),
    check("captions", "captions", "pass", "2 agent turns, 2 caller turns"),
  ];
  const report = formatRealLegsReport(checks);
  assert.match(report, /demo-cascade real legs \(ticket 22\)/);
  assert.match(report, /PASS {2}delivery/);
  assert.match(report, /PASS {2}captions/);
  assert.match(report, /2 checks, all passed/);
  assert.equal(realLegsExitCode(checks), 0);
});

test("a failure is printed by name and exits non-zero", () => {
  const checks = [
    check("delivery", "delivery", "pass", "POST → 202 accepted"),
    check("audio", "audio-frames", "fail", "no audio frames arrived"),
  ];
  const report = formatRealLegsReport(checks);
  assert.match(report, /FAIL {2}audio/);
  assert.match(report, /no audio frames arrived/);
  assert.match(report, /1 of 2 checks failed: audio-frames/);
  assert.equal(realLegsExitCode(checks), 1);
});

test("a named skip is printed and does not fail the run", () => {
  const checks = [
    check(
      "trace",
      "trace-unreadable",
      "skip",
      "the trace artifact is on the service host; pass --events-dir",
    ),
  ];
  const report = formatRealLegsReport(checks);
  assert.match(report, /SKIP {2}trace/);
  assert.match(report, /skipped: the trace artifact is on the service host/);
  assert.equal(realLegsExitCode(checks), 0);
});

test("an INFO row is printed as information and does not fail the run", () => {
  const checks = [
    check("delivery", "delivery", "pass", "POST → 202 accepted"),
    check(
      "cost row",
      "cost",
      "info",
      "cost.priced unmeasured: cascade.cost.cost_call; rate table cascade-vendor-rates v1; reason: no session audio",
    ),
  ];
  const report = formatRealLegsReport(checks);
  assert.match(report, /INFO {2}cost row/);
  assert.match(report, /cascade\.cost\.cost_call/);
  assert.doesNotMatch(report, /PASS {2}cost row/);
  assert.match(report, /1 passed, 1 info/);
  assert.equal(realLegsExitCode(checks), 0);
});

// --------------------------------------------------------------------------
// The pull-request path never runs it
// --------------------------------------------------------------------------

test("CI never invokes the real-legs check", () => {
  // A comment cannot invoke anything, so the guard reads executable lines: the
  // policy note in ci.yml names the command it explains.
  const workflow = readFileSync(CI_WORKFLOW, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.ok(
    !/real-legs|check:real-legs/.test(workflow),
    "the real-legs check is key-gated and must never run in the pull-request workflow",
  );
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    typeof packageJson.scripts["check:real-legs"],
    "string",
    "the operator command must be named in package.json",
  );
  assert.match(packageJson.scripts["check:real-legs"], /scripts\/real-legs\.mts/);
});

// --------------------------------------------------------------------------
// The caller clip
// --------------------------------------------------------------------------

test("the committed caller clip is real 24 kHz PCM16 audio", async () => {
  const clip = defaultCallerClip();
  assert.ok(clip.endsWith("/public/voices/cascade/jorg.wav"));
  const audio = await loadCallerAudio({ voice: "jorg", env: {}, fetchImpl: fetch });
  assert.match(audio.source, /committed caller clip/);
  assert.ok(audio.pcm.length > 24_000, `expected more than a second of PCM, got ${audio.pcm.length} bytes`);
  assert.equal(audio.pcm.length % 2, 0, "PCM16 is a whole number of samples");
});

test("an explicit missing clip is a named failure, never a synthesis", async () => {
  await assert.rejects(
    loadCallerAudio({
      audioPath: "/tmp/t22-no-such-caller.wav",
      voice: "jorg",
      env: { ASSEMBLYAI_API_KEY: "aai-test" },
      fetchImpl: fetch,
    }),
    /does not exist/,
  );
});

// --------------------------------------------------------------------------
// The trace and the priced row
// --------------------------------------------------------------------------

function traceLines(callId: string, subject: string, priced: Record<string, unknown>): string {
  const base = { schemaVersion: 1, pipeline: "cascade", callId, subject, atMs: 1 };
  return [
    { ...base, type: "greeting.done", turn: null, phase: "connect" },
    { ...base, type: "turn.attribution", turn: "turn-1", phase: "turn" },
    { ...base, type: "cost.priced", turn: null, phase: "end", ...priced },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

test("a measured trace row passes the trace and the cost assertions", () => {
  const checks = assessTrace({
    exists: true,
    text: traceLines("call-1", "demo:jorg", {
      measured: true,
      producer: "cascade.cost.cost_call",
      rateTableVersion: "cascade-vendor-rates v1",
      totalUsd: 0.000123,
      legs: {},
    }),
    callId: "call-1",
    voice: "jorg",
    local: true,
    eventsDir: "/tmp/events",
    eventsPath: "/tmp/events/call-1.jsonl",
  });
  assert.deepEqual(
    checks.map((entry) => [entry.code, entry.status]),
    [
      ["trace", "pass"],
      ["cost", "pass"],
    ],
  );
  assert.match(checks[1].detail, /\$0\.000123/);
});

test("an unmeasured cost row is INFO with its producer and rate table, never PASS", () => {
  const withReason = assessTrace({
    exists: true,
    text: traceLines("call-1", "demo:jorg", {
      measured: false,
      producer: "cascade.cost.cost_call",
      rateTableVersion: "cascade-vendor-rates v1",
      totalUsd: null,
      unmeasuredReason: "the STT leg reported no session audio",
      legs: {},
    }),
    callId: "call-1",
    voice: "jorg",
    local: true,
    eventsDir: "/tmp/events",
    eventsPath: "/tmp/events/call-1.jsonl",
  });
  assert.equal(withReason[1].status, "info");
  assert.match(withReason[1].detail, /cascade\.cost\.cost_call/);
  assert.match(withReason[1].detail, /cascade-vendor-rates v1/);
  assert.match(withReason[1].detail, /unmeasured: the STT leg reported no session audio/);

  const withoutReason = assessTrace({
    exists: true,
    text: traceLines("call-1", "demo:jorg", {
      measured: false,
      producer: "cascade.cost.cost_call",
      rateTableVersion: "cascade-vendor-rates v1",
      totalUsd: null,
      legs: {},
    }),
    callId: "call-1",
    voice: "jorg",
    local: true,
    eventsDir: "/tmp/events",
    eventsPath: "/tmp/events/call-1.jsonl",
  });
  assert.deepEqual(
    withoutReason.map((entry) => entry.status),
    ["pass", "fail"],
  );
  assert.equal(withoutReason[1].code, "cost-invalid");
});

test("an unmeasured cost row that does not name its producer or rate table is a failure", () => {
  const assess = (priced: Record<string, unknown>) =>
    assessTrace({
      exists: true,
      text: traceLines("call-1", "demo:jorg", priced),
      callId: "call-1",
      voice: "jorg",
      local: true,
      eventsDir: "/tmp/events",
      eventsPath: "/tmp/events/call-1.jsonl",
    })[1];

  const missingProducer = assess({
    measured: false,
    rateTableVersion: "cascade-vendor-rates v1",
    totalUsd: null,
    unmeasuredReason: "the STT leg reported no session audio",
    legs: {},
  });
  assert.equal(missingProducer.status, "fail");
  assert.equal(missingProducer.code, "cost-invalid");
  assert.match(missingProducer.detail, /producer/);

  const wrongProducer = assess({
    measured: false,
    producer: "a second pricing path",
    rateTableVersion: "cascade-vendor-rates v1",
    totalUsd: null,
    unmeasuredReason: "the STT leg reported no session audio",
    legs: {},
  });
  assert.equal(wrongProducer.status, "fail");
  assert.match(wrongProducer.detail, /cascade\.cost\.cost_call/);

  const missingVersion = assess({
    measured: false,
    producer: "cascade.cost.cost_call",
    rateTableVersion: null,
    totalUsd: null,
    unmeasuredReason: "the STT leg reported no session audio",
    legs: {},
  });
  assert.equal(missingVersion.status, "fail");
  assert.match(missingVersion.detail, /rateTableVersion/);
});

test("a trace line with the wrong subject fails the trace assertion", () => {
  const checks = assessTrace({
    exists: true,
    text: traceLines("call-1", "demo:audrey", {
      measured: true,
      producer: "cascade.cost.cost_call",
      rateTableVersion: "cascade-vendor-rates v1",
      totalUsd: 0.1,
      legs: {},
    }),
    callId: "call-1",
    voice: "jorg",
    local: true,
    eventsDir: "/tmp/events",
    eventsPath: "/tmp/events/call-1.jsonl",
  });
  assert.equal(checks[0].status, "fail");
  assert.equal(checks[0].code, "trace-binding");
  assert.match(checks[0].detail, /demo:jorg/);
});

test("every demo trace line must name the subject, operational rows included", () => {
  const base = { schemaVersion: 1, pipeline: "cascade", callId: "call-1" };
  const priced = {
    measured: false,
    rateTableVersion: "cascade-vendor-rates v1",
    totalUsd: null,
    unmeasuredReason: "the STT leg reported no session audio",
    legs: {},
  };
  const lines = (operationalSubject: string | undefined) =>
    [
      { ...base, subject: "demo:jorg", type: "greeting.done", turn: null, phase: "connect", atMs: 1 },
      {
        ...base,
        ...(operationalSubject === undefined ? {} : { subject: operationalSubject }),
        type: "budget.crossing",
        leg: "llm",
        phase: "turn",
        atMs: 2,
      },
      { ...base, subject: "demo:jorg", type: "cost.priced", turn: null, phase: "end", atMs: 3, ...priced },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
  const assess = (text: string) =>
    assessTrace({
      exists: true,
      text,
      callId: "call-1",
      voice: "jorg",
      local: true,
      eventsDir: "/tmp/events",
      eventsPath: "/tmp/events/call-1.jsonl",
    });

  const allNamed = assess(lines("demo:jorg"));
  assert.equal(allNamed[0].status, "pass");
  assert.match(allNamed[0].detail, /3 lines, every one .*subject "demo:jorg"/);

  const unnamed = assess(lines(undefined));
  assert.equal(unnamed[0].status, "fail");
  assert.equal(unnamed[0].code, "trace-binding");
  assert.match(unnamed[0].detail, /budget\.crossing/);
});

test("a missing trace is a failure locally and a named skip remotely", () => {
  const local = assessTrace({
    exists: false,
    text: null,
    callId: "call-1",
    voice: "jorg",
    local: true,
    eventsDir: "/tmp/events",
    eventsPath: null,
  });
  assert.deepEqual(
    local.map((entry) => entry.status),
    ["fail", "fail"],
  );

  const remote = assessTrace({
    exists: false,
    text: null,
    callId: "call-1",
    voice: "jorg",
    local: false,
    eventsDir: "/tmp/events",
    eventsPath: "/var/lib/voni/events/call-1.jsonl",
  });
  assert.deepEqual(
    remote.map((entry) => entry.status),
    ["skip", "skip"],
  );
  assert.match(formatRealLegsReport(remote), /skipped: the trace artifact lives on the service host/);
  assert.equal(realLegsExitCode(remote), 0);
});

// --------------------------------------------------------------------------
// The caller ingress pump: cadence, no-early, and a whole caller turn
// --------------------------------------------------------------------------

/** Yield macrotasks until a fake-clock driver reaches its predicate. */
function driveUntil(predicate: () => boolean, turns = 10_000): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    let left = turns;
    const step = () => {
      if (predicate()) return resolvePromise();
      if (left-- <= 0) return reject(new Error("the fake clock never reached the predicate"));
      setImmediate(step);
    };
    step();
  });
}

test("the caller pump sends one browser-quantum frame per due instant and never early", async () => {
  const start = 5_000;
  let clock = start;
  const sent: { at: number; frame: Uint8Array }[] = [];
  const pump = createIngressPump({
    send: (frame) => sent.push({ at: clock, frame: frame.slice() }),
    now: () => clock,
    sleep: (ms) =>
      new Promise<void>((resolvePromise) => {
        clock += ms;
        setImmediate(resolvePromise);
      }),
  });
  pump.start();
  await driveUntil(() => sent.length >= 40);
  await pump.stop();

  assert.ok(sent.length >= 40, `expected at least 40 frames, got ${sent.length}`);
  assert.equal(pump.frames(), sent.length);
  sent.forEach((entry, index) => {
    const due = start + index * INGRESS_FRAME_MS;
    assert.equal(entry.frame.length, INGRESS_FRAME_BYTES, `frame ${index} is not one quantum`);
    assert.ok(
      entry.frame.every((byte) => byte === 0),
      `frame ${index} must be silence while no caller turn is queued`,
    );
    // The cadence is absolute: frame N is sent at start + N * frame_ms, never
    // before it. A timer that woke early would fail here.
    assert.ok(entry.at >= due - 1e-9, `frame ${index} sent ${due - entry.at} ms early`);
    assert.ok(
      Math.abs(entry.at - due) < 1e-6,
      `frame ${index} sent at ${entry.at}, expected ${due}`,
    );
  });
});

test("a late wake resumes the absolute schedule without ever sending ahead of it", async () => {
  const start = 0;
  let clock = start;
  let wakes = 0;
  const sent: { at: number }[] = [];
  const pump = createIngressPump({
    send: () => sent.push({ at: clock }),
    now: () => clock,
    sleep: (ms) =>
      new Promise<void>((resolvePromise) => {
        clock += ms;
        wakes += 1;
        // One stalled wake, as a busy event loop would produce.
        if (wakes === 10) clock += 100;
        setImmediate(resolvePromise);
      }),
  });
  pump.start();
  await driveUntil(() => sent.length >= 40);
  await pump.stop();

  sent.forEach((entry, index) => {
    const due = start + index * INGRESS_FRAME_MS;
    assert.ok(
      entry.at >= due - 1e-9,
      `frame ${index} sent ahead of its due instant (${entry.at} < ${due})`,
    );
  });
  // The stall is repaid from the absolute schedule, not by resetting the clock:
  // by frame 39 the frame index is still exactly the count sent.
  assert.equal(pump.frames(), sent.length);
});

test("a queued caller turn is paced frame by frame and resolved after its tail silence", async () => {
  let clock = 0;
  const sent: Uint8Array[] = [];
  const pump = createIngressPump({
    send: (frame) => sent.push(frame.slice()),
    now: () => clock,
    sleep: (ms) =>
      new Promise<void>((resolvePromise) => {
        clock += ms;
        setImmediate(resolvePromise);
      }),
  });
  pump.start();
  await driveUntil(() => sent.length >= 3);
  const before = sent.length;

  const clip = new Uint8Array(INGRESS_FRAME_BYTES + 100);
  clip.fill(0x22);
  let saidAt: number | null = null;
  void pump.say(clip).then(() => {
    saidAt = clock;
  });
  await driveUntil(() => saidAt !== null);

  const during = sent.slice(before);
  assert.ok(during.length >= 2);
  assert.deepEqual(
    Array.from(during[0]),
    Array.from(clip.subarray(0, INGRESS_FRAME_BYTES)),
    "the first frame after the queue starts with the caller's first quantum",
  );
  assert.deepEqual(
    Array.from(during[1].subarray(0, 100)),
    Array.from(clip.subarray(INGRESS_FRAME_BYTES)),
    "the clip's remainder is carried, not dropped",
  );
  assert.ok(
    during[1].subarray(100).every((byte) => byte === 0),
    "the rest of the quantum is silence, never a short frame",
  );
  // The turn is not "sent" until the vendor has heard its trailing silence.
  const expected = (clip.length / (24_000 * 2)) * 1_000 + TURN_TAIL_MS;
  assert.ok(
    Number(saidAt) >= expected - INGRESS_FRAME_MS,
    `resolved at ${saidAt} ms, before the ${expected} ms of audio plus tail`,
  );
  await pump.stop();
});

test("the carried history keeps settled turns, collapses partials and respects the bound", () => {
  const captions = [
    { role: "user" as const, text: "half a que", final: false },
    { role: "user" as const, text: "hello there", final: true },
    { role: "agent" as const, text: "Hi", final: false },
    { role: "agent" as const, text: "Hi, how can I help?", final: false },
    { role: "user" as const, text: "tell me about the test", final: true },
    { role: "agent" as const, text: "Sure.", final: false },
  ];
  assert.deepEqual(carriedHistory(captions, 12), [
    { role: "user", content: "hello there" },
    { role: "assistant", content: "Hi, how can I help?" },
    { role: "user", content: "tell me about the test" },
    { role: "assistant", content: "Sure." },
  ]);
  // The newest turns survive the bound, and history never starts mid-reply.
  assert.deepEqual(carriedHistory(captions, 2), [
    { role: "user", content: "tell me about the test" },
    { role: "assistant", content: "Sure." },
  ]);
  assert.deepEqual(carriedHistory(captions, 1), []);
});

// --------------------------------------------------------------------------
// The call's flow against a fake service (no keys)
// --------------------------------------------------------------------------

const TEST_SECRET = "t22-real-legs-test-envelope-secret";

type FakeService = {
  httpBase: string;
  wsUrl: string;
  /** The config frame the browser socket sent, exactly once. */
  config(): Record<string, unknown> | null;
  /** Every accepted call-body payload, in arrival order. */
  deliveries(): Record<string, unknown>[];
  /** Ingress frames the caller pump had sent before the first caller turn. */
  framesBeforeFirstTurn(): number;
  /** Every hidden-context line the browser sent, in arrival order. */
  contexts(): string[];
  close(): Promise<void>;
};

async function startFakeService(options: {
  eventsDir: string;
  writeTrace: boolean;
  greetResume?: boolean;
  /** Simulate a service that drops the hidden note (context handling gone). */
  dropContext?: boolean;
}): Promise<FakeService> {
  const delivered: Record<string, unknown>[] = [];
  const contexts: string[] = [];
  let config: Record<string, unknown> | null = null;
  let state: { callId: string; subject: string; eventsPath: string } | null = null;
  let framesBeforeFirstTurn = -1;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/v1/call-body") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        const callId = payload.call_id;
        const token = payload.call_token;
        const signed = payload.signed_body as
          | { envelope?: Record<string, unknown>; body?: Record<string, unknown> }
          | undefined;
        if (typeof callId !== "string" || typeof token !== "string" || !signed?.envelope) {
          response.writeHead(400, { "x-cascade-refusal": "malformed_body" }).end("{}");
          return;
        }
        const envelope = signed.envelope;
        const agentId = envelope.agent_id;
        const claims = verifyCallToken(token, { secret: TEST_SECRET, callId });
        if (!claims || claims.subject !== agentId) {
          response.writeHead(400, { "x-cascade-refusal": "envelope_refused" }).end("{}");
          return;
        }
        if (
          envelope.version !== 2 ||
          envelope.kind !== "demo" ||
          typeof agentId !== "string" ||
          !agentId.startsWith("demo:") ||
          envelope.body_hash !== envelopeBodyHash(signed.body as Record<string, unknown>)
        ) {
          response.writeHead(400, { "x-cascade-refusal": "envelope_refused" }).end("{}");
          return;
        }
        delivered.push(payload);
        state = {
          callId,
          subject: agentId,
          eventsPath: `${options.eventsDir}/${callId}.jsonl`,
        };
        response.writeHead(202, { "content-type": "application/json" }).end(
          JSON.stringify({
            status: "accepted",
            call_id: callId,
            agent_id: agentId,
            body_hash: envelope.body_hash,
          }),
        );
      } catch {
        response.writeHead(400, { "x-cascade-refusal": "malformed_body" }).end("{}");
      }
    });
  });

  const { WebSocketServer } = require("ws") as {
    WebSocketServer: new (options: { server: typeof server; path: string }) => {
      on: (event: string, handler: (socket: unknown) => void) => void;
      close: () => void;
    };
  };
  const wss = new WebSocketServer({ server, path: "/v1/browser-call" });

  wss.on("connection", (socket) => {
    const ws = socket as {
      send: (data: string) => void;
      close: () => void;
      on: (event: string, handler: (data: Buffer) => void) => void;
    };
    let turn = 0;
    let greeted = false;
    let resume = false;
    let ingressFrames = 0;
    let speechEndTimer: NodeJS.Timeout | null = null;

    const sendAudio = (seqStart: number) => {
      for (let index = 0; index < 2; index += 1) {
        ws.send(
          JSON.stringify({
            type: "audio",
            seq: seqStart + index,
            sample_rate: 24_000,
            data: Buffer.alloc(4_800, 0x11).toString("base64"),
          }),
        );
      }
    };

    // The greeting is not a turn and carries no caption, exactly as the live
    // service does it: only its audio reaches the browser, and the caller's
    // pump must already be feeding silence while it renders.
    const greet = () => {
      sendAudio(1);
      greeted = true;
    };

    const answerTurn = () => {
      if (framesBeforeFirstTurn < 0) framesBeforeFirstTurn = ingressFrames;
      turn += 1;
      ws.send(
        JSON.stringify({
          type: "caption",
          role: "user",
          text: `caller turn ${turn}`,
          final: true,
        }),
      );
      ws.send(
        JSON.stringify({
          type: "caption",
          role: "agent",
          text: `agent answer ${turn}`,
          final: true,
        }),
      );
      sendAudio(1 + turn * 10);
    };

    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (message.type === "config") {
        config = message;
        // A hold return carries the signed history (and binds the `:resume`
        // body): it must not be greeted again.
        const minted = delivered.find((payload) => payload.call_token === message.callToken);
        const body = (minted?.signed_body as { body?: Record<string, unknown> } | undefined)?.body;
        resume =
          Array.isArray(body?.history) ||
          (typeof body?.name === "string" && body.name.endsWith(":resume"));
        if (resume) {
          greeted = true;
          if (options.greetResume) greet();
        } else {
          greet();
        }
        return;
      }
      if (message.type === "context") {
        // The hidden context is held for the next model request only; a note
        // while the caller is silent starts no turn of its own.
        if (!options.dropContext) contexts.push(String(message.content ?? ""));
        return;
      }
      if (message.type === "audio") {
        ingressFrames += 1;
        // The pump is continuous: silence between the turns, the clip inside
        // them. A turn ends where the caller's speech gives way to silence,
        // which is what the live service's endpointing sees too.
        const pcm = Buffer.from(String(message.data ?? ""), "base64");
        if (!pcm.some((byte: number) => byte !== 0)) return;
        if (speechEndTimer) clearTimeout(speechEndTimer);
        speechEndTimer = setTimeout(() => {
          // The third caller turn is the one that spends the hidden note: the
          // fake answers it only after a context line arrived, exactly as the
          // live service applies the note to the next model request.
          if (turn < 2 || (turn < 3 && contexts.length > 0)) answerTurn();
        }, 150);
        return;
      }
      if (message.type === "stop") {
        if (!state) return;
        if (options.writeTrace) {
          writeFileSync(
            state.eventsPath,
            `${traceLines(state.callId, state.subject, {
              measured: true,
              producer: "cascade.cost.cost_call",
              rateTableVersion: "cascade-vendor-rates v1",
              totalUsd: 0.000123,
              legs: {},
            })}\n`,
          );
        }
        ws.send(
          JSON.stringify({
            type: "end",
            callId: state.callId,
            turns: turn,
            metrics: {},
            endedBy: "stop",
            cost: {
              measured: true,
              rateTableVersion: "cascade-vendor-rates v1",
              totalUsd: 0.000123,
              legs: {},
            },
            eventsPath: state.eventsPath,
          }),
        );
        setTimeout(() => ws.close(), 20);
      }
    });

    // A client that never sends the config must not be greeted.
    setTimeout(() => {
      if (!greeted) ws.close();
    }, 5_000).unref();
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake service did not bind a port");
  }
  const host = `127.0.0.1:${address.port}`;
  return {
    httpBase: `http://${host}`,
    wsUrl: `ws://${host}/v1/browser-call`,
    config: () => config,
    deliveries: () => delivered,
    framesBeforeFirstTurn: () => framesBeforeFirstTurn,
    contexts: () => contexts,
    close: async () => {
      wss.close();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

/** A short caller burst: the flow is the subject, not the clip's length. */
function shortCallerAudio() {
  return {
    pcm: new Uint8Array(24_000 / 5).fill(0x22), // 200 ms
    source: "test caller burst",
  };
}

async function runAgainstFake(
  writeTrace: boolean,
  extra: { greetResume?: boolean; dropContext?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "t22-real-legs-"));
  const service = await startFakeService({ eventsDir: dir, writeTrace, ...extra });
  const target = resolveTargets({ baseUrl: service.httpBase });
  const previous = process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
  process.env.VOICE_PIPELINE_ENVELOPE_SECRET = TEST_SECRET;
  // The demo body always names its model (ADR-0014), and the app's builder reads
  // the Meta key from `process.env`; the options' own `env` map is the fake
  // service's, not the builder's. These are fakes and no vendor is reached.
  const previousMeta = process.env.META_API_KEY;
  const previousModel = process.env.DEMO_LLM_MODEL_OVERRIDE;
  process.env.META_API_KEY = "meta-test";
  delete process.env.DEMO_LLM_MODEL_OVERRIDE;
  try {
    const options: RealLegsOptions = {
      voice: "jorg",
      timeoutMs: 15_000,
      withResume: true,
      withHangup: false,
      json: false,
      help: false,
      eventsDir: dir,
    };
    const checks = await runRealLegs(options, target, {
      env: {
        META_API_KEY: "meta-test",
        ASSEMBLYAI_API_KEY: "aai-test",
      },
      loadCallerAudio: async () => shortCallerAudio(),
      sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(ms, 5))),
      callId: "call-real-legs-test",
    });
    return { checks, dir, service };
  } finally {
    if (previous === undefined) delete process.env.VOICE_PIPELINE_ENVELOPE_SECRET;
    else process.env.VOICE_PIPELINE_ENVELOPE_SECRET = previous;
    if (previousMeta === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = previousMeta;
    if (previousModel === undefined) delete process.env.DEMO_LLM_MODEL_OVERRIDE;
    else process.env.DEMO_LLM_MODEL_OVERRIDE = previousModel;
  }
}

test("the call's flow passes every assertion against a fake service", async () => {
  const { checks, dir, service } = await runAgainstFake(true);
  try {
    const failures = checks.filter((entry) => entry.status === "fail");
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
    assert.deepEqual(
      checks.map((entry) => entry.code),
      [
        "signed-body",
        "delivery",
        "caller-audio",
        "context-hidden",
        "identity-config",
        "captions",
        "reply-gap",
        "audio-frames",
        "end-message",
        "resume-body",
        "resume-delivery",
        "resume-no-greeting",
        "resume-continuation",
        "resume-end-message",
        "resume-trace",
        "trace",
        "cost",
      ],
    );
    assert.equal(realLegsExitCode(checks), 0);
    assert.equal(service.deliveries().length, 2);
    const resumedBody = (
      service.deliveries()[1]?.signed_body as { body?: Record<string, unknown> } | undefined
    )?.body;
    assert.ok(Array.isArray(resumedBody?.history) && resumedBody.history.length > 0);
    assert.match(String(resumedBody?.name), /:resume$/);
    assert.match(
      checks.find((entry) => entry.code === "resume-continuation")?.detail ?? "",
      /carried turns were in the signed body/,
    );
    assert.ok(
      service.framesBeforeFirstTurn() > 0,
      "the caller pump must already be feeding silence while the greeting renders",
    );
    assert.deepEqual(Object.keys(service.config() ?? {}).sort(), [
      "agentId",
      "callToken",
      "protocolVersion",
      "type",
    ]);
    assert.equal(service.config()?.agentId, "demo:jorg");
    assert.deepEqual(
      service.contexts(),
      [rungInstructions("nudge")],
      "the note reached the service before the caller turn that spent it",
    );
    assert.match(
      checks.find((entry) => entry.code === "context-hidden")?.detail ?? "",
      /next caller turn was answered/,
    );
    assert.match(
      checks.find((entry) => entry.code === "captions")?.detail ?? "",
      /caller finals and 3 agent caption lines/,
    );
    assert.match(
      checks.find((entry) => entry.code === "captions")?.detail ?? "",
      /greeting is not a turn/,
    );
    assert.match(checks.find((entry) => entry.code === "trace")?.detail ?? "", /call-real-legs-test/);
    assert.match(checks.find((entry) => entry.code === "cost")?.detail ?? "", /\$0\.000123/);
    assert.match(formatRealLegsReport(checks), /17 checks, all passed/);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a note the service never holds cannot pass the hidden-context proof", async () => {
  // The phase must spend the note on a real turn: a service that drops the
  // context frame leaves no reply to the turn after it, so the check fails
  // instead of passing on the note's absence alone.
  const { checks, dir, service } = await runAgainstFake(true, { dropContext: true });
  try {
    assert.deepEqual(service.contexts(), []);
    const failures = checks.filter((entry) => entry.status === "fail");
    assert.deepEqual(
      failures.map((entry) => entry.code),
      ["call-timeout", "trace-missing", "cost-missing"],
      JSON.stringify(checks, null, 2),
    );
    assert.match(failures[0]?.detail ?? "", /context turn/);
    assert.equal(
      checks.some((entry) => entry.code === "context-hidden"),
      false,
      "an unconsumed note is never reported as hidden context passing",
    );
    assert.equal(realLegsExitCode(checks), 1);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a resumed call that speaks the greeting fails by name", async () => {  const { checks, dir, service } = await runAgainstFake(true, { greetResume: true });
  try {
    const failedChecks = checks.filter((entry) => entry.status === "fail");
    assert.deepEqual(
      failedChecks.map((entry) => entry.code),
      ["resume-greeted"],
      JSON.stringify(checks, null, 2),
    );
    assert.equal(realLegsExitCode(checks), 1);
    assert.doesNotMatch(
      formatRealLegsReport(checks),
      /resume-no-greeting/,
      "a greeted resume must never be reported as no greeting",
    );
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a local service that writes no trace fails the trace and the cost row", async () => {
  const { checks, dir, service } = await runAgainstFake(false);
  try {
    assert.equal(realLegsExitCode(checks), 1);
    assert.deepEqual(
      checks.filter((entry) => entry.status === "fail").map((entry) => entry.code),
      ["resume-trace", "trace-missing", "cost-missing"],
    );
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// The no-key command
// --------------------------------------------------------------------------

function runScript(args: string[], extraEnv: Record<string, string> = {}) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const name of ["META_API_KEY", "ASSEMBLYAI_API_KEY", "VOICE_PIPELINE_ENVELOPE_SECRET"]) {
    delete environment[name];
  }
  environment.NO_COLOR = "1";
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: VONI_ROOT,
    encoding: "utf8",
    env: { ...environment, ...extraEnv } as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

test("a no-key run prints the named skip and exits zero", () => {
  const result = runScript([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^skipped: META_API_KEY and ASSEMBLYAI_API_KEY are required for the real legs$/m);
});

test("--help needs no keys and exits zero", () => {
  const result = runScript(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: npm run check:real-legs/);
  assert.match(result.stdout, /--base-url URL/);
});

test("both keys but no target is a named failure, not a skip", () => {
  const result = runScript([], { META_API_KEY: "meta-test", ASSEMBLYAI_API_KEY: "aai-test" });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /FAIL {2}target/);
  assert.match(result.stdout, /--base-url or --ws-url/);
});

