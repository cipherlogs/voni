import { secret } from "@/lib/env";

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
