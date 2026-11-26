import { secret } from "@/lib/env";
import { RUNNER_OS_VALUES, type RunnerOs } from "@/lib/email/click-report";
import {
  PROXY_POOL_MAX,
  PROXY_POOL_MIN,
  parseProxyPoolTarget,
} from "@/lib/email/proxy-policy";
import { readProxySettings } from "@/lib/email/proxy-settings";
import { MAX_JOB_SECONDS } from "@/lib/email/sources";
import {
  parseTargetSelection,
  type TargetSelection,
} from "@/lib/email/target-selection";

/**
 * One bounded GitHub Actions workflow dispatch, shared by every source that
 * needs to start a run.
 *
 * A caller supplies only what is specific to its workflow: the repository, the
 * workflow file, the token variable, a noun for the sentences, the string
 * inputs, and the command a human would run by hand. Everything that must
 * never differ between callers lives here — the request headers (including the
 * User-Agent GitHub demands), the ten-second ceiling, the status-specific
 * sentences, and redaction of the token from every returned string.
 *
 * The token is optional on purpose. An absent token is `mode: "manual"` with
 * the caller's command, not a failure: a fine-grained PAT with Actions write
 * access is a gate a reader should not need just to start one run. A token that
 * is present but wrong is still an error, with the 401/403/404 split.
 *
 * Nothing here logs. The dispatch token is a bearer credential with Actions
 * write access on the repository, so it only ever goes in a header — and every
 * string this module returns is redacted against it before it leaves.
 */

/** A dispatch answers 204 with no body, so the workflow page is the destination. */
export function workflowRunUrl(repo: string, workflowFile: string): string {
  return `https://github.com/${repo}/actions/workflows/${workflowFile}`;
}

/** The bounded wait: a dispatch is one small POST, not a job. */
export const DISPATCH_TIMEOUT_MS = 10_000;

export type DispatchOutcome =
  | { ok: true; mode: "dispatched"; runUrl: string }
  | { ok: true; mode: "manual"; fallback: { command: string } }
  | { ok: false; error: string };

export type WorkflowDispatch = {
  /** `owner/repo`, as GitHub's API expects it in the path. */
  repo: string;
  /** The workflow file name, e.g. `burst.yml`. */
  workflowFile: string;
  /** The environment variable holding the dispatch token. */
  tokenEnv: string;
  /**
   * The noun the operator reads in every sentence ("burst", "browser check"),
   * and the suffix of the required User-Agent unless one is given.
   */
  action: string;
  /** Every input the workflow declares, already stringified. */
  inputs: Record<string, string>;
  /** What a human runs when no token is configured. */
  manualCommand: string;
  /** Branch or tag the workflow is dispatched on. Defaults to `main`. */
  ref?: string;
  /** Overrides the default `voni-<action>` User-Agent. */
  userAgent?: string;
  /** Injecting `fetch` keeps the tests off the network. */
  fetcher?: typeof fetch;
  /** Injecting the reader keeps the tests off the environment and the Worker context. */
  readSecret?: (name: string) => Promise<string | undefined>;
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

/**
 * The headers every GitHub API call sends.
 *
 * One copy, because the User-Agent is not optional in practice: GitHub answers a
 * UA-less request with a 403 and a plain-text body ("Request forbidden by
 * administrative rules") that reads exactly like a permission refusal. That cost
 * a day of chasing a token that was correct; a second caller with its own header
 * set would have rediscovered it.
 */
function githubHeaders(token: string, userAgent: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": userAgent,
  };
}

/**
 * The status sentences that must never differ between callers.
 *
 * A token that is wrong, short of scope, or throttled is the same fact whether
 * the caller was dispatching a run or cancelling one; only the operation noun
 * changes. Returns `null` for a status the caller words itself (404 means
 * different things to a dispatch and a run lookup).
 */
function githubRefusal(
  status: number,
  context: { tokenEnv: string; repo: string; operation: string; detail: string },
): string | null {
  const { tokenEnv, repo, operation, detail } = context;
  switch (status) {
    case 401:
      return `GitHub rejected ${tokenEnv} (401): the token is unset, expired, or does not belong to an account that can see ${repo}.${detail}`;
    case 403:
      return `GitHub refused ${operation} (403): ${tokenEnv} needs Actions write access on ${repo}.${detail}`;
    case 429:
      return `GitHub rate-limited ${operation} (429): wait for the limit to reset before trying again.${detail}`;
    default:
      return null;
  }
}

