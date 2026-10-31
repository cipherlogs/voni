import test, { before } from "node:test";
import assert from "node:assert/strict";

import { loadContract, type Contract } from "../../contract";
import { judgeRun, type EvaluatorContext } from "..";
import resilienceModule from "./resilience.evaluators";
import type { Evaluation, EvidenceBundle } from "../types";

/**
 * R1–R8's measurements, one condition at a time. Every case pairs a pass with
 * the failure it must not forgive: a lost turn, a repeated greeting, a running
 * talk clock, a zombie socket, a silent device change, an accepted new call
 * during a drain and a provider fallback.
 */

let contract: Contract;
before(async () => {
  contract = await loadContract();
});
const property = (id: string) => {
  const found = contract.properties.find((entry) => entry.id === id);
  assert.ok(found, `the contract has ${id}`);
  return found;
};

function evaluator(id: string) {
  const found = resilienceModule.evaluators.find((entry) => entry.propertyId === id);
  assert.ok(found, `a resilience evaluator for ${id}`);
  return found;
}

function context(
  id: string,
  evidence: EvidenceBundle,
  facts?: EvaluatorContext["facts"],
): EvaluatorContext {
  const entry = property(id);
  const source = evidence[entry.evidence];
  assert.ok(source !== undefined, `${id} reads ${entry.evidence}`);
  return { property: entry, scenario: "resilience-test", repetition: 1, source, evidence, facts };
}

function row(type: string, turn?: string, extra: Record<string, unknown> = {}) {
  return { type, ...(turn === undefined ? {} : { turn }), ...extra };
}

function trace(rows: readonly Record<string, unknown>[]) {
  return { file: "trace.jsonl", rows, lineCount: rows.length };
}

function measured(result: Evaluation): Extract<Evaluation, { kind: "measured" }> {
  assert.equal(result.kind, "measured", JSON.stringify(result));
  return result;
}

/** The resilience evaluators are synchronous; a promise would be a wiring bug. */
function run(id: string, ctx: EvaluatorContext): Evaluation {
  const result = evaluator(id).evaluate(ctx);
  assert.ok(!(result instanceof Promise), `${id}'s evaluator returned a promise`);
  return result;
}

const JITTER_FACTS = {
  takes: [
    { id: "hello", text: "Hi" },
    { id: "again", text: "Say that again" },
  ],
};

test("R1 passes a jittered call whose two turns each got one reply and one first audio", () => {
  const bundle: EvidenceBundle = {
    trace: trace([
      row("turn.user_final", "1:user"),
      row("turn.reply_start", "1:reply"),
      row("turn.first_audio", "1:reply", { seq: 0 }),
      row("turn.user_final", "2:user"),
      row("turn.reply_start", "2:reply"),
      row("turn.first_audio", "2:reply", { seq: 9 }),
    ]),
    browser: { faultsApplied: [{ kind: "network-jitter", atMs: 900 }] },
  };
  const result = measured(run("R1", context("R1", bundle, JITTER_FACTS)));
  assert.deepEqual(result.samples, [0, 0]);
});

test("R1 fails a lost turn and a doubled first-audio row, each by name", () => {
  const lost: EvidenceBundle = {
    trace: trace([
      row("turn.user_final", "1:user"),
      row("turn.reply_start", "1:reply"),
      row("turn.first_audio", "1:reply"),
      row("turn.user_final", "2:user"),
    ]),
    browser: { faultsApplied: [{ kind: "audio-dropout", atMs: 1_200 }] },
  };
  assert.deepEqual(
    measured(run("R1", context("R1", lost, JITTER_FACTS))).samples,
    [1, 0],
  );

  const doubled: EvidenceBundle = {
    trace: trace([
      row("turn.user_final", "1:user"),
      row("turn.reply_start", "1:reply"),
      row("turn.first_audio", "1:reply"),
      row("turn.first_audio", "1:reply"),
      row("turn.user_final", "2:user"),
      row("turn.reply_start", "2:reply"),
    ]),
    browser: { faultsApplied: [{ kind: "network-jitter", atMs: 900 }] },
  };
  assert.deepEqual(
    measured(run("R1", context("R1", doubled, JITTER_FACTS))).samples,
    [0, 1],
  );
});

