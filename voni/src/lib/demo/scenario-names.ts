/**
 * The one registry of scenario names the demo harness accepts.
 *
 * A scenario name is the harness's only selector: `score-demo` forwards it to
 * the live eval runner, which filters its own scenario lists by exact name.
 * Before this registry, a misspelt name matched nothing in every list, so the
 * runner printed a summary with an empty `scenarios` list, exited 0, and
 * `score-demo` wrote a passing artifact that measured nothing. A typo is now a
 * named failure raised before the artifact (and, in the runner, before the
 * event stream) exists.
 *
 * The runner's scenario definitions are typed with `EvalScenario`, so a new
 * definition cannot be added without registering its name here, and
 * `assertScenariosRegistered` catches the dangerous reverse drift: a stale name
 * left in this list that no definition answers.
 */

/** Every scenario the live eval runner can execute (`scripts/eval-demo-agent.mts`). */
export const EVAL_SCENARIOS = [
  // Raw-socket tool scenarios.
  "hang-up",
  "refusal",
  // Live client scenarios (the stored agent over the real session).
  "filler-over",
  "stop-over",
  "over-talk",
  "hang-up-fast",
  "hang-up-over",
  "greeting-cut",
  "silence-check-in",
  // Email-test scenarios (raw socket, the demo's real tools).
  "bye-audio",
  "invite-tag",
  "sent-no-placeholder",
  "forgot-tag",
  "free-gate",
  "late-close",
  "returning",
] as const;

export type EvalScenario = (typeof EVAL_SCENARIOS)[number];

/**
 * The one-command suite's scenarios, one at a time under one timing lock. Each
 * carries scoreboard evidence, and `assertGateProducersInSuite`
 * (src/lib/demo/gate-producers.ts) fails by name if a gate's producer leaves
 * this list.
 *
 * Both goodbye-drain paths run: bye-audio (no work-email invite) and free-gate
 * (the free-address gate), so the end-call-drain gate keeps a measured closing
 * line even when one path's invite flow changes. hang-up-fast and hang-up-over
 * supply the measured hang-up delay on that same gate.
 */
export const SUITE_SCENARIOS = [
  "greeting-cut",
  "filler-over",
  "stop-over",
  "over-talk",
  "silence-check-in",
  "invite-tag",
  "bye-audio",
  "free-gate",
  "hang-up-fast",
  "hang-up-over",
] as const satisfies readonly EvalScenario[];

/** The unknown-name failure: named so callers and tests can tell it apart. */
export class UnknownScenarioError extends Error {
  readonly requested: string;

  constructor(requested: string) {
    super(
      `unknown scenario "${requested}". Valid scenarios: ${EVAL_SCENARIOS.join(", ")} ` +
        `(or "all"/"suite" for every scenario).`,
    );
    this.name = "UnknownScenarioError";
    this.requested = requested;
  }
}

/** `all`, `suite` or an absent value mean every scenario. */
export function isAllScenarioSelector(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "all" || trimmed === "suite";
}

/** Resolve one scenario name, or throw `UnknownScenarioError` naming it. */
export function resolveScenarioName(requested: string): EvalScenario {
  const name = requested.trim();
  if ((EVAL_SCENARIOS as readonly string[]).includes(name)) return name as EvalScenario;
  throw new UnknownScenarioError(name);
}

/**
 * Assert the runner's own definitions and this registry describe the same set
 * of scenarios. Called once at the runner's startup, before any call: a drift
 * is a harness break, never a filter that quietly matches nothing.
 */
export function assertScenariosRegistered(names: readonly string[]): void {
  const defined = new Set(names);
  const unregistered = [...defined].filter((name) => !(EVAL_SCENARIOS as readonly string[]).includes(name));
  if (unregistered.length > 0) {
    throw new Error(
      `scenario(s) ${unregistered.map((name) => `"${name}"`).join(", ")} have a definition but are not registered ` +
        `in EVAL_SCENARIOS (src/lib/demo/scenario-names.ts)`,
    );
  }
  const undefinedNames = EVAL_SCENARIOS.filter((name) => !defined.has(name));
  if (undefinedNames.length > 0) {
    throw new Error(
      `registered scenario(s) ${undefinedNames.map((name) => `"${name}"`).join(", ")} have no definition in ` +
        "the eval runner; remove them or add their scenario",
    );
  }
}
