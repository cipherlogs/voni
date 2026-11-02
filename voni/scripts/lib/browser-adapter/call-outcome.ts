/**
 * What a browser call's end document says about whether the call ever existed.
 *
 * The harness reports a caller trigger that never resolved as
 * `trigger-unresolved`, which reads like a measured failure: the agent was
 * asked something and did not answer. That is right when the call opened and
 * the agent stayed silent — but it is wrong when the call died during the
 * opening handshake, before any vendor leg opened: nothing was spoken, nothing
 * was billed, and nothing was measured. A call in that state is re-made once
 * under the owner's no-evidence amendment, never judged as a result.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CallOutcome =
  | {
      /** No vendor leg opened: the call measured nothing at all. */
      readonly kind: "no-session";
      readonly detail: string;
    }
  | {
      /** The call ran and has a result to judge. */
      readonly kind: "measured";
      readonly detail: string;
    }
  | {
      /** The end document is absent or unreadable; the default reading stands. */
      readonly kind: "unknown";
      readonly detail: string;
    };

/** The end document the harness wrote, or the one the pipeline would have. */
export function endDocumentPath(input: {
  readonly endPath: string | null;
  readonly eventsDir: string;
  readonly callId: string | null;
}): string | null {
  if (input.endPath !== null) return input.endPath;
  if (input.callId === null) return null;
  const stem =
    input.callId.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "call";
  return join(input.eventsDir, `${stem}.end.json`);
}

type ProviderRecord = { readonly provider?: unknown } | null;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A call ended during the opening handshake and no leg ever opened.
 *
 * Both conditions are required: an `open` stage error with a leg recorded as
 * opened is a real call that failed on its first exchange, and it is judged.
 */
export function readCallOutcome(input: {
  readonly endPath: string | null;
  readonly eventsDir: string;
  readonly callId: string | null;
}): CallOutcome {
  const path = endDocumentPath(input);
  if (path === null) {
    return { kind: "unknown", detail: "the call has no call id, so no end document exists" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      kind: "unknown",
      detail: `the end document at ${path} is unreadable (${(error as Error).message})`,
    };
  }
  const doc = record(parsed);
  if (doc === null) {
    return { kind: "unknown", detail: `the end document at ${path} is not an object` };
  }

  const endedBy = typeof doc.endedBy === "string" ? doc.endedBy : null;
  const error = record(doc.error);
  const stage = error !== null && typeof error.stage === "string" ? error.stage : null;
  const message =
    error !== null && typeof error.message === "string" ? error.message : "no error recorded";

  const providers = record(doc.providers);
  const legs = providers === null ? [] : Object.values(providers);
  const opened = legs.filter((leg): leg is ProviderRecord => {
    const entry = record(leg);
    return entry !== null && entry.provider !== null && entry.provider !== undefined;
  });

  if (endedBy === "error" && stage === "open" && opened.length === 0) {
    return {
      kind: "no-session",
      detail:
        `the call ended during the opening handshake (${message}) and no vendor leg opened, ` +
        "so no turn was spoken and no leg was billed",
    };
  }

  return {
    kind: "measured",
    detail:
      endedBy === "error"
        ? `the call ended with an error at stage ${JSON.stringify(stage)} (${message}) ` +
          `after ${opened.length} leg(s) opened`
        : `the call ended by ${JSON.stringify(endedBy)}`,
  };
}