test("R1 is unmeasured when the scenario applied no media fault", () => {
  const result = run("R1",
    context("R1", { trace: trace([row("turn.user_final", "1:user")]), browser: {} }),
  );
  assert.equal(result.kind, "unmeasured");
});

test("R2 passes a rejoin on the same call with unique turn ids and one greeting", () => {
  const bundle: EvidenceBundle = {
    trace: trace([
      row("greeting.start"),
      row("reconnect", "1:reply", { planned: true }),
      row("turn.user_final", "1:user"),
      row("turn.reply_start", "1:reply"),
      row("turn.user_final", "2:user"),
      row("turn.reply_start", "2:reply"),
    ]),
    browser: {
      edge: {
        conditions: [{ kind: "page-freeze", atMs: 2_500, applied: true }],
        hold: { holdingObserved: true },
      },
    },
  };
  assert.equal(measured(run("R2", context("R2", bundle))).passed, true);
});

test("R2 fails a repeated greeting and a duplicate turn id", () => {
  const bundle: EvidenceBundle = {
    trace: trace([
      row("greeting.start"),
      row("greeting.start"),
      row("turn.user_final", "1:user"),
      row("turn.reply_start", "1:reply"),
      row("turn.user_final", "1:user"),
    ]),
    browser: {
      edge: {
        conditions: [{ kind: "page-freeze", atMs: 2_500, applied: true }],
        hold: { holdingObserved: true },
      },
    },
  };
  assert.equal(measured(run("R2", context("R2", bundle))).passed, false);
});

test("R2 is unmeasured when the call never reconnected", () => {
  const result = run("R2",
    context("R2", { trace: trace([row("greeting.start")]), browser: {} }),
  );
  assert.equal(result.kind, "unmeasured");
});

test("R3 passes a hold return that kept memory, re-greeted nobody and played no ringback", () => {
  const bundle: EvidenceBundle = {
    trace: trace([
      row("greeting.start"),
      row("turn.user_final", "1:user"),
      row("turn.reply_start", "1:reply"),
    ]),
    ledger: {
      end: { turns: 2 },
      marks: { marks: [] },
    },
    browser: {
      edge: {
        hold: {
          holdingObserved: true,
          ringbackObserved: false,
          talkClockAtEnterS: 7,
          talkClockAtReturnS: 7,
        },
      },
    },
  };
  assert.equal(measured(run("R3", context("R3", bundle))).passed, true);
});

test("R3 fails a hold return that played ringback or lost the call's turns", () => {
  const ringback: EvidenceBundle = {
    trace: trace([row("greeting.start")]),
    ledger: { end: { turns: 2 }, marks: { marks: [] } },
    browser: { edge: { hold: { holdingObserved: true, ringbackObserved: true } } },
  };
  assert.equal(measured(run("R3", context("R3", ringback))).passed, false);

  const lost: EvidenceBundle = {
    trace: trace([row("greeting.start")]),
    ledger: { end: { turns: 0 }, marks: { marks: [] } },
    browser: { edge: { hold: { holdingObserved: true, ringbackObserved: false } } },
  };
  assert.equal(measured(run("R3", context("R3", lost))).passed, false);
});

test("R4 passes a hidden page whose talk clock stops, and fails one that keeps counting", () => {
  const stopped: EvidenceBundle = {
    browser: {
      edge: {
        hold: {
          holdingObserved: true,
          talkClockAtEnterS: 4,
          talkClockAtReturnS: 4,
        },
      },
    },
  };
  assert.equal(measured(run("R4", context("R4", stopped))).passed, true);

  const running: EvidenceBundle = {
    browser: {
      edge: {
        hold: {
          holdingObserved: true,
          talkClockAtEnterS: 4,
          talkClockAtReturnS: 12,
        },
      },
    },
  };
  assert.equal(measured(run("R4", context("R4", running))).passed, false);
});

test("R5 passes a named denial with no socket left open, fails a zombie call", () => {
  const clean: EvidenceBundle = {
    browser: {
      edge: {
        micDenied: {
          namedState: "Call didn't connect",
          errorText: "Voni needs your microphone for the call.",
          openSockets: 0,
          teardownObserved: true,
        },
      },
    },
  };
  assert.equal(measured(run("R5", context("R5", clean))).passed, true);

  const zombie: EvidenceBundle = {
    browser: {
      edge: {
        micDenied: {
          namedState: "",
          errorText: "NotAllowedError",
          openSockets: 1,
          teardownObserved: false,
        },
      },
    },
  };
  assert.equal(measured(run("R5", context("R5", zombie))).passed, false);
});

