import {
  TARGET_SELECTION_DEFAULT,
  type TargetSelection,
} from "@/lib/email/target-selection";
import {
  dispatchWorkflow,
  workflowRunUrl,
  type DispatchOutcome,
} from "@/lib/github/dispatch";
import type { BurstPlan } from "./plan";

/**
 * Dispatch a planned burst to GitHub Actions, or hand back the same run as a
 * copy-pasteable command when no dispatch token is configured.
 *
 * The panel cannot start a k6 Cloud run itself: the run needs the k6 Cloud
 * token and the generated script, and both belong on a runner rather than in a
 * Worker request. So the app's only job is one workflow dispatch, and the
 * workflow (`.github/workflows/burst.yml`) does the rest.
 *
 * A run must click the same list in the same mode as the panel's check, so the
 * dispatch carries both: the operator's targets and the target-selection mode
 * the generated script should use.
 *
 * Everything shared with the other dispatch sources — the token read, the
 * manual fallback, the request headers and timeout, the status sentences and
 * the redaction — lives in `@/lib/github/dispatch`. This file only names what
 * is specific to a burst.
 */

export const BURST_REPO = "cipherlogs/voni";
export const BURST_WORKFLOW_FILE = "burst.yml";
export const BURST_TOKEN_ENV = "GITHUB_BURST_TOKEN";

/**
 * A dispatch answers 204 with no body, so there is no run id to link to. The
 * workflow's page is the stable destination: it lists the queued run.
 */
export const BURST_RUN_URL = workflowRunUrl(BURST_REPO, BURST_WORKFLOW_FILE);

export type BurstDispatchResult = DispatchOutcome;

/**
 * The manual equivalent of the workflow's `k6 cloud run` step, planned VUs and
 * duration included so nobody has to redo the arithmetic. `K6_CLOUD_TOKEN` is
 * read from the environment by the k6 CLI, so the line carries no credential.
 */
export function burstCommand(plan: BurstPlan): string {
  return (
    `k6 cloud run --vus ${plan.vus} --duration ${plan.durationSec}s ` +
    "scripts/affiliate-click-check.k6.js"
  );
}

export type DispatchDeps = {
  /** Injecting `fetch` keeps the tests off the network. */
  fetcher?: typeof fetch;
  /** Injecting the reader keeps the tests off the environment and the Worker context. */
  readSecret?: (name: string) => Promise<string | undefined>;
  /**
   * The target list the run should click. The workflow writes this into the
   * generated script, so a burst uses today's panel list rather than whatever
   * `targets.json` held when the branch was last generated. Omitted means the
   * committed seed — the same list a manual `k6 cloud run` would use.
   */
  targets?: readonly string[];
  /**
   * How the run picks each click's target. The workflow writes this into the
   * generated script as `TARGET_SELECTION`, so a burst behaves the way the
   * panel's check does rather than falling back to whatever the committed seed
   * was built with. Omitted means `TARGET_SELECTION_DEFAULT`.
   */
  selection?: TargetSelection;
};

export async function dispatchBurst(
  plan: BurstPlan,
  deps: DispatchDeps = {},
): Promise<BurstDispatchResult> {
  // The planner already refuses these, but a hand-built plan must not reach the
  // API as a dispatch for nothing.
  if (plan.vus < 1 || plan.zones.length === 0) {
    return {
      ok: false,
      error: "The burst plan has no VUs or no load zones; nothing was dispatched.",
    };
  }

  return dispatchWorkflow({
    repo: BURST_REPO,
    workflowFile: BURST_WORKFLOW_FILE,
    tokenEnv: BURST_TOKEN_ENV,
    action: "burst",
    manualCommand: burstCommand(plan),
    fetcher: deps.fetcher,
    readSecret: deps.readSecret,
    inputs: {
      vus: String(plan.vus),
      duration: String(plan.durationSec),
      zones: JSON.stringify(plan.zones),
      // An empty input is how the workflow knows to keep the committed list;
      // sending "[]" would generate a script with no targets.
      targets:
        deps.targets && deps.targets.length > 0
          ? JSON.stringify(deps.targets)
          : "",
      // Always sent, never empty: the workflow asserts the generated script
      // carries exactly this mode, and an empty input would leave the run on
      // the committed script's mode without saying so.
      selection: deps.selection ?? TARGET_SELECTION_DEFAULT,
    },
  });
}
