import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDefectCards, type CallEvidence } from "../../cards";
import { loadContract, type Contract } from "../../contract";
import type { PropertyEvidence, RunVerdict } from "../types";
import { judgeProperty } from "../judge";
import { evaluateScenarios } from "../evaluators";
import comprehension from "./comprehension.evaluators";

/**
 * Ticket 13's acceptance, read off the ticket and the spec's "Comprehension
 * and content" table. Each K property is judged through the public verdict
 * seam — evidence source, authored facts, then the engine's bar — so a test
 * that passes cannot pass with the evaluator deleted.
 *
 * The synthetic evidence below is the shape an adapter must supply. The
 * protocol adapter does not supply a transcript or tool arguments yet, so a
 * real run of these evaluators is unmeasured (fail closed), never green.
 */

let contractPromise: Promise<Contract> | null = null;
const contract = () => {
  contractPromise ??= loadContract();
  return contractPromise;
};

const locale = "en";

function evaluatorFor(id: string) {
  const found = comprehension.evaluators.find((entry) => entry.propertyId === id);
  assert.ok(found, `no evaluator for ${id}`);
  return found;
}

async function pairFor(
  id: string,
  source: unknown,
  facts: unknown,
  attempts = 1,
): Promise<{ property: Contract["properties"][number]; evidence: PropertyEvidence }> {
  const loaded = await contract();
  const property = loaded.properties.find((entry) => entry.id === id);
  assert.ok(property, `the contract has no ${id}`);
  const evidence = await evaluateScenarios({
    contract: loaded,
    evaluators: [evaluatorFor(id)],
    attempts: Array.from({ length: attempts }, (_, index) => ({
      scenario: "comprehension-example",
      repetition: index + 1,
      locale,
      evidence: { [property.evidence]: source },
      facts: facts as never,
    })),
  });
  return { property, evidence: evidence[0] as PropertyEvidence };
}

async function judged(id: string, source: unknown, facts: unknown, attempts = 1) {
  const pair = await pairFor(id, source, facts, attempts);
  return judgeProperty(pair.property, pair.evidence);
}

const SPELLED_EMAIL_FACTS = {
  takes: [
    { id: "intro", text: "I would like the pricing guide emailed to me." },
    { id: "email", text: "My email is j dot c h a n at example dot com." },
    {
      id: "correction",
      text: "Sorry, no. J dot c h e n at example dot com.",
    },
  ],
};

const NUMBER_FACTS = {
  takes: [{ id: "number", text: "My reference number is 4 1 5 2 0 8 7 6." }],
};

const NAME_FACTS = {
  takes: [
    { id: "intro", text: "I would like to update my details." },
    { id: "name", text: "My name is Amara. A m a r a." },
  ],
};

function toolSource(address: string, turn = "2:reply") {
  return {
    calls: [
      {
        name: "check_email",
        toolCallId: "call_1",
        turn,
        arguments: { address },
      },
    ],
    results: [{ name: "check_email", toolCallId: "call_1", ok: true }],
  };
}

function traceWith(agentText: string, turn = "2:reply") {
  return {
    rows: [{ type: "turn.reply_start", turn }],
    transcript: {
      turns: [
        { id: "1:caller", speaker: "caller", text: "Number 4 1 5 2 0 8 7 6." },
        { id: turn, speaker: "agent", text: agentText },
      ],
    },
  };
}

function judgeFinding(id: string, finding: Record<string, unknown>) {
  return { findings: [{ propertyId: id, ...finding }] };
}

// ── K1 ───────────────────────────────────────────────────────────────────────

test("K1 passes when the delivered address is the corrected spelling, and cites the turn", async () => {
  const verdict = await judged("K1", toolSource("j.chen@example.com"), SPELLED_EMAIL_FACTS);
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.reason, "pass");
  assert.equal(verdict.sampleCount, 1);
  assert.deepEqual(verdict.citations, ["turn:2:reply"]);
});

