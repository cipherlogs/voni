/**
 * The one map from a scoreboard gate to the scenario that produces its
 * evidence (voice-parity ticket 23).
 *
 * Every gate in `GATE_PRIORITY` prints a row in every artifact. A gate whose
 * producer scenario is missing from the default suite still prints that row,
 * but as INFO forever: the artifact looks healthy while nothing measured the
 * call. This table is the single list — the gate side (`score-demo`) and the
 * coverage test both read it, so a producer can neither be hand-added in two
 * places nor silently dropped from the suite.
 *
 * A gate that cannot be produced by a scenario says so and why (`run`,
 * `operator`, `manual`). "No entry" is never an option: adding a gate without
 * declaring its producer fails the build instead of shipping an INFO row.
 */
import { GATE_PRIORITY } from "./scoreboard";
import { EVAL_SCENARIOS, SUITE_SCENARIOS, type EvalScenario } from "./scenario-names";

export type GateName = (typeof GATE_PRIORITY)[number];

/**
 * The machine-readable line a producer scenario prints for its gate. One
 * gate can read several lines (the end-call-drain gate reads the closing
 * line's coverage and the runner's own hang-up delay, produced by different
 * scenarios), so the line is part of the mapping, not a second list.
 */
export type EvidenceLine =
  | "trace-gap"
  | "greeting-cut"
  | "real-cut"
  | "filler-run"
  | "overheard-aside"
  | "email-invite"
  | "double-talk"
  | "silence-timeline"
  | "goodbye-drain"
  | "hang-up-delay";

export type GateProducer =
  /** A live suite scenario prints this gate's evidence on its own stdout. */
  | {
      via: "scenario";
      producers: readonly { scenario: EvalScenario; line: EvidenceLine }[];
    }
  /** The run itself supplies it (runner outcome, artifact-level measurement check). */
  | { via: "run"; reason: string }
  /** A file the operator passes in (a saved capture, a probe JSON). */
  | { via: "operator"; reason: string }
  /** A human step outside the harness (a phone call, a replay). */
  | { via: "manual"; reason: string };

/**
 * Gate → producer. The scenario entries are the default suite's evidence: a
 * gate cannot lose one of these without failing `assertGateProducersInSuite`
 * by name.
 */
export const GATE_PRODUCERS = {
  plumbing: { via: "run", reason: "the runner's own EVAL SUMMARY / exit status (classifyRunnerOutcome)" },
  measurements: { via: "run", reason: "hasMeasuredEvidence over the artifact's own evidence" },
  "reply-gap": {
    via: "scenario",
    // The suite's primary excerpt is the greeting-cut call's merged trace;
    // every other merged trace contributes its own beat-attributed gaps.
    producers: [{ scenario: "greeting-cut", line: "trace-gap" }],
  },
  "end-of-turn": {
    via: "run",
    reason: "the served stored-agent body plus the merged Call trace's CONFIG scan; no scenario prints it",
  },
  "greeting-cut": { via: "scenario", producers: [{ scenario: "greeting-cut", line: "greeting-cut" }] },
  "barge-in-cut": { via: "scenario", producers: [{ scenario: "stop-over", line: "real-cut" }] },
  "filler-resume": { via: "scenario", producers: [{ scenario: "filler-over", line: "filler-run" }] },
  "overheard-recall": { via: "scenario", producers: [{ scenario: "over-talk", line: "overheard-aside" }] },
  "email-invite": { via: "scenario", producers: [{ scenario: "invite-tag", line: "email-invite" }] },
  "double-talk": { via: "scenario", producers: [{ scenario: "over-talk", line: "double-talk" }] },
  "dead-air": { via: "scenario", producers: [{ scenario: "silence-check-in", line: "silence-timeline" }] },
  "end-call-drain": {
    via: "scenario",
    producers: [
      // The closing line's own audio: coverage, inbox named, post-End narration.
      { scenario: "bye-audio", line: "goodbye-drain" },
      // The free-gate goodbye path (no work email): the same closing line.
      { scenario: "free-gate", line: "goodbye-drain" },
      // The measured session close after that audio, on both hang-up paths.
      { scenario: "hang-up-fast", line: "hang-up-delay" },
      { scenario: "hang-up-over", line: "hang-up-delay" },
    ],
  },
  "timbre-probes": {
    via: "operator",
    reason: "--probe-json (qa-voice-session agent channel + onAudioProbe counts) or one live session's probe evidence",
  },
  "accent-human": { via: "operator", reason: "human ballots supplied with --rate plus --recording/--recording-file" },
  "phone-checklist": { via: "manual", reason: "a human phone call on the pinned bridge; no browser suite scenario can run it" },
  "talk-hold-pinned": { via: "manual", reason: "a human replay of the Hold path against the pinned bridge" },
} as const satisfies Partial<Record<GateName, GateProducer>>;