export async function dispatchWorkflow(
  dispatch: WorkflowDispatch,
): Promise<DispatchOutcome> {
  const {
    repo,
    workflowFile,
    tokenEnv,
    action,
    inputs,
    manualCommand,
    ref = "main",
  } = dispatch;

  const readSecret = dispatch.readSecret ?? secret;
  const token = await readSecret(tokenEnv);
  if (!token) {
    // Not an error: the operator can do the same work by hand, and the command
    // is the caller's, so it cannot disagree with its own workflow's flags.
    return { ok: true, mode: "manual", fallback: { command: manualCommand } };
  }

  const fetcher = dispatch.fetcher ?? fetch;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        ...githubHeaders(token, dispatch.userAgent ?? `voni-${action}`),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref, inputs }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return {
      ok: false,
      error: redact(
        `Could not reach GitHub to dispatch the ${action}: ${messageOf(error)}`,
        token,
      ),
    };
  }

  if (response.ok) {
    return {
      ok: true,
      mode: "dispatched",
      runUrl: redact(workflowRunUrl(repo, workflowFile), token),
    };
  }

  const detail = await githubMessage(response);
  const fail = (sentence: string) =>
    ({ ok: false, error: redact(`${sentence}${detail}`, token) }) as const;

  const shared = githubRefusal(response.status, {
    tokenEnv,
    repo,
    operation: `the ${action} dispatch`,
    detail,
  });
  if (shared !== null) return fail(shared);

  switch (response.status) {
    case 404:
      return fail(
        `GitHub could not find ${workflowFile} on ${repo} (404): the workflow must exist on the ${ref} branch.`,
      );
    default:
      return fail(
        `GitHub returned HTTP ${response.status} for the ${action} dispatch.`,
      );
  }
}

/**
 * The browser-check workflow — real Chrome clicking the shared target list.
 *
 * A second workflow, not a second dispatcher: everything that must behave the
 * same as a burst (the token read, the manual fallback, the headers, the
 * timeout, the status sentences, the redaction) is the generic function above.
 * This section only names what is specific to a browser check, so the burst
 * path is untouched by it.
 */

export const BROWSER_CHECK_REPO = "cipherlogs/voni";
export const BROWSER_CHECK_WORKFLOW_FILE = "browser-check.yml";

/**
 * One token dispatches both workflows. A dispatch is a dispatch; a second
 * repository secret would be a second thing to rotate for no extra scope.
 */
export const BROWSER_CHECK_TOKEN_ENV = "GITHUB_BURST_TOKEN";

/** A dispatch answers 204 with no body, so the workflow page is the destination. */
export const BROWSER_CHECK_RUN_URL = workflowRunUrl(
  BROWSER_CHECK_REPO,
  BROWSER_CHECK_WORKFLOW_FILE,
);

/**
 * The workflow's input names, in one place. The wiring test imports this and
 * compares it with the names `browser-check.yml` declares, so a rename on
 * either side fails at review time instead of at 3am when a dispatch 422s.
 */
export const BROWSER_CHECK_INPUTS = {
  os: "os",
  targets: "targets",
  interval: "interval",
  window: "window",
  selection: "selection",
  poolTarget: "poolTarget",
} as const;

/** The interval the schedule domain's floor and ceiling allow. */
export const BROWSER_CHECK_MIN_INTERVAL_SECONDS = 15;
export const BROWSER_CHECK_MAX_INTERVAL_SECONDS = 3_600;

/**
 * GitHub cancels a job at six hours, so a window is realised as chained
 * segments. `MAX_JOB_SECONDS` is the one ceiling (20 000 s, ~5.6 h) the
 * scheduler plans with; the workflow's `timeout-minutes` has to stay above it.
 * No second cap lives here.
 */

export type BrowserCheckInput = {
  /** Which runner clicks: `ubuntu`, `windows` or `macos`. */
  os: RunnerOs;
  /** The shared target list, unstamped; the runner stamps each click itself. */
  targets: readonly string[];
  /** Seconds between passes. */
  intervalSeconds: number;
  /** How long this segment runs, in seconds. */
  windowSeconds: number;
  /**
   * The page's rotation mode — the same value Grafana's script runs. Carried,
   * never decided here: a default in the dispatcher would be a second source of
   * truth, and the two Sources could then disagree.
   */
  selection: TargetSelection;
};