test("K1 fails on the uncorrected spelling and names both entities", async () => {
  const verdict = await judged("K1", toolSource("j.chan@example.com"), SPELLED_EMAIL_FACTS);
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "below-bar");
  assert.match(verdict.detail, /j\.chen@example\.com/);
  assert.match(verdict.detail, /j\.chan@example\.com/);
});

test("K1 is unmeasured without tool arguments, which the protocol adapter does not record", async () => {
  const verdict = await judged(
    "K1",
    { calls: [{ name: "check_email", toolCallId: "call_1", turn: "2:reply" }], results: [] },
    SPELLED_EMAIL_FACTS,
  );
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
  assert.match(verdict.detail, /arguments/);
});

test("K1 is unmeasured without authored caller words, never guessed from the audio", async () => {
  const verdict = await judged("K1", toolSource("j.chen@example.com"), undefined);
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
  assert.match(verdict.detail, /authored caller words|facts/i);
});

// ── K2 ───────────────────────────────────────────────────────────────────────

test("K2 passes when the agent reads the caller's number back exactly", async () => {
  const verdict = await judged(
    "K2",
    traceWith("Your reference number is 415 208 76."),
    NUMBER_FACTS,
  );
  assert.equal(verdict.status, "PASS");
  assert.deepEqual(verdict.citations, ["turn:2:reply"]);
});

test("K2 fails on one wrong digit and names the number", async () => {
  const verdict = await judged(
    "K2",
    traceWith("Your reference number is 415 208 77."),
    NUMBER_FACTS,
  );
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "below-bar");
  assert.match(verdict.detail, /41520876/);
});

test("K2 is unmeasured when the trace carries no transcript", async () => {
  const verdict = await judged("K2", { rows: [] }, NUMBER_FACTS);
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
});

// ── K3 ───────────────────────────────────────────────────────────────────────

test("K3 passes when the unusual name is used exactly once", async () => {
  const verdict = await judged("K3", traceWith("Thanks, Amara. I have updated it."), NAME_FACTS, 3);
  assert.equal(verdict.status, "PASS");
});

test("K3 fails when the name is never used", async () => {
  const verdict = await judged("K3", traceWith("Thanks. I have updated it."), NAME_FACTS, 3);
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /amara/i);
});

test("K3 fails when the name is repeated, because the bar is exactly once", async () => {
  const verdict = await judged("K3", traceWith("Amara, thanks. Amara, it is done."), NAME_FACTS, 3);
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /2 times/);
});

// ── K4 ───────────────────────────────────────────────────────────────────────

test("K4 passes when the judge saw one targeted question and no guess", async () => {
  const verdict = await judged(
    "K4",
    judgeFinding("K4", { clarificationCount: 1, guessed: false, passed: true, citations: ["turn:2:reply"] }),
    undefined,
    3,
  );
  assert.equal(verdict.status, "PASS");
});

test("K4 fails when the agent guessed instead of asking", async () => {
  const verdict = await judged(
    "K4",
    judgeFinding("K4", { clarificationCount: 1, guessed: true, passed: false, citations: ["turn:2:reply"] }),
    undefined,
    3,
  );
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /guess/i);
});

test("K4 fails closed on a loop: two clarifications have no frozen number", async () => {
  const verdict = await judged(
    "K4",
    judgeFinding("K4", { clarificationCount: 2, guessed: false, passed: false, citations: ["turn:2:reply"] }),
    undefined,
    3,
  );
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
  assert.match(verdict.detail, /2 clarification/);
});

// ── K5 ───────────────────────────────────────────────────────────────────────

test("K5 passes an English reply in an English Locale and counts no leak", async () => {
  const verdict = await judged(
    "K5",
    traceWith("Of course, I can check that for you."),
    undefined,
  );
  assert.equal(verdict.status, "PASS");
});

test("K5 fails when the reply leaks the caller's other language", async () => {
  const verdict = await judged("K5", traceWith("Claro, perfecto, I can check."), undefined);
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /claro/);
});

// ── K6 ───────────────────────────────────────────────────────────────────────

