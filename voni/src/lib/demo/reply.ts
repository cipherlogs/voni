import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { demoCalls } from "@/lib/db/schema";
import type { ToolResponse } from "@/lib/tools/execute";
import { demoCallKey, type DemoCall } from "./call-token";
import { codeOutcome, replyCode, spokenCode } from "./code-check";
import { nameFromAddress } from "./email-test";
import { sendThreadedReply } from "./inbox";
import { loadLiveTestTag } from "./test-tag-registry";
import { codeCheckInstructions, REPLY_ALREADY_SENT_INSTRUCTIONS, replySentInstructions } from "./voni-agent";
import { loadWebsite } from "./website-read";

/**
 * Server half of the code check (ticket 04): Voni's reply goes out from the
 * test inbox, threaded to the visitor's email, once per call; the code the
 * visitor reads back is checked here, two tries, single-use.
 */

/** A send that never finished (the Worker died mid-request) frees the claim after this; Gmail calls time out well before. */
const STALE_SEND_S = 60;

/** Called at token mint: the call's language, for the reply. A rejoin keeps its first row. */
export async function recordDemoCall(callId: string, tagId: string | null, language: string): Promise<void> {
  await db.insert(demoCalls).values({ callId, tagId, language }).onConflictDoNothing();
}

const sendArgs = z.object({
  warm_line: z.string().max(500).optional().default(""),
  name: z.string().max(80).optional(),
});

export async function runSendReply(call: DemoCall, rawArguments: unknown): Promise<ToolResponse> {
  const args = sendArgs.safeParse(rawArguments);
  if (!args.success) return { ok: false, error: "Send again with one short warm line.", retryable: true };
  const key = await demoCallKey();
  const tag = call.tagId ? await loadLiveTestTag(call.tagId) : null;
  if (!key || !tag?.matchedMessageId || !tag.matchedFrom) {
    return { ok: false, error: "Their email hasn't been found yet: nothing to reply to.", retryable: false };
  }
  // A call minted before this table existed has no row yet.
  await recordDemoCall(call.callId, tag.id, tag.language);
  const [claimed] = await db
    .update(demoCalls)
    .set({ replyStartedAt: new Date() })
    .where(
      and(
        eq(demoCalls.callId, call.callId),
        isNull(demoCalls.replyMessageId),
        or(isNull(demoCalls.replyStartedAt), lt(demoCalls.replyStartedAt, new Date(Date.now() - STALE_SEND_S * 1000))),
      ),
    )
    .returning({ language: demoCalls.language });
  if (!claimed) {
    const [row] = await db.select({ sent: demoCalls.replyMessageId }).from(demoCalls).where(eq(demoCalls.callId, call.callId));
    return row?.sent
      ? { ok: true, data: { sent: true, instructions: REPLY_ALREADY_SENT_INSTRUCTIONS } }
      : { ok: false, error: "The reply is still sending.", retryable: true };
  }
  let messageId: string;
  try {
    messageId = await sendThreadedReply({
      inReplyTo: tag.matchedMessageId,
      threadId: tag.matchedThreadId,
      to: tag.matchedFrom,
      language: claimed.language,
      name: args.data.name ?? nameFromAddress(tag.matchedFrom),
      code: replyCode(key, call.callId),
      warmLine: args.data.warm_line,
    });
  } catch (e) {
    // Only an unsent reply frees the claim: a retry must never send twice.
    console.error(`[demo-reply] send failed: ${e}`);
    await db.update(demoCalls).set({ replyStartedAt: null }).where(eq(demoCalls.callId, call.callId)).catch(() => {});
    return { ok: false, error: "The reply didn't go out. Say so lightly and try once more.", retryable: true };
  }
  // Sent: the claim stays even if this write fails (the code check then says
  // "not sent", which beats a second email).
  await db
    .update(demoCalls)
    .set({ replyMessageId: messageId })
    .where(eq(demoCalls.callId, call.callId))
    .catch((e: unknown) => console.error(`[demo-reply] sent, but not recorded: ${e}`));
  // The site read started when their email was found (ticket 05): usually done by now.
  const site = await loadWebsite(call.callId, tag.matchedFrom).catch(() => null);
  return { ok: true, data: { sent: true, website: site?.status ?? "none", instructions: replySentInstructions(site) } };
}

const checkArgs = z.object({ code: z.string().max(40) });

export async function runCheckCode(call: DemoCall, rawArguments: unknown): Promise<ToolResponse> {
  const args = checkArgs.safeParse(rawArguments);
  if (!args.success) return { ok: false, error: "Check again with the digits the caller read.", retryable: true };
  const key = await demoCallKey();
  if (!key) return { ok: false, error: "The code check is unavailable.", retryable: false };
  const [row] = await db.select().from(demoCalls).where(eq(demoCalls.callId, call.callId));
  const outcome = codeOutcome(row ?? null, spokenCode(args.data.code), replyCode(key, call.callId));
  if (outcome.status === "correct" || outcome.status === "wrong") {
    // Only against the attempt count we judged: a racing check can't spend a try twice.
    const [counted] = await db
      .update(demoCalls)
      .set({
        codeAttempts: row.codeAttempts + 1,
        ...(outcome.status === "correct" ? { codeVerifiedAt: new Date() } : {}),
      })
      .where(and(eq(demoCalls.callId, call.callId), eq(demoCalls.codeAttempts, row.codeAttempts), isNull(demoCalls.codeVerifiedAt)))
      .returning({ callId: demoCalls.callId });
    if (!counted) return { ok: false, error: "Check the code again.", retryable: true };
  }
  return {
    ok: true,
    data: { status: outcome.status, triesLeft: outcome.triesLeft, instructions: codeCheckInstructions(outcome) },
  };
}