/**
 * Compile-time exhaustiveness: every gate the artifact reports must declare a
 * producer here. A new gate in `GATE_PRIORITY` without a row is a type error,
 * not a silent INFO row in production.
 */
type EveryGateHasAProducer = Exclude<GateName, keyof typeof GATE_PRODUCERS> extends never ? true : never;
const everyGateHasAProducer: EveryGateHasAProducer = true;
void everyGateHasAProducer;

/** A producer table, complete or not: the test passes an intentionally broken one. */
export type GateProducerTable = Partial<Record<GateName, GateProducer | undefined>>;

/**
 * A gate lost its evidence: the named gate has no producer at all, names a
 * scenario the runner does not know, or names one the default suite does not
 * run. Named so a test (and a reader) can tell the three apart.
 */
export class MissingGateProducerError extends Error {
  readonly gate: GateName;
  readonly scenario: EvalScenario | string | undefined;
  readonly reason: "no-producer" | "unregistered" | "not-in-suite";

  constructor(gate: GateName, reason: "no-producer" | "unregistered" | "not-in-suite", scenario?: string) {
    const detail =
      reason === "no-producer"
        ? `has no producer: it would report INFO forever`
        : reason === "unregistered"
          ? `names producer "${scenario}", which is not a registered eval scenario (src/lib/demo/scenario-names.ts)`
          : `lost its producer scenario "${scenario}": it is not in the default suite ` +
            `(src/lib/demo/scenario-names.ts SUITE_SCENARIOS), so the gate can never measure it`;
    super(`gate "${gate}" ${detail}`);
    this.name = "MissingGateProducerError";
    this.gate = gate;
    this.reason = reason;
    this.scenario = scenario;
  }
}

/** The scenarios that print one evidence line for a gate (empty for non-scenario gates). */
export function producersFor(gate: GateName, line: EvidenceLine): readonly EvalScenario[] {
  const producer: GateProducer | undefined = GATE_PRODUCERS[gate];
  if (!producer || producer.via !== "scenario") return [];
  return producer.producers.filter((entry) => entry.line === line).map((entry) => entry.scenario);
}

export type GateProducerSummary = {
  gates: number;
  scenarioProducers: number;
  nonScenarioGates: number;
  suiteScenarios: number;
};

/**
 * Assert every gate has its producer and every scenario producer runs in the
 * default suite. Pure: no call, no file, no clock — it runs before the timing
 * lock and before any artifact exists, and a test can pass a suite with one
 * producer removed to prove the failure names it.
 */
export function assertGateProducersInSuite(
  suite: readonly string[] = SUITE_SCENARIOS,
  producers: GateProducerTable = GATE_PRODUCERS,
): void {
  const running = new Set(suite);
  for (const gate of GATE_PRIORITY) {
    const producer = producers[gate];
    if (!producer) throw new MissingGateProducerError(gate, "no-producer");
    if (producer.via !== "scenario") continue;
    if (producer.producers.length === 0) throw new MissingGateProducerError(gate, "no-producer");
    for (const { scenario } of producer.producers) {
      if (!(EVAL_SCENARIOS as readonly string[]).includes(scenario)) {
        throw new MissingGateProducerError(gate, "unregistered", scenario);
      }
      if (!running.has(scenario)) throw new MissingGateProducerError(gate, "not-in-suite", scenario);
    }
  }
}

/** The numbers printed at startup, so a run says the check happened. */
export function gateProducerSummary(suite: readonly string[] = SUITE_SCENARIOS): GateProducerSummary {
  const scenarioProducers = GATE_PRIORITY.flatMap((gate) => {
    const producer: GateProducer | undefined = GATE_PRODUCERS[gate];
    return producer?.via === "scenario" ? producer.producers.map((entry) => entry.scenario) : [];
  });
  return {
    gates: GATE_PRIORITY.length,
    scenarioProducers: new Set(scenarioProducers).size,
    nonScenarioGates: GATE_PRIORITY.filter((gate) => GATE_PRODUCERS[gate]?.via !== "scenario").length,
    suiteScenarios: suite.length,
  };
}
