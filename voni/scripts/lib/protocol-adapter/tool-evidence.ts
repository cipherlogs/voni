/**
 * Collect the tool evidence the X properties read: the demo tool log and the
 * real test inbox's delivery record.
 *
 * The tool log is the app's own `demo_tool_calls` rows, written by the demo
 * tool route for the pipeline's model-requested calls. The delivery record is
 * the same Gmail inbox re-read by the call's Test tag after the call — never
 * the tool's own claim. Either one being unavailable is a named gap that makes
 * the property unmeasured; it is never a skip that reads green.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "No mocks on the golden path".
 */

import type { InboxDelivery } from "@/lib/demo/verification/tools/inbox";
import type { ToolLogRow } from "@/lib/demo/tool-log";

export type ToolEvidenceCollection = {
  readonly log: readonly ToolLogRow[];
  readonly delivery: InboxDelivery | null;
  readonly gap: string | null;
};

export type ToolEvidenceEnv = Readonly<Record<string, string | undefined>>;

export type ToolEvidenceDeps = {
  readonly readLog: (callId: string) => Promise<ToolLogRow[]>;
  readonly readTag: (callId: string) => Promise<{
    tag: string;
    issuedAt: Date;
    matchedMessageId: string | null;
    matchedThreadId: string | null;
  } | null>;
  readonly findTaggedMessage: (input: {
    tag: string;
    issuedAt: Date;
    env: ToolEvidenceEnv;
    deps: { fetch: typeof fetch };
  }) => Promise<
    | {
        found: true;
        messageId: string;
        threadId: string;
        senderKind: "work" | "personal";
        receivedAt: number;
      }
    | { found: false }
  >;
  readonly countThreadReplies: (input: {
    threadId: string;
    env: ToolEvidenceEnv;
    deps: { fetch: typeof fetch };
  }) => Promise<number>;
  readonly fetch?: typeof fetch;
};

function reasonOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    if (typeof code === "string") {
      return `${code}: ${typeof message === "string" ? message : "(no message)"}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Gather what the call's own evidence can still prove. Never throws: a failed
 * read becomes the gap the evaluator reports, so one missing sidecar cannot
 * stop the verdict.
 */
export async function collectToolEvidence(input: {
  readonly callId: string;
  readonly env: ToolEvidenceEnv;
  readonly deps: ToolEvidenceDeps;
}): Promise<ToolEvidenceCollection> {
  const gaps: string[] = [];

  if ((input.env.DATABASE_URL ?? "").trim() === "") {
    return {
      log: [],
      delivery: null,
      gap:
        "the app database is not configured (DATABASE_URL), so the demo tool log could not " +
        "be read; status, returning and send facts are unmeasured",
    };
  }

  let log: ToolLogRow[] = [];
  try {
    log = await input.deps.readLog(input.callId);
  } catch (error) {
    gaps.push(`the demo tool log could not be read: ${reasonOf(error)}`);
  }

  let delivery: InboxDelivery | null = null;
  try {
    const tag = await input.deps.readTag(input.callId);
    if (tag === null) {
      gaps.push(
        "the call minted no Test tag, so the real test inbox cannot identify its email; " +
          "the golden path is unverified",
      );
    } else {
      const inboxDeps = { fetch: input.deps.fetch ?? fetch };
      const found = await input.deps.findTaggedMessage({
        tag: tag.tag,
        issuedAt: tag.issuedAt,
        env: input.env,
        deps: inboxDeps,
      });
      if (!found.found) {
        gaps.push(
          `no message carrying tag "${tag.tag}" is in the test inbox since the call; the ` +
            "golden path's delivery is unverified",
        );
      } else {
        const repliesFromInbox = tag.matchedThreadId
          ? await input.deps.countThreadReplies({
              threadId: tag.matchedThreadId,
              env: input.env,
              deps: inboxDeps,
            })
          : 0;
        delivery = {
          verified: true,
          tag: tag.tag,
          messageId: found.messageId,
          threadId: found.threadId,
          senderKind: found.senderKind,
          repliesFromInbox,
        };
      }
    }
  } catch (error) {
    gaps.push(`the real test inbox could not be verified: ${reasonOf(error)}`);
  }

  return {
    log,
    delivery,
    gap: gaps.length === 0 ? null : gaps.join("; "),
  };
}
