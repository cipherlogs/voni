/**
 * The reader for the tool log, the trace's turn rows and the captions.
 *
 * Each X evaluator is handed one source by the contract, but several need a
 * second to make a claim honest: a tool decision is timed from the caller's
 * final in the trace, a bridge is a spoken caption after a slow log row, and a
 * continuation is a caption after the result. This module normalises those
 * shapes once and refuses a malformed row by name, so no evaluator invents a
 * missing field.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Tools and email" X1–X10.
 */

import {
  ToolLogError,
  normalizeToolLogRow,
  type ToolLogRow,
} from "@/lib/demo/tool-log";
import type { InboxDelivery } from "./inbox";

export type EvidenceRow = Record<string, unknown>;

export type Caption = {
  readonly role: "caller" | "agent";
  readonly text: string;
  readonly atMs: number;
  readonly turn: string | null;
  readonly final: boolean;
};

export type ToolCallRow = {
  readonly turn: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly atMs: number;
  readonly index: number | null;
};

export type ToolResultRow = {
  readonly turn: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly atMs: number;
  readonly ok: boolean;
  readonly code: string | null;
};

export type ToolEvidenceFacts = {
  readonly log: readonly ToolLogRow[];
  readonly delivery: InboxDelivery | null;
  /** Why the log or delivery is absent, named for the failure reason. */
  readonly gap: string | null;
};

export type TraceFacts = {
  readonly rows: readonly EvidenceRow[];
  readonly captions: readonly Caption[] | null;
  readonly captionGap: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown, what: string): EvidenceRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as EvidenceRow;
}

function array(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`);
  return value;
}

function atMsOf(row: EvidenceRow, what: string): number {
  const value = row.atMs;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what} carries no finite atMs`);
  }
  return value;
}

/** The trace's rows and, when the adapter captured them, the call's captions. */
export function readTrace(source: unknown): TraceFacts {
  const trace = record(source, "the trace evidence");
  const rows = array(trace.rows, "the trace rows").map((row, index) =>
    record(row, `trace row ${index}`),
  );
  const rawTranscript = trace.transcript;
  if (rawTranscript === null || rawTranscript === undefined) {
    return {
      rows,
      captions: null,
      captionGap:
        "the trace carries no transcript; the call's spoken words were not captured, so a " +
        "spoken bridge, continuation or leak cannot be judged",
    };
  }
  const captions = array(rawTranscript, "the trace transcript").map((raw, index) => {
    const caption = record(raw, `transcript entry ${index}`);
    const role = caption.role;
    if (role !== "caller" && role !== "agent") {
      throw new Error(`transcript entry ${index} names unknown role "${String(role)}"`);
    }
    const words = text(caption.text);
    if (words === "") throw new Error(`transcript entry ${index} has no text`);
    return {
      role,
      text: words,
      atMs: atMsOf(caption, `transcript entry ${index}`),
      turn: text(caption.turn) === "" ? null : text(caption.turn),
      final: caption.final === true,
    } satisfies Caption;
  });
  return { rows, captions, captionGap: null };
}

/** The turn rows a ledger carries, in the same shape the trace uses. */
export function readLedgerTurns(source: unknown): readonly EvidenceRow[] {
  const ledger = record(source, "the ledger evidence");
  if (!Array.isArray(ledger.turns)) {
    throw new Error("the ledger carries no turn rows");
  }
  return ledger.turns.map((row, index) => record(row, `ledger turn ${index}`));
}

/** Every requested tool call in the rows, in the ledger's own order. */
export function toolCalls(rows: readonly EvidenceRow[]): ToolCallRow[] {
  return rows
    .filter((row) => row.type === "turn.tool_call")
    .map((row, index) => {
      const callId = text(row.toolCallId);
      const name = text(row.name);
      const turn = text(row.turn);
      if (callId === "" || name === "" || turn === "") {
        throw new Error(`tool call row ${index} carries no toolCallId, name or turn`);
      }
      const rawIndex = row.index;
      return {
        turn,
        toolCallId: callId,
        name,
        atMs: atMsOf(row, `tool call ${callId}`),
        index:
          typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0
            ? rawIndex
            : null,
      };
    });
}