/** What a human runs when no dispatch token is configured. */
export function browserCheckCommand(input: BrowserCheckInput, poolTarget: number): string {
  return (
    `gh workflow run ${BROWSER_CHECK_WORKFLOW_FILE} --ref main ` +
    `-f ${BROWSER_CHECK_INPUTS.os}=${input.os} ` +
    `-f ${BROWSER_CHECK_INPUTS.interval}=${input.intervalSeconds} ` +
    `-f ${BROWSER_CHECK_INPUTS.window}=${input.windowSeconds} ` +
    `-f ${BROWSER_CHECK_INPUTS.selection}=${input.selection} ` +
    `-f ${BROWSER_CHECK_INPUTS.poolTarget}=${poolTarget} ` +
    `-f ${BROWSER_CHECK_INPUTS.targets}='${JSON.stringify(input.targets)}'`
  );
}

export type BrowserCheckDeps = {
  /** Injecting `fetch` keeps the tests off the network. */
  fetcher?: typeof fetch;
  /** Injecting the reader keeps the tests off the environment and the Worker context. */
  readSecret?: (name: string) => Promise<string | undefined>;
  /**
   * The console's saved pool target. Injected so a test can name it without a
   * database; production reads the same row the Proxy exits card writes.
   */
  readPoolTarget?: () => Promise<number>;
};

/** A refusal is a sentence, never a throw: the card renders it verbatim. */
function refuse(reason: string): DispatchOutcome {
  return { ok: false, error: `The browser check was not dispatched: ${reason}` };
}

/**
 * Restart's first half: cancel one OS's running Segment and prove it stopped.
 *
 * A dispatch answers 204 with no body, so nothing in a dispatch names the run
 * it started. The run is found the same way a reader finds it on the workflow
 * page: by the run name the workflow sets per OS (`browserCheckRunName`) and
 * by a status that is not terminal. Both queued and in-progress runs count —
 * cancelling only the one that is clicking would let a queued sibling start
 * the moment it finishes, which is exactly the second Segment a Restart must
 * prevent.
 *
 * A cancel request is not a cancellation. GitHub answers 202 and the run sits
 * in `cancelling` (or ignores the request entirely until a runner checks in),
 * so this waits, reads, and only reports success when every run it asked to
 * stop is terminal. The wait is bounded; on the bound the caller is told what
 * is still running and must not dispatch.
 */
export function browserCheckRunName(os: RunnerOs): string {
  return `Browser check (${os})`;
}

/** One cancel or run read is a small request; it gets the dispatch's ceiling. */
export const CANCEL_TIMEOUT_MS = 10_000;

/**
 * How long a Restart waits for GitHub to report the cancelled run completed.
 * Longer than a cancel needs, short enough that the operator's form does not
 * hang indefinitely: past it, the answer is "not observed", not a dispatch.
 */
export const CANCEL_WAIT_TIMEOUT_MS = 60_000;

/** How often the wait re-reads a run while it is still active. */
export const CANCEL_POLL_INTERVAL_MS = 2_000;

/** The newest runs are the active ones; one page is more than an OS can hold. */
const RUNS_PER_PAGE = 100;

/**
 * A status outside this set may still be clicking. GitHub reports `completed`
 * on the run resource and keeps the outcome in `conclusion`, but the older
 * status words are accepted as terminal too so a representation change cannot
 * make a finished run look like a live one — or a live one look finished.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "success",
  "failure",
  "timed_out",
  "skipped",
  "neutral",
  "stale",
  "action_required",
]);

export type CancelDeps = {
  /** Injecting `fetch` keeps the tests off the network. */
  fetcher?: typeof fetch;
  /** Injecting the reader keeps the tests off the environment and the Worker context. */
  readSecret?: (name: string) => Promise<string | undefined>;
  /** Injected so a test never waits on a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The bound on observing the stop; defaults to `CANCEL_WAIT_TIMEOUT_MS`. */
  waitTimeoutMs?: number;
  /** The re-read interval; defaults to `CANCEL_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
};

/**
 * `cancelled: false` means nothing was running and nothing was waited for.
 * Every failure names the cancel step; `stillRunning` is empty only when the
 * client could not even find out what was running.
 */
export type CancelOutcome =
  | { ok: true; cancelled: false; runIds: [] }
  | { ok: true; cancelled: true; runIds: number[] }
  | { ok: false; step: "cancel"; error: string; stillRunning: number[] };

type GithubRun = {
  id?: unknown;
  status?: unknown;
  display_title?: unknown;
};

