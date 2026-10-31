/**
 * Reads and writes the demo tool log (`demo_tool_calls`).
 *
 * The write is idempotent on `(call_id, tool_call_id)`: the model's id is the
 * route's own idempotency key, so a replayed call increments `attempts` and
 * writes no second side-effect row. The reader returns the redacted shape the
 * X evaluators consume and refuses a malformed row rather than guessing.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Tools and email" X1–X10.
 */

import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { demoCalls, demoTestTags, demoToolCalls } from "@/lib/db/schema";
import {
  toolLogEntry,
  toolLogRowFromStored,
  type ToolLogRow,
} from "./tool-log";

export type RecordDemoToolCallInput = {
  readonly callId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly credential: string;
  readonly result: unknown;
  readonly latencyMs: number;
};

/**
 * Record one model-requested call. A replay of the same tool id only raises
 * `attempts`; the first attempt's facts stay, because a retry is evidence of
 * a retry, never a second effect.
 */
export async function recordDemoToolCall(
  input: RecordDemoToolCallInput,
): Promise<void> {
  const entry = toolLogEntry(input);
  await db
    .insert(demoToolCalls)
    .values({
      callId: entry.callId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      credential: entry.credential,
      status: entry.status,
      returning: entry.returning,
      sent: entry.sent,
      ok: entry.ok,
      code: entry.code,
      latencyMs: entry.latencyMs,
    })
    .onConflictDoUpdate({
      target: [demoToolCalls.callId, demoToolCalls.toolCallId],
      set: { attempts: sql`${demoToolCalls.attempts} + 1` },
    });
}

/**
 * Write without letting a log failure change the tool's answer. The route calls
 * this one function; its own source stays free of credentials and logging,
 * which the route contract test pins.
 */
export async function recordDemoToolCallSafely(
  input: RecordDemoToolCallInput,
): Promise<void> {
  try {
    await recordDemoToolCall(input);
  } catch (error) {
    console.error(`[demo-tool-log] write failed for ${input.toolCallId}`, error);
  }
}

/** The Test tag a call minted, for the real inbox's by-tag re-read. */
export type DemoCallTag = {
  readonly tag: string;
  readonly issuedAt: Date;
  readonly matchedMessageId: string | null;
  readonly matchedThreadId: string | null;
};

export async function readDemoCallTag(callId: string): Promise<DemoCallTag | null> {
  const [row] = await db
    .select({
      tag: demoTestTags.tag,
      issuedAt: demoTestTags.issuedAt,
      matchedMessageId: demoTestTags.matchedMessageId,
      matchedThreadId: demoTestTags.matchedThreadId,
    })
    .from(demoCalls)
    .innerJoin(demoTestTags, eq(demoCalls.tagId, demoTestTags.id))
    .where(eq(demoCalls.callId, callId))
    .limit(1);
  if (row === undefined) return null;
  return {
    tag: row.tag,
    issuedAt: row.issuedAt,
    matchedMessageId: row.matchedMessageId,
    matchedThreadId: row.matchedThreadId,
  };
}

/** Every logged call for one demo call, in the order the route answered them. */
export async function readDemoToolLog(callId: string): Promise<ToolLogRow[]> {
  if (callId.trim() === "") return [];
  const rows = await db
    .select({
      toolCallId: demoToolCalls.toolCallId,
      toolName: demoToolCalls.toolName,
      status: demoToolCalls.status,
      returning: demoToolCalls.returning,
      sent: demoToolCalls.sent,
      ok: demoToolCalls.ok,
      code: demoToolCalls.code,
      latencyMs: demoToolCalls.latencyMs,
      attempts: demoToolCalls.attempts,
      createdAt: demoToolCalls.createdAt,
    })
    .from(demoToolCalls)
    .where(
      and(
        eq(demoToolCalls.callId, callId),
        // Only the pipeline's model-requested calls are evidence; a browser poll
        // of check_email is not a tool decision.
        eq(demoToolCalls.credential, "service"),
      ),
    )
    .orderBy(asc(demoToolCalls.createdAt), asc(demoToolCalls.toolCallId));
  return rows.map((row) => toolLogRowFromStored(row));
}
