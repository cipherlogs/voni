import { secret } from "@/lib/env";
import {
  TARGET_SELECTION_DEFAULT,
  type TargetSelection,
} from "@/lib/email/target-selection";
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
 * The token is optional on purpose. Requiring a fine-grained PAT with Actions
 * write access just to try a burst is a gate nobody needs, and the repo already
 * holds `K6_CLOUD_TOKEN` for the manual path. So an absent token is a normal
 * outcome — `mode: "manual"` with the exact command — not a failure. A token
 * that is present but wrong is still an error, with the 401/403/404 split.
 *
 * Nothing here logs. The dispatch token is a bearer credential with Actions
 * write access on the repository, which is a much larger grant than the run
 * needs to observe, so it is only ever put in a header — and every string this
 * module returns is redacted against it before it leaves.
 */

export const BURST_REPO = "cipherlogs/voni";
export const BURST_WORKFLOW_FILE = "burst.yml";
export const BURST_TOKEN_ENV = "GITHUB_BURST_TOKEN";

/**
 * A dispatch answers 204 with no body, so there is no run id to link to. The
 * workflow's page is the stable destination: it lists the queued run.
 */
export const BURST_RUN_URL = `https://github.com/${BURST_REPO}/actions/workflows/${BURST_WORKFLOW_FILE}`;

const DISPATCH_URL = `https://api.github.com/repos/${BURST_REPO}/actions/workflows/${BURST_WORKFLOW_FILE}/dispatches`;

export type BurstDispatchResult =
  | { ok: true; mode: "dispatched"; runUrl: string }
  | { ok: true; mode: "manual"; fallback: { command: string } }
  | { ok: false; error: string };

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

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** GitHub's own explanation, when it sent one. Never the token. */
async function githubMessage(response: Response): Promise<string> {
  // GitHub is not consistent: permission errors are JSON, but its edge answers
  // some refusals (a missing User-Agent, for one) with plain text. Reading only
  // JSON is what hid "Request forbidden by administrative rules" behind the
  // generic 403 sentence.
  let text = "";
  try {
    text = await response.text();
  } catch {
    return "";
  }

  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && "message" in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string" && message.trim() !== "") {
        return `: ${message.trim().slice(0, 200)}`;
      }
    }
  } catch {
    // Not JSON: fall through to the plain text, if any.
  }

  const plain = text.replace(/\s+/g, " ").trim();
  return plain === "" ? "" : `: ${plain.slice(0, 200)}`;
}

/** The token must not survive into a UI string, a log line, or a job row. */
function redact(text: string, token: string): string {
  return token === "" ? text : text.split(token).join("[redacted]");
}

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

  const readSecret = deps.readSecret ?? secret;
  const token = await readSecret(BURST_TOKEN_ENV);
  if (!token) {
    // Not an error: the operator can run the same plan themselves. The command
    // is derived from the plan so it cannot disagree with the workflow's flags.
    return {
      ok: true,
      mode: "manual",
      fallback: { command: burstCommand(plan) },
    };
  }

  const fetcher = deps.fetcher ?? fetch;

  let response: Response;
  try {
    response = await fetcher(DISPATCH_URL, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        // GitHub answers any request without a User-Agent with a 403 and a
        // plain-text body ("Request forbidden by administrative rules"), which
        // reads exactly like a permission refusal and cost a day of chasing a
        // token that was correct all along. undici's default UA does not count.
        "user-agent": "voni-burst",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          vus: String(plan.vus),
          duration: String(plan.durationSec),
          zones: JSON.stringify(plan.zones),
          // An empty input is how the workflow knows to keep the committed
          // list; sending "[]" would generate a script with no targets.
          targets: deps.targets && deps.targets.length > 0
            ? JSON.stringify(deps.targets)
            : "",
          // Always sent, never empty: the workflow asserts the generated
          // script carries exactly this mode, and an empty input would leave
          // the run on the committed script's mode without saying so.
          selection: deps.selection ?? TARGET_SELECTION_DEFAULT,
        },
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (error) {
    return {
      ok: false,
      error: redact(
        `Could not reach GitHub to dispatch the burst: ${messageOf(error)}`,
        token,
      ),
    };
  }

  if (response.ok) {
    return { ok: true, mode: "dispatched", runUrl: BURST_RUN_URL };
  }

  const detail = await githubMessage(response);
  const fail = (sentence: string) =>
    ({ ok: false, error: redact(`${sentence}${detail}`, token) }) as const;

  switch (response.status) {
    case 401:
      return fail(
        `GitHub rejected ${BURST_TOKEN_ENV} (401): the token is unset, expired, or does not belong to an account that can see ${BURST_REPO}.`,
      );
    case 403:
      return fail(
        `GitHub refused the burst dispatch (403): ${BURST_TOKEN_ENV} needs Actions write access on ${BURST_REPO}.`,
      );
    case 404:
      return fail(
        `GitHub could not find ${BURST_WORKFLOW_FILE} on ${BURST_REPO} (404): the workflow must exist on the main branch.`,
      );
    default:
      return fail(
        `GitHub returned HTTP ${response.status} for the burst dispatch.`,
      );
  }
}