export async function cancelBrowserCheckRuns(
  os: RunnerOs,
  deps: CancelDeps = {},
): Promise<CancelOutcome> {
  const readSecret = deps.readSecret ?? secret;
  const token = await readSecret(BROWSER_CHECK_TOKEN_ENV);
  if (!token) {
    // The same token dispatches and cancels. Without it GitHub cannot be asked
    // to stop anything, so a Restart refuses rather than stacking a run on top
    // of one it cannot see.
    return {
      ok: false,
      step: "cancel",
      error: `A running ${os} browser check cannot be cancelled without ${BROWSER_CHECK_TOKEN_ENV}, so no replacement was dispatched.`,
      stillRunning: [],
    };
  }

  const fetcher = deps.fetcher ?? fetch;
  const base = `https://api.github.com/repos/${BROWSER_CHECK_REPO}`;
  // The same headers the dispatch sends: a cancel is a GitHub call too.
  const headers = githubHeaders(token, "voni-restart");

  const fail = (sentence: string, stillRunning: number[] = []): CancelOutcome => ({
    ok: false,
    step: "cancel",
    error: redact(sentence, token),
    stillRunning,
  });

  let listed: Response;
  try {
    listed = await fetcher(
      `${base}/actions/workflows/${BROWSER_CHECK_WORKFLOW_FILE}/runs?per_page=${RUNS_PER_PAGE}`,
      {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
        cache: "no-store",
      },
    );
  } catch (error) {
    return fail(
      `Could not reach GitHub to find the running ${os} browser check: ${messageOf(error)}`,
    );
  }

  if (!listed.ok) {
    const detail = await githubMessage(listed);
    const shared = githubRefusal(listed.status, {
      tokenEnv: BROWSER_CHECK_TOKEN_ENV,
      repo: BROWSER_CHECK_REPO,
      operation: `the ${os} browser check cancel`,
      detail,
    });
    if (shared !== null) return fail(shared);
    switch (listed.status) {
      case 404:
        return fail(
          `GitHub could not find ${BROWSER_CHECK_WORKFLOW_FILE} on ${BROWSER_CHECK_REPO} (404), so a running ${os} browser check cannot be found.${detail}`,
        );
      default:
        return fail(
          `GitHub returned HTTP ${listed.status} while looking for the running ${os} browser check, so no replacement was dispatched.${detail}`,
        );
    }
  }

  const payload = (await listed.json().catch(() => null)) as
    | { workflow_runs?: unknown }
    | null;
  if (!payload || !Array.isArray(payload.workflow_runs)) {
    return fail(
      `GitHub's run list could not be read, so no replacement was dispatched.`,
    );
  }

  const title = browserCheckRunName(os);
  const active: number[] = [];
  for (const entry of payload.workflow_runs) {
    if (!entry || typeof entry !== "object") {
      return fail(
        `GitHub's run list could not be read, so no replacement was dispatched.`,
      );
    }
    const run = entry as GithubRun;
    if (typeof run.id !== "number" || typeof run.status !== "string") {
      return fail(
        `GitHub's run list could not be read, so no replacement was dispatched.`,
      );
    }
    if (run.display_title !== title) continue;
    if (!TERMINAL_RUN_STATUSES.has(run.status)) active.push(run.id);
  }

  if (active.length === 0) {
    return { ok: true, cancelled: false, runIds: [] };
  }

  for (const [index, runId] of active.entries()) {
    let response: Response;
    try {
      response = await fetcher(`${base}/actions/runs/${runId}/cancel`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      return fail(
        `Could not reach GitHub to cancel the ${os} browser check: ${messageOf(error)}`,
        active.slice(index),
      );
    }

    if (response.ok) continue;

    // 404 (gone) and 409 (not in a cancellable state) are not failures: the
    // wait below is the only proof that matters, and it reads the run either
    // way. Every other status means the cancel was refused, which a wait
    // cannot repair.
    if (response.status === 404 || response.status === 409) continue;

    const detail = await githubMessage(response);
    const shared = githubRefusal(response.status, {
      tokenEnv: BROWSER_CHECK_TOKEN_ENV,
      repo: BROWSER_CHECK_REPO,
      operation: `the ${os} browser check cancel`,
      detail,
    });
    if (shared !== null) return fail(shared, active.slice(index));
    return fail(
      `GitHub returned HTTP ${response.status} when asked to cancel the ${os} browser check.${detail}`,
      active.slice(index),
    );
  }

  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = Math.max(1, deps.pollIntervalMs ?? CANCEL_POLL_INTERVAL_MS);
  const waitTimeoutMs = deps.waitTimeoutMs ?? CANCEL_WAIT_TIMEOUT_MS;
  const attempts = Math.max(1, Math.ceil(waitTimeoutMs / pollIntervalMs));

  let stillRunning: number[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    stillRunning = [];
    for (const runId of active) {
      let stopped = false;
      try {
        const response = await fetcher(`${base}/actions/runs/${runId}`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
          cache: "no-store",
        });
        if (response.status === 404) {
          stopped = true;
        } else if (response.ok) {
          const run = (await response.json().catch(() => null)) as GithubRun | null;
          stopped =
            typeof run?.status === "string" &&
            TERMINAL_RUN_STATUSES.has(run.status);
        }
      } catch {
        // A transient read failure is "not observed yet": the bound decides.
      }
      if (!stopped) stillRunning.push(runId);
    }

    if (stillRunning.length === 0) {
      return { ok: true, cancelled: true, runIds: active };
    }
    if (attempt < attempts - 1) await sleep(pollIntervalMs);
  }

  return fail(
    `The ${os} browser check did not stop within ${Math.round(waitTimeoutMs / 1_000)} seconds of the cancel request, so no replacement was dispatched. Runs still active: ${stillRunning.join(", ")}.`,
    stillRunning,
  );
}