/** Every answered tool call in the rows, in the ledger's own order. */
export function toolResults(rows: readonly EvidenceRow[]): ToolResultRow[] {
  return rows
    .filter((row) => row.type === "turn.tool_result")
    .map((row, index) => {
      const callId = text(row.toolCallId);
      const name = text(row.name);
      const turn = text(row.turn);
      if (callId === "" || name === "" || turn === "") {
        throw new Error(`tool result row ${index} carries no toolCallId, name or turn`);
      }
      return {
        turn,
        toolCallId: callId,
        name,
        atMs: atMsOf(row, `tool result ${callId}`),
        ok: row.ok === true,
        code: text(row.code) === "" ? null : text(row.code),
      };
    });
}

/** The caller's final row that ended the turn a tool was requested in. */
export function turnEndBefore(
  rows: readonly EvidenceRow[],
  call: ToolCallRow,
): number | null {
  let end: number | null = null;
  for (const row of rows) {
    if (row.type !== "turn.user_final" || text(row.turn) !== call.turn) continue;
    const at = atMsOf(row, `user final in ${call.turn}`);
    if (at <= call.atMs && (end === null || at > end)) end = at;
  }
  return end;
}

/** The first agent caption at or after an instant, in call time. */
export function firstAgentCaptionAfter(
  captions: readonly Caption[] | null,
  atMs: number,
): Caption | null {
  if (captions === null) return null;
  return (
    captions
      .filter((caption) => caption.role === "agent" && caption.atMs >= atMs)
      .sort((left, right) => left.atMs - right.atMs)[0] ?? null
  );
}

/** The first agent caption after a result and before the next caller turn. */
export function continuationAfter(
  captions: readonly Caption[] | null,
  result: ToolResultRow,
): Caption | null {
  if (captions === null) return null;
  const nextCaller = captions
    .filter((caption) => caption.role === "caller" && caption.atMs > result.atMs)
    .sort((left, right) => left.atMs - right.atMs)[0];
  return (
    captions
      .filter(
        (caption) =>
          caption.role === "agent" &&
          caption.atMs >= result.atMs &&
          (nextCaller === undefined || caption.atMs < nextCaller.atMs),
      )
      .sort((left, right) => left.atMs - right.atMs)[0] ?? null
  );
}

/**
 * The tool log and the inbox delivery, or the named reason one is missing.
 * The adapter's trace-only `{ calls, results }` shape is accepted as a log
 * without facts; the X properties that need a status fail closed on it rather
 * than inventing one.
 */
export function readToolEvidence(source: unknown): ToolEvidenceFacts {
  const tool = record(source, "the tool evidence");
  const gapParts: string[] = [];

  let log: ToolLogRow[] = [];
  const rawLog = tool.log;
  if (Array.isArray(rawLog)) {
    try {
      log = rawLog.map((row) => normalizeToolLogRow(row));
    } catch (error) {
      throw new Error(
        error instanceof ToolLogError ? `${error.code}: ${error.message}` : String(error),
      );
    }
  } else {
    gapParts.push(
      "the tool evidence carries no demo tool log; only the trace's call/result rows are " +
        "present, so status, returning and send facts are unmeasured",
    );
  }

  let delivery: InboxDelivery | null = null;
  const rawDelivery = tool.delivery;
  if (rawDelivery !== undefined && rawDelivery !== null) {
    const entry = record(rawDelivery, "the inbox delivery record");
    if (
      entry.verified !== true ||
      text(entry.tag) === "" ||
      text(entry.messageId) === "" ||
      text(entry.threadId) === ""
    ) {
      throw new Error(
        "the inbox delivery record is incomplete; a delivery needs verified, tag, messageId and threadId",
      );
    }
    const senderKind = entry.senderKind;
    if (senderKind !== "work" && senderKind !== "personal") {
      throw new Error('the inbox delivery record does not name the sender kind ("work" or "personal")');
    }
    delivery = {
      verified: true,
      tag: text(entry.tag),
      messageId: text(entry.messageId),
      threadId: text(entry.threadId),
      senderKind,
      repliesFromInbox:
        typeof entry.repliesFromInbox === "number" && entry.repliesFromInbox >= 0
          ? entry.repliesFromInbox
          : 0,
    };
  } else {
    gapParts.push(
      "the tool evidence carries no inbox delivery record; the golden path's email was not " +
        "re-read from the real test inbox",
    );
  }

  return {
    log,
    delivery,
    gap: gapParts.length === 0 ? null : gapParts.join("; "),
  };
}

/** Caller-supplied values the runner knows a tool result carried, for X9. */
export function sensitiveValues(source: unknown): readonly string[] {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return [];
  const raw = (source as Record<string, unknown>).sensitiveValues;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string" && value.trim().length >= 4)
    .map((value) => value.trim());
}