test("K6 passes when the judge saw the code-switch understood and the reply in Locale", async () => {
  const verdict = await judged(
    "K6",
    judgeFinding("K6", {
      codeSwitched: true,
      stayedInLocale: true,
      citations: ["turn:1:caller", "turn:2:reply"],
      passed: true,
    }),
    undefined,
    3,
  );
  assert.equal(verdict.status, "PASS");
});

test("K6 fails when the reply follows the caller out of the Locale", async () => {
  const verdict = await judged(
    "K6",
    judgeFinding("K6", { codeSwitched: true, stayedInLocale: false, passed: false }),
    undefined,
    3,
  );
  assert.equal(verdict.status, "FAIL");
});

test("K6 is unmeasured when the judge saw no code-switch to judge", async () => {
  const verdict = await judged(
    "K6",
    judgeFinding("K6", { codeSwitched: false, stayedInLocale: true, passed: true }),
    undefined,
    3,
  );
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unmeasured");
});

// ── K7 ───────────────────────────────────────────────────────────────────────

test("K7 passes a judge reading with no invented fact", async () => {
  const verdict = await judged(
    "K7",
    judgeFinding("K7", { invented: [], passed: true, citations: ["turn:2:reply"] }),
    undefined,
    3,
  );
  assert.equal(verdict.status, "PASS");
});

test("K7 fails an invented fact and quotes the invented line", async () => {
  const line = "We are open until nine every Sunday.";
  const verdict = await judged(
    "K7",
    judgeFinding("K7", {
      invented: [{ quoted: line, turn: "2:reply" }],
      passed: false,
      citations: ["turn:2:reply"],
    }),
    undefined,
    3,
  );
  assert.equal(verdict.status, "FAIL");
  assert.match(verdict.detail, /We are open until nine every Sunday\./);
});

// ── K8 ───────────────────────────────────────────────────────────────────────

const CALLER_ONLY = {
  file: "/tmp/delivered.wav",
  transcript: {
    turns: [
      { id: "1:caller", speaker: "caller", text: "My email is j dot c h e n at example dot com." },
    ],
  },
};

test("K8 measures entity agreement against the known take, and the word error against that take", async () => {
  const pair = await pairFor("K8", CALLER_ONLY, NAME_FACTS_FOR_K8);
  const measurement = pair.evidence.measurements[0];
  assert.equal(measurement?.outcome, "measured");
  assert.equal(measurement?.samples[0], 0);
  assert.match(measurement?.detail ?? "", /word error 0\b|word error 0\./);
  assert.match(measurement?.detail ?? "", /known take text/);
});

test("K8 fails an entity the transcript changed, even when every other word agrees", async () => {
  const changed = {
    ...CALLER_ONLY,
    transcript: {
      turns: [
        { id: "1:caller", speaker: "caller", text: "My email is j dot c h a n at example dot com." },
      ],
    },
  };
  const pair = await pairFor("K8", changed, NAME_FACTS_FOR_K8);
  const measurement = pair.evidence.measurements[0];
  assert.equal(measurement?.samples[0], 2);
  assert.match(measurement?.detail ?? "", /j\.chen@example\.com/);
});

test("K8 never scores the agent's own transcript: an added agent turn changes nothing", async () => {
  const withAgent = {
    ...CALLER_ONLY,
    transcript: {
      turns: [
        ...CALLER_ONLY.transcript.turns,
        { id: "2:reply", speaker: "agent", text: "I invented a different address entirely." },
      ],
    },
  };
  const alone = await pairFor("K8", CALLER_ONLY, NAME_FACTS_FOR_K8);
  const together = await pairFor("K8", withAgent, NAME_FACTS_FOR_K8);
  assert.deepEqual(
    alone.evidence.measurements[0]?.samples,
    together.evidence.measurements[0]?.samples,
  );
  assert.equal(
    alone.evidence.measurements[0]?.detail,
    together.evidence.measurements[0]?.detail,
  );
});

test("K8 is still unresolved in the contract: no word-error bar was invented", async () => {
  const loaded = await contract();
  const k8 = loaded.properties.find((property) => property.id === "K8");
  assert.ok(k8);
  assert.ok(k8.unresolved, "K8 must stay unresolved until a frozen record carries a word-error bar");
  const verdict = judgeProperty(k8, undefined);
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "unresolved");
});