export async function dispatchBrowserCheck(
  input: BrowserCheckInput,
  deps: BrowserCheckDeps = {},
): Promise<DispatchOutcome> {
  if (!(RUNNER_OS_VALUES as readonly string[]).includes(input.os)) {
    return refuse(
      `${JSON.stringify(input.os)} is not one of ${RUNNER_OS_VALUES.join(", ")}.`,
    );
  }

  if (input.targets.length === 0) {
    return refuse("there is no active target to click.");
  }
  for (const entry of input.targets) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return refuse(`${entry} is not an absolute URL.`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return refuse(`${entry} is not an http(s) URL.`);
    }
  }

  // One of two names, checked as strictly as the OS: a run dispatched with an
  // unknown mode would click a whole segment in something nobody chose.
  if (parseTargetSelection(input.selection) === null) {
    return refuse(
      `${JSON.stringify(input.selection)} is not one of random, rotate.`,
    );
  }

  if (
    !Number.isInteger(input.intervalSeconds) ||
    input.intervalSeconds < BROWSER_CHECK_MIN_INTERVAL_SECONDS ||
    input.intervalSeconds > BROWSER_CHECK_MAX_INTERVAL_SECONDS
  ) {
    return refuse(
      `the interval must be a whole number of seconds from ` +
        `${BROWSER_CHECK_MIN_INTERVAL_SECONDS} to ${BROWSER_CHECK_MAX_INTERVAL_SECONDS}.`,
    );
  }

  if (
    !Number.isInteger(input.windowSeconds) ||
    input.windowSeconds < 1 ||
    input.windowSeconds > MAX_JOB_SECONDS
  ) {
    return refuse(
      `the window must be a whole number of seconds from 1 to ` +
        `${MAX_JOB_SECONDS} (one segment).`,
    );
  }

  // The console's saved size, carried to the client. A read that fails, or a
  // hand-edited row the policy cannot read as a size, is a refusal: a dispatch
  // is not the place to invent a pool nobody chose.
  const readPoolTarget =
    deps.readPoolTarget ?? (async () => (await readProxySettings()).poolTarget);
  let poolTarget: number;
  try {
    poolTarget = await readPoolTarget();
  } catch (error) {
    return refuse(
      `the saved pool target could not be read: ${messageOf(error)}`,
    );
  }
  if (parseProxyPoolTarget(poolTarget) === null) {
    return refuse(
      `the saved pool target must be a whole number from ${PROXY_POOL_MIN} to ` +
        `${PROXY_POOL_MAX}, got ${JSON.stringify(poolTarget)}.`,
    );
  }

  return dispatchWorkflow({
    repo: BROWSER_CHECK_REPO,
    workflowFile: BROWSER_CHECK_WORKFLOW_FILE,
    tokenEnv: BROWSER_CHECK_TOKEN_ENV,
    action: "browser check",
    manualCommand: browserCheckCommand(input, poolTarget),
    fetcher: deps.fetcher,
    readSecret: deps.readSecret,
    inputs: {
      [BROWSER_CHECK_INPUTS.os]: input.os,
      [BROWSER_CHECK_INPUTS.targets]: JSON.stringify(input.targets),
      [BROWSER_CHECK_INPUTS.interval]: String(input.intervalSeconds),
      [BROWSER_CHECK_INPUTS.window]: String(input.windowSeconds),
      [BROWSER_CHECK_INPUTS.selection]: input.selection,
      [BROWSER_CHECK_INPUTS.poolTarget]: String(poolTarget),
    },
  });
}
