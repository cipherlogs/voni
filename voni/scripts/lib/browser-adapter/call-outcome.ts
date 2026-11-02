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

  const turns = typeof doc.turns === "number" ? doc.turns : null;

  // A leg failing is never a Voni behaviour. If the call died while it was
  // still opening, or before a single turn was spoken, nothing was measured:
  // the greeting may not have existed, so no property could observe anything.
  // A call that spoke at least one turn and then lost a leg is a different
  // case: it ran, and it is judged.
  const nothingSpoken = stage === "open" || turns === 0;
  if (endedBy === "error" && nothingSpoken) {
    return {
      kind: "no-session",
      detail:
        `the call ended with an error at stage ${JSON.stringify(stage)} (${message}) ` +
        `before any turn was spoken (turns: ${turns === null ? "unknown" : turns}), ` +
        "so nothing was measured",
    };
  }

  return {
    kind: "measured",
    detail:
      endedBy === "error"
        ? `the call ended with an error at stage ${JSON.stringify(stage)} (${message}) ` +
          `after ${turns === null ? "an unknown number of" : turns} turn(s)`
        : `the call ended by ${JSON.stringify(endedBy)}`,
  };
}