const NAME_FACTS_FOR_K8 = {
  takes: [{ id: "email", text: "My email is j dot c h e n at example dot com." }],
};

// ── Cards ────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../..");

function writeWav(path: string, durationMs = 200): string {
  const sampleRate = 16000;
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const dataBytes = samples * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function runVerdict(properties: RunVerdict["properties"]): RunVerdict {
  return {
    runId: "run-13",
    verdict: "not-demo-ready",
    certifiable: false,
    eligible: true,
    eligibility: { eligible: true, reasons: [], callCount: 1 },
    properties,
    failedPropertyIds: properties.filter((property) => property.status === "FAIL").map((property) => property.propertyId),
    unknownPropertyIds: [],
    failures: [],
    sampleCount: 1,
    citations: [],
    detail: "test",
  };
}

function callEvidence(
  scenario: string,
  wav: string,
  trace: string,
  options: { turn?: boolean } = {},
): CallEvidence {
  const excerpts = [{ media: "delivered-wav" as const, file: wav, startMs: 0, endMs: 100 }];
  return {
    callId: "call-13",
    scenario,
    locale: "en",
    target: "local",
    turns:
      options.turn === false
        ? []
        : [{ turn: "2:reply", deliveredWav: wav, excerpts, evidenceFiles: [trace] }],
    deliveredWav: wav,
    excerpts,
    evidenceFiles: [trace],
  };
}

function tempFiles(): { root: string; wav: string; trace: string } {
  const root = mkdtempSync(join(tmpdir(), "dv13-card-"));
  const wav = writeWav(join(root, "delivered.wav"));
  const trace = join(root, "trace.jsonl");
  writeFileSync(trace, `${JSON.stringify({ type: "turn.reply_start", turn: "2:reply" })}\n`);
  return { root, wav, trace };
}

test("a wrong email readback produces a card that names the entity the agent used", async () => {
  const { wav, trace } = tempFiles();
  const pair = await pairFor("K1", toolSource("j.chan@example.com"), SPELLED_EMAIL_FACTS);
  const verdict = judgeProperty(pair.property, pair.evidence);
  const [card] = buildDefectCards({
    verdict: runVerdict([verdict]),
    target: "local",
    calls: [callEvidence("comprehension-example", wav, trace)],
    attributions: [{ propertyId: "K1", callId: "call-13", turn: "2:reply", scenario: "comprehension-example" }],
    modules: { K1: ["voni/src/lib/demo/verification/verdict/evaluators/comprehension.evaluators.ts"] },
    repoRoot: REPO_ROOT,
  });
  assert.ok(card);
  assert.equal(card.propertyId, "K1");
  assert.equal(card.citation.turn, "2:reply");
  assert.match(card.observed.detail, /j\.chan@example\.com/);
});

test("an invented fact produces a card that quotes the invented line", async () => {
  const { wav, trace } = tempFiles();
  const line = "We are open until nine every Sunday.";
  const pair = await pairFor(
    "K7",
    judgeFinding("K7", {
      invented: [{ quoted: line, turn: "2:reply" }],
      passed: false,
      citations: ["turn:2:reply"],
    }),
    undefined,
    3,
  );
  const verdict = judgeProperty(pair.property, pair.evidence);
  const [card] = buildDefectCards({
    verdict: runVerdict([verdict]),
    target: "local",
    calls: [callEvidence("comprehension-example", wav, trace, { turn: false })],
    attributions: [{ propertyId: "K7", callId: "call-13", scenario: "comprehension-example" }],
    modules: { K7: ["voni/src/lib/demo/verification/verdict/evaluators/comprehension.evaluators.ts"] },
    repoRoot: REPO_ROOT,
  });
  assert.ok(card);
  assert.equal(card.propertyId, "K7");
  assert.match(card.observed.detail, /We are open until nine every Sunday\./);
  assert.match(card.detail, /We are open until nine every Sunday\./);
});