test("R6 passes a recovered device or an honest end, fails a silent live line", () => {
  const recovered: EvidenceBundle = {
    browser: {
      edge: { deviceSwitch: { atMs: 3_000, reacquired: true, state: "listening", endedHonestly: false } },
    },
  };
  assert.equal(measured(run("R6", context("R6", recovered))).passed, true);

  const honest: EvidenceBundle = {
    browser: {
      edge: { deviceSwitch: { atMs: 3_000, reacquired: false, state: "ended", endedHonestly: true } },
    },
  };
  assert.equal(measured(run("R6", context("R6", honest))).passed, true);

  const silent: EvidenceBundle = {
    browser: {
      edge: { deviceSwitch: { atMs: 3_000, reacquired: false, state: "listening", endedHonestly: false } },
    },
  };
  assert.equal(measured(run("R6", context("R6", silent))).passed, false);
});

test("R7 passes a drain that finished the live call and refused a new one by name", () => {
  const bundle: EvidenceBundle = {
    browser: {
      edge: {
        drain: {
          liveCallFinished: true,
          newCallAttempted: true,
          newCallRefused: true,
          refusalCode: "draining",
          refusalText: "The voice service is restarting. Try again in a moment.",
        },
      },
    },
  };
  assert.equal(measured(run("R7", context("R7", bundle))).passed, true);

  const accepted: EvidenceBundle = {
    browser: {
      edge: {
        drain: {
          liveCallFinished: true,
          newCallAttempted: true,
          newCallRefused: false,
          refusalCode: null,
          refusalText: "the service admitted the second call",
        },
      },
    },
  };
  assert.equal(measured(run("R7", context("R7", accepted))).passed, false);
});

test("R7 is unmeasured when no drain was observed, never a silent pass", () => {
  const bundle: EvidenceBundle = {
    browser: {
      edge: {
        drain: {
          liveCallFinished: false,
          newCallAttempted: false,
          newCallRefused: false,
          refusalCode: null,
          refusalText: "the harness has no drain control for this service",
        },
      },
    },
  };
  assert.equal(run("R7", context("R7", bundle)).kind, "unmeasured");
});

test("R8 passes a clean call and fails any provider_fallback row", () => {
  const clean: EvidenceBundle = {
    trace: trace([row("turn.user_final", "1:user")]),
    ledger: { end: { eligibility: { eligible: true, reasons: [] } } },
  };
  assert.equal(measured(run("R8", context("R8", clean))).passed, true);

  const contaminated: EvidenceBundle = {
    trace: trace([
      row("turn.user_final", "1:user"),
      row("provider_fallback", "1:reply", { leg: "stt", phase: "turn", to: "fallback" }),
    ]),
    ledger: { end: { eligibility: { eligible: true, reasons: [] } } },
  };
  assert.equal(measured(run("R8", context("R8", contaminated))).passed, false);
});

test("a fallback-contaminated run is ineligible and can never be certified", () => {
  const contaminated: EvidenceBundle = {
    trace: trace([
      row("turn.user_final", "1:user"),
      row("provider_fallback", "1:reply", { leg: "stt", phase: "turn", to: "fallback" }),
    ]),
    ledger: { end: { eligibility: { eligible: true, reasons: [] } } },
  };
  const result = measured(run("R8", context("R8", contaminated)));
  const judged = judgeRun({
    runId: "fallback-proof",
    contract,
    evidence: [
      {
        propertyId: "R8",
        bars: [],
        measurements: [
          {
            propertyId: "R8",
            scenario: "resilience-test",
            repetition: 1,
            outcome: "measured",
            samples: [],
            passed: result.passed,
            citations: result.citations ?? [],
          },
        ],
      },
    ],
    calls: [
      {
        callId: "call-1",
        scenario: "resilience-test",
        providerFallback: "stt at turn",
        budgetStop: null,
      },
    ],
  });
  assert.equal(judged.verdict, "ineligible");
  assert.equal(judged.certifiable, false);
  assert.doesNotMatch(judged.detail, /^certified/);
});
