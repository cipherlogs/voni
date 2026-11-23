import { secret } from "@/lib/env";
import { RUNNER_OS_VALUES, type RunnerOs } from "@/lib/email/click-report";

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
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        // GitHub answers any request without a User-Agent with a 403 and a
        // plain-text body ("Request forbidden by administrative rules"), which
        // reads exactly like a permission refusal and cost a day of chasing a
        // token that was correct all along. undici's default UA does not count.
        "user-agent": dispatch.userAgent ?? `voni-${action}`,
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

  switch (response.status) {
    case 401:
      return fail(
        `GitHub rejected ${tokenEnv} (401): the token is unset, expired, or does not belong to an account that can see ${repo}.`,
      );
    case 403:
      return fail(
        `GitHub refused the ${action} dispatch (403): ${tokenEnv} needs Actions write access on ${repo}.`,
      );
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
} as const;

/** The interval the schedule domain's floor and ceiling allow. */
export const BROWSER_CHECK_MIN_INTERVAL_SECONDS = 15;
export const BROWSER_CHECK_MAX_INTERVAL_SECONDS = 3_600;

/**
 * GitHub cancels a job at six hours, so a window is realised as chained
 * segments. This is the ceiling one segment may ask for (348 minutes), and the
 * workflow's `timeout-minutes` has to stay above it.
 */
export const BROWSER_CHECK_MAX_WINDOW_SECONDS = 348 * 60;

export type BrowserCheckInput = {
  /** Which runner clicks: `ubuntu`, `windows` or `macos`. */
  os: RunnerOs;
  /** The shared target list, unstamped; the runner stamps each click itself. */
  targets: readonly string[];
  /** Seconds between passes. */
  intervalSeconds: number;
  /** How long this segment runs, in seconds. */
  windowSeconds: number;
};

/** What a human runs when no dispatch token is configured. */
export function browserCheckCommand(input: BrowserCheckInput): string {
  return (
    `gh workflow run ${BROWSER_CHECK_WORKFLOW_FILE} --ref main ` +
    `-f ${BROWSER_CHECK_INPUTS.os}=${input.os} ` +
    `-f ${BROWSER_CHECK_INPUTS.interval}=${input.intervalSeconds} ` +
    `-f ${BROWSER_CHECK_INPUTS.window}=${input.windowSeconds} ` +
    `-f ${BROWSER_CHECK_INPUTS.targets}='${JSON.stringify(input.targets)}'`
  );
}

export type BrowserCheckDeps = {
  /** Injecting `fetch` keeps the tests off the network. */
  fetcher?: typeof fetch;
  /** Injecting the reader keeps the tests off the environment and the Worker context. */
  readSecret?: (name: string) => Promise<string | undefined>;
};

/** A refusal is a sentence, never a throw: the card renders it verbatim. */
function refuse(reason: string): DispatchOutcome {
  return { ok: false, error: `The browser check was not dispatched: ${reason}` };
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
    input.windowSeconds > BROWSER_CHECK_MAX_WINDOW_SECONDS
  ) {
    return refuse(
      `the window must be a whole number of seconds from 1 to ` +
        `${BROWSER_CHECK_MAX_WINDOW_SECONDS} (one segment).`,
    );
  }

  return dispatchWorkflow({
    repo: BROWSER_CHECK_REPO,
    workflowFile: BROWSER_CHECK_WORKFLOW_FILE,
    tokenEnv: BROWSER_CHECK_TOKEN_ENV,
    action: "browser check",
    manualCommand: browserCheckCommand(input),
    fetcher: deps.fetcher,
    readSecret: deps.readSecret,
    inputs: {
      [BROWSER_CHECK_INPUTS.os]: input.os,
      [BROWSER_CHECK_INPUTS.targets]: JSON.stringify(input.targets),
      [BROWSER_CHECK_INPUTS.interval]: String(input.intervalSeconds),
      [BROWSER_CHECK_INPUTS.window]: String(input.windowSeconds),
    },
  });
}
