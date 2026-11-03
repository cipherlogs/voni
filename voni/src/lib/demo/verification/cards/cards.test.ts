import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContractPropertyEntry, ResolvedThreshold } from "../contract";
import { judgeProperty } from "../verdict";
import type { PropertyVerdict } from "../verdict";
import {
  DefectCardError,
  buildDefectCards,
  parseReplayCommand,
  renderDefectCard,
  type BuildDefectCardsInput,
  type CallEvidence,
} from "./index";

/**
 * Ticket 09's acceptance, read off the ticket and the spec's "Evidence
 * artifacts". A card is only useful if triage starts with a pointer: a real
 * turn, an existing evidence file and an excerpt that resolves inside the WAV
 * it names. Every expected value below is a hand-pinned literal, never a
 * re-derivation from the builder.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../");

const P50: ResolvedThreshold = { source: "budget-record", key: "p50", value: 350, unit: "ms" };
const P95: ResolvedThreshold = { source: "budget-record", key: "p95", value: 700, unit: "ms" };
const MAX: ResolvedThreshold = { source: "budget-record", key: "max", value: 1200, unit: "ms" };

/** A 16-bit PCM mono WAV of exactly `durationMs`, written independently of the builder. */
function writeWav(path: string, durationMs: number, sampleRate = 16000): void {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const dataBytes = samples * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function touch(path: string, text = "{}\n"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function t1Entry(): ContractPropertyEntry {
  return {
    id: "T1",
    family: "turn-taking",
    statement: "First response (ack, backchannel or first word)",
    bar: { text: "p50 <= 350 ms, p95 <= 700 ms, max 1.2 s", numeric: true },
    evidence: "ledger",
    kind: "timing",
    repetitions: 3,
    thresholds: [P50, P95, MAX],
  };
}

/** A real verdict from ticket 07's engine: p50 420 ms, over the 350 ms bar. */
function failingT1(): PropertyVerdict {
  const verdict = judgeProperty(t1Entry(), {
    propertyId: "T1",
    bars: [
      { key: "p50", statistic: "p50", comparison: "at-most" },
      { key: "p95", statistic: "p95", comparison: "at-most" },
      { key: "max", statistic: "max", comparison: "at-most" },
    ],
    measurements: [
      { propertyId: "T1", scenario: "golden-flow", repetition: 1, outcome: "measured", samples: [400, 410], citations: ["call-abc#turn-1"] },
      { propertyId: "T1", scenario: "golden-flow", repetition: 2, outcome: "measured", samples: [420, 430], citations: ["call-abc#turn-1"] },
      { propertyId: "T1", scenario: "golden-flow", repetition: 3, outcome: "measured", samples: [440, 450], citations: ["call-abc#turn-1"] },
    ],
  });
  assert.equal(verdict.status, "FAIL");
  return verdict;
}

type Fixture = {
  root: string;
  call: CallEvidence;
  input: BuildDefectCardsInput;
};

/** One complete call: a turn with a caller take, a delivered WAV and evidence files. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "dv09-card-"));
  const callerTake = join(root, "calls", "call-abc", "caller", "opening.wav");
  const delivered = join(root, "calls", "call-abc", "delivered.wav");
  const trace = touch(join(root, "calls", "call-abc", "call-abc.jsonl"), '{"type":"turn.user_final"}\n');
  const endDoc = touch(join(root, "calls", "call-abc", "call-abc.end.json"), '{"turns":1}\n');
  const marks = touch(join(root, "calls", "call-abc", "call-marks.json"), '{"marks":[]}\n');
  writeWav(callerTake, 1000);
  writeWav(delivered, 2000);

  const call: CallEvidence = {
    callId: "call-abc",
    scenario: "golden-flow",
    locale: "en",
    target: "local",
    turns: [
      {
        turn: "1:reply",
        callerTake,
        deliveredWav: delivered,
        excerpts: [
          { media: "caller-take", file: callerTake, startMs: 100, endMs: 900 },
          { media: "delivered-wav", file: delivered, startMs: 250, endMs: 1750 },
        ],
        evidenceFiles: [trace],
      },
    ],
    evidenceFiles: [endDoc, marks],
  };

  return {
    root,
    call,
    input: {
      verdict: { runId: "run-1", properties: [failingT1()] },
      target: "local",
      calls: [call],
      attributions: [{ propertyId: "T1", callId: "call-abc", turn: "1:reply" }],
      modules: {
        T1: [
          "voice-pipeline/cascade/events.py",
          "voni/src/lib/demo/verification/verdict/judge.ts",
        ],
      },
      repoRoot: REPO_ROOT,
    },
  };
}

function assertRefusal(run: () => unknown, code: string, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DefectCardError, `expected DefectCardError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.equal(error.exitCode, 2, "a triage refusal is bad input or missing evidence");
    assert.match(error.message, pattern);
    return true;
  });
}

test("a complete card carries every field triage needs", () => {
  const setup = fixture();
  const cards = buildDefectCards(setup.input);

  assert.equal(cards.length, 1);
  const card = cards[0];

  assert.equal(card.id, "run-1/T1");
  assert.equal(card.propertyId, "T1");
  assert.equal(card.family, "turn-taking");
  assert.equal(card.property, "First response (ack, backchannel or first word)");
  assert.equal(card.severity, "major");
  assert.equal(card.scenario, "golden-flow");
  assert.equal(card.locale, "en");
  assert.equal(card.target, "local");

  assert.equal(card.expectedBar.text, "p50 <= 350 ms, p95 <= 700 ms, max 1.2 s");
  assert.equal(card.expectedBar.numeric, true);
  assert.deepEqual(
    card.expectedBar.thresholds.map((threshold) => threshold.value),
    [350, 700, 1200],
  );

  assert.equal(card.observed.value, 420);
  assert.equal(card.observed.unit, "ms");
  assert.equal(card.observed.statistic, "p50");
  assert.match(card.observed.detail, /420ms > 350ms/);

  assert.equal(card.citation.session, "call-abc");
  assert.equal(card.citation.turn, "1:reply");
  assert.equal(card.citation.turnAbsence, null);
  assert.equal(card.citation.scenario, "golden-flow");
  assert.equal(card.citation.locale, "en");
  assert.equal(card.citation.target, "local");
  assert.deepEqual(card.citation.audioExcerpts, setup.call.turns[0].excerpts);
  assert.deepEqual(
    card.citation.evidenceFiles,
    [
      join(setup.root, "calls", "call-abc", "call-abc.jsonl"),
      join(setup.root, "calls", "call-abc", "call-abc.end.json"),
      join(setup.root, "calls", "call-abc", "call-marks.json"),
    ],
  );

  assert.deepEqual(card.modules, [
    "voice-pipeline/cascade/events.py",
    "voni/src/lib/demo/verification/verdict/judge.ts",
  ]);
  assert.equal(
    card.replayCommand,
    "demo:verify --scenario golden-flow --target local --locale en --diagnose",
  );
  assert.deepEqual(parseReplayCommand(card.replayCommand), {
    program: "demo:verify",
    scenario: "golden-flow",
    target: "local",
    locale: "en",
    mode: "diagnose",
  });

  const rendered = renderDefectCard(card);
  assert.match(rendered, /run-1\/T1/);
  assert.match(rendered, /golden-flow/);
  assert.match(rendered, /demo:verify --scenario golden-flow --target local --locale en --diagnose/);
  assert.match(rendered, /420ms > 350ms/);
  for (const file of card.citation.evidenceFiles) {
    assert.ok(rendered.includes(file), `render must cite ${file}`);
  }
});

test("a card points at modules by path, never a line number that will drift", () => {
  const setup = fixture();
  const cards = buildDefectCards(setup.input);

  assert.ok(cards[0].modules.every((module) => !/:\d+|#L\d+|:\d+:\d+/.test(module)));
});

// ── refusal paths ───────────────────────────────────────────────────────────

function copy(
  input: BuildDefectCardsInput,
  patch: Partial<BuildDefectCardsInput>,
): BuildDefectCardsInput {
  return { ...input, ...patch };
}

function replaceTurn(
  setup: Fixture,
  patch: Partial<CallEvidence["turns"][number]>,
): BuildDefectCardsInput {
  const turn = setup.call.turns[0];
  return copy(setup.input, {
    calls: [{ ...setup.call, turns: [{ ...turn, ...patch }] }],
  });
}

test("a turn-level card without a turn is refused by name", () => {
  const setup = fixture();
  assertRefusal(
    () =>
      buildDefectCards(
        copy(setup.input, {
          attributions: [{ propertyId: "T1", callId: "call-abc" }],
        }),
      ),
    "turn-required",
    /T1.*turn level.*no attributed turn/,
  );
});

test("a turn the ledger does not name is refused by name", () => {
  const setup = fixture();
  assertRefusal(
    () =>
      buildDefectCards(
        copy(setup.input, {
          attributions: [{ propertyId: "T1", callId: "call-abc", turn: "9:reply" }],
        }),
      ),
    "unknown-turn",
    /call-abc.*9:reply/,
  );
});

test("an evidence file that does not exist is refused by name", () => {
  const setup = fixture();
  const missing = join(setup.root, "calls", "call-abc", "absent.jsonl");
  assertRefusal(
    () => buildDefectCards(replaceTurn(setup, { evidenceFiles: [missing] })),
    "missing-evidence-file",
    /absent\.jsonl/,
  );
});

test("a turn with no evidence file is refused by name", () => {
  const setup = fixture();
  assertRefusal(
    () => buildDefectCards(replaceTurn(setup, { evidenceFiles: [] })),
    "missing-evidence",
    /turn "1:reply".*cites no evidence file/,
  );
});

test("a card with no audio excerpt is refused by name", () => {
  const setup = fixture();
  assertRefusal(
    () => buildDefectCards(replaceTurn(setup, { excerpts: [] })),
    "missing-audio",
    /turn "1:reply".*cites no audio excerpt/,
  );
});

test("an excerpt that ends past its WAV is refused with the file's duration", () => {
  const setup = fixture();
  const turn = setup.call.turns[0];
  assertRefusal(
    () =>
      buildDefectCards(
        replaceTurn(setup, {
          excerpts: [
            { media: "caller-take", file: turn.callerTake!, startMs: 100, endMs: 1200 },
          ],
        }),
      ),
    "excerpt-out-of-bounds",
    /1200 ms.*1000 ms/,
  );
});

test("an excerpt that ends exactly at the WAV's end is accepted", () => {
  const setup = fixture();
  const turn = setup.call.turns[0];
  const cards = buildDefectCards(
    replaceTurn(setup, {
      excerpts: [{ media: "delivered-wav", file: turn.deliveredWav!, startMs: 0, endMs: 2000 }],
    }),
  );
  assert.equal(cards[0].citation.audioExcerpts[0].endMs, 2000);
});

test("an excerpt must resolve inside the take it names", () => {
  const setup = fixture();
  const turn = setup.call.turns[0];
  assertRefusal(
    () =>
      buildDefectCards(
        replaceTurn(setup, {
          excerpts: [
            { media: "caller-take", file: turn.deliveredWav!, startMs: 0, endMs: 100 },
          ],
        }),
      ),
    "audio-media-mismatch",
    /caller-take is/,
  );
});

test("a backward or zero-length excerpt is refused", () => {
  const setup = fixture();
  const turn = setup.call.turns[0];
  assertRefusal(
    () =>
      buildDefectCards(
        replaceTurn(setup, {
          excerpts: [
            { media: "caller-take", file: turn.callerTake!, startMs: 900, endMs: 900 },
          ],
        }),
      ),
    "invalid-excerpt",
    /not a forward span/,
  );
});

test("a failed property with no session and turn is refused by name", () => {
  const setup = fixture();
  assertRefusal(
    () => buildDefectCards(copy(setup.input, { attributions: [] })),
    "missing-attribution",
    /T1 failed with no session and turn/,
  );
});

test("a card is never built for a passing property", () => {
  const setup = fixture();
  const passing = judgeProperty(t1Entry(), {
    propertyId: "T1",
    bars: [
      { key: "p50", statistic: "p50", comparison: "at-most" },
      { key: "p95", statistic: "p95", comparison: "at-most" },
      { key: "max", statistic: "max", comparison: "at-most" },
    ],
    measurements: [1, 2, 3].map((repetition) => ({
      propertyId: "T1",
      scenario: "golden-flow",
      repetition,
      outcome: "measured" as const,
      samples: [100, 120],
      citations: [],
    })),
  });
  assert.equal(passing.status, "PASS");
  assertRefusal(
    () =>
      buildDefectCards(
        copy(setup.input, {
          verdict: { runId: "run-1", properties: [passing] },
          attributions: [{ propertyId: "T1", callId: "call-abc", turn: "1:reply" }],
        }),
      ),
    "card-for-pass",
    /passed/,
  );
});

test("an unknown session is refused by name", () => {
  const setup = fixture();
  assertRefusal(
    () =>
      buildDefectCards(
        copy(setup.input, {
          attributions: [{ propertyId: "T1", callId: "call-other", turn: "1:reply" }],
        }),
      ),
    "unknown-session",
    /call-other/,
  );
});

test("a call that ran a different target than the card replays is refused", () => {
  const setup = fixture();
  assertRefusal(
    () => buildDefectCards(copy(setup.input, { target: "staging" })),
    "target-mismatch",
    /"local".*"staging"/,
  );
});

test("a module pointer with a line number is refused because it drifts", () => {
  const setup = fixture();
  assertRefusal(
    () =>
      buildDefectCards(
        copy(setup.input, {
          modules: { T1: ["voice-pipeline/cascade/events.py:1491"] },
        }),
      ),
    "module-pointer",
    /line number/,
  );
});

test("a module pointer to a file that does not exist is refused", () => {
  const setup = fixture();
  assertRefusal(
    () =>
      buildDefectCards(
        copy(setup.input, {
          modules: { T1: ["voice-pipeline/cascade/absent.py"] },
        }),
      ),
    "missing-module-file",
    /absent\.py/,
  );
});

test("one card is produced for each failed property, call-level cards name no turn", () => {
  const setup = fixture();
  const turn = setup.call.turns[0];
  const e2 = judgeProperty(
    {
      id: "E2",
      family: "economics",
      statement: "Cost per demo call",
      bar: { text: "<= $0.15", numeric: true },
      evidence: "cost",
      kind: "deterministic",
      repetitions: 1,
      thresholds: [
        { source: "budget-record", key: "dvCostPerCallMaxUsd", value: 0.15, unit: "usd" },
      ],
    },
    {
      propertyId: "E2",
      bars: [
        { key: "dvCostPerCallMaxUsd", statistic: "max", comparison: "at-most" },
      ],
      measurements: [
        {
          propertyId: "E2",
          scenario: "golden-flow",
          repetition: 1,
          outcome: "measured",
          samples: [0.42],
          citations: [],
        },
      ],
    },
  );
  assert.equal(e2.status, "FAIL");

  const costRow = touch(join(setup.root, "calls", "call-abc", "cost.jsonl"), '{"type":"cost.priced"}\n');
  const call: CallEvidence = {
    ...setup.call,
    deliveredWav: turn.deliveredWav,
    excerpts: [{ media: "delivered-wav", file: turn.deliveredWav!, startMs: 250, endMs: 1750 }],
    evidenceFiles: [...setup.call.evidenceFiles, costRow],
  };

  const cards = buildDefectCards({
    ...setup.input,
    verdict: { runId: "run-1", properties: [failingT1(), e2] },
    calls: [call],
    attributions: [
      { propertyId: "T1", callId: "call-abc", turn: "1:reply" },
      { propertyId: "E2", callId: "call-abc" },
    ],
    modules: {
      T1: ["voice-pipeline/cascade/events.py"],
      E2: ["voice-pipeline/cascade/cost.py"],
    },
  });

  assert.deepEqual(cards.map((card) => card.id), ["run-1/T1", "run-1/E2"]);
  const cost = cards[1];
  assert.equal(cost.severity, "major");
  assert.equal(cost.citation.turn, null);
  assert.match(cost.citation.turnAbsence ?? "", /call level/);
  assert.deepEqual(cost.citation.audioExcerpts, [
    { media: "delivered-wav", file: turn.deliveredWav, startMs: 250, endMs: 1750 },
  ]);
  assert.match(renderDefectCard(cost), /Turn: none/);
});

test("a run with no failed property produces no cards", () => {
  const setup = fixture();
  assert.deepEqual(
    buildDefectCards(
      copy(setup.input, {
        verdict: { runId: "run-1", properties: [] },
        attributions: [],
      }),
    ),
    [],
  );
});

test("an evidence source the card cannot place is refused instead of guessed", () => {
  const setup = fixture();
  const property = failingT1();
  assertRefusal(
    () =>
      buildDefectCards(
        copy(setup.input, {
          verdict: {
            runId: "run-1",
            properties: [{ ...property, evidence: "mystery" as never }],
          },
        }),
      ),
    "unknown-evidence",
    /neither turn-level nor call-level/,
  );
});
