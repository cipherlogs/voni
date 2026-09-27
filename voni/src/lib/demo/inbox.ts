import { z } from "zod";
import { secret } from "@/lib/env";
import type { ToolResponse } from "@/lib/tools/execute";
import { jevEvaluate, judgeDepsFromSecrets, type JevDeps } from "@/lib/voice/voice-judge";
import { replyEmail } from "./code-check";
import { bumpRateBucket } from "./rate-limit";
import {
  checkEmail,
  checkResultToData,
  checkTag,
  INBOX_LOOKBACK_S,
  normalizeClaim,
  type CheckEmailResult,
  type InboxMessage,
} from "./email-test";
import type { DemoCall } from "./call-token";
import { loadLiveTestTag, recordTagMatch } from "./test-tag-registry";
import { checkEmailInstructions } from "./voni-agent";

/**
 * Server half of the demo email test: reads the shared test inbox through the
 * Gmail REST API (plain fetch, Worker-safe) and asks Jev which email is the
 * caller's. The inbox's OAuth refresh token is `DEMO_INBOX_REFRESH_TOKEN`,
 * minted once for the inbox account against the app's Google OAuth client
 * (`scripts/mint-demo-inbox-token.mts`).
 */

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Newest first; the shared inbox is busy on purpose, but a call only needs the last few minutes. */
// ponytail: one page; a busier inbox than this per call window needs paging (nextPageToken).
const INBOX_PAGE = 30;
/** The model re-checks on corrections, the client polls every ~8s after a claim: this fits a whole call. */
const CHECKS_PER_CALL = 120;
/** The check budget's window: one call's wall cap, with margin. */
const CHECK_BUDGET_WINDOW_S = 15 * 60;
/** A false spoof flag costs a real Prospect, so it takes a confident Jev. */
const SPOOF_THRESHOLD = 0.75;
/** Under reply.ts's stale-claim window, so a hung send can't be claimed twice. */
const GMAIL_TIMEOUT_MS = 15_000;

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    secret("GOOGLE_CLIENT_ID"),
    secret("GOOGLE_CLIENT_SECRET"),
    secret("DEMO_INBOX_REFRESH_TOKEN"),
  ]);
  if (!clientId || !clientSecret || !refreshToken) throw new Error("demo inbox not configured");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

type GmailMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
};

/** `"Andres Garcia" <Andres@CasaVerde.pt>` → name + lowercased address. */
export function parseFromHeader(value: string): { from: string; fromName: string } {
  const angled = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (angled) return { from: angled[2].trim().toLowerCase(), fromName: angled[1].trim() };
  return { from: value.trim().toLowerCase(), fromName: "" };
}

export function parseGmailMessage(message: GmailMessage): InboxMessage {
  const headers = message.payload?.headers ?? [];
  const header = (name: string) =>
    headers
      .filter((h) => h.name.toLowerCase() === name.toLowerCase())
      .map((h) => h.value)
      .join("; ");
  return {
    id: message.id,
    threadId: message.threadId,
    ...parseFromHeader(header("From")),
    subject: header("Subject").slice(0, 200),
    receivedAt: Number(message.internalDate),
    authResults: header("Authentication-Results"),
    snippet: (message.snippet ?? "").slice(0, 300),
  };
}

/** Inbox email since the call's lookback window (the spoken-address fallback). */
export function listDemoInbox(now = Date.now()): Promise<InboxMessage[]> {
  return searchInbox(`in:inbox -from:me after:${Math.floor(now / 1000) - INBOX_LOOKBACK_S}`);
}

/**
 * Inbox email since the tag was issued that may carry it. Gmail tokenizes
 * "Lime 42" and "lime42" differently, so search the word both ways and let
 * `containsTag` decide.
 */
export function listTaggedMessages(tag: string, issuedAt: Date): Promise<InboxMessage[]> {
  const [word, digits] = tag.toLowerCase().split(" ");
  return searchInbox(`in:inbox -from:me after:${Math.floor(issuedAt.getTime() / 1000) - 60} {${word} ${word}${digits}}`);
}

async function searchInbox(query: string): Promise<InboxMessage[]> {
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const list = new URL(`${GMAIL}/messages`);
  list.searchParams.set("q", query);
  list.searchParams.set("maxResults", String(INBOX_PAGE));
  const res = await fetch(list, { headers: auth });
  if (!res.ok) throw new Error(`gmail list ${res.status}`);
  const { messages = [] } = (await res.json()) as { messages?: { id: string }[] };
  const full = await Promise.all(
    messages.map(async ({ id }) => {
      const url = new URL(`${GMAIL}/messages/${id}`);
      url.searchParams.set("format", "metadata");
      for (const h of ["From", "Subject", "Authentication-Results"]) url.searchParams.append("metadataHeaders", h);
      const one = await fetch(url, { headers: auth });
      if (!one.ok) throw new Error(`gmail get ${one.status}`);
      return parseGmailMessage((await one.json()) as GmailMessage);
    }),
  );
  return full;
}

/**
 * Voni's code reply (reply.ts), threaded to the visitor's email: re-reads its
 * Message-ID and Subject for In-Reply-To and "Re:". Returns the sent id.
 */
export async function sendThreadedReply(opts: {
  inReplyTo: string;
  threadId: string | null;
  to: string;
  language: string;
  name: string | null;
  code: string;
  warmLine: string;
}): Promise<string> {
  const auth = { Authorization: `Bearer ${await accessToken()}` };
  const url = new URL(`${GMAIL}/messages/${encodeURIComponent(opts.inReplyTo)}`);
  url.searchParams.set("format", "metadata");
  for (const h of ["Message-ID", "Subject"]) url.searchParams.append("metadataHeaders", h);
  const original = await fetch(url, { headers: auth, signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS) });
  if (!original.ok) throw new Error(`gmail get ${original.status}`);
  const headers = ((await original.json()) as { payload?: { headers?: { name: string; value: string }[] } }).payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const raw = replyEmail({
    language: opts.language,
    to: opts.to,
    subject: header("Subject"),
    messageIdHeader: header("Message-ID").trim(),
    name: opts.name,
    code: opts.code,
    warmLine: opts.warmLine,
  });
  const res = await fetch(`${GMAIL}/messages/send`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ raw, ...(opts.threadId ? { threadId: opts.threadId } : {}) }),
    signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gmail send ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { id: string }).id;
}

const summary = (m: InboxMessage, now: number) => ({
  id: m.id,
  from: m.from,
  name: m.fromName,
  subject: m.subject,
  minutesAgo: Math.round((now - m.receivedAt) / 60_000),
});

/** Jev role 1: which of the inbox's recent emails did the caller send? */
export async function jevMatch(
  claim: string,
  candidates: InboxMessage[],
  deps: JevDeps,
  now = Date.now(),
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const options = [...candidates.map((m) => m.id), "none"];
  const answer = await jevEvaluate(
    { kind: "email-match", claim, candidates: candidates.map((m) => summary(m, now)) },
    {
      type: "choice",
      instructions:
        "On a live demo call, the caller said aloud (through speech-to-text, so near-misses happen: a letter or two off, dots or dashes dropped, sound-alike spellings) that they just emailed us from `claim`. The inbox is shared with other people testing at the same time. Which candidate email did the caller send? Match the sender address to the claim, prefer the most recent, and pick none when no sender plausibly matches.",
      options,
    },
    deps,
  );
  const pick = answer?.pick;
  if (!pick || !options.includes(pick)) throw new Error("jev gave no usable pick");
  return pick === "none" ? null : pick;
}

/** Jev role 2: is the matched email spoofed or spam rather than a person writing from work? */
export async function jevSpoof(
  message: InboxMessage,
  deps: JevDeps,
  now = Date.now(),
): Promise<boolean> {
  const answer = await jevEvaluate(
    { kind: "email-spoof", ...summary(message, now), authResults: message.authResults.slice(0, 600) },
    {
      type: "boolean",
      instructions:
        "Is this email spoofed or spam rather than a real person writing from their own work address? Flag look-alike or throwaway sender domains, bulk or automated senders (newsletters, no-reply, notifications), and failed authentication. A short, casual, or empty test email from a real business address is NOT spam.",
    },
    deps,
  );
  if (typeof answer?.probability !== "number") throw new Error("jev gave no probability");
  return answer.probability >= SPOOF_THRESHOLD;
}

const argsSchema = z.object({ address: z.string().trim().max(200).optional() });

/**
 * The `check_email` tool for one verified demo call. No address: look for the
 * call's Test tag (the main path). An address: only when the visitor said
 * one ("I forgot the tag"), matched as before. Either way a found email is
 * recorded on the call's tag, so a callback knows it.
 */
export async function runCheckEmail(call: DemoCall, rawArguments: unknown): Promise<ToolResponse> {
  const args = argsSchema.safeParse(rawArguments);
  if (!args.success) {
    return { ok: false, error: "Check again without an address, or with the one the caller said.", retryable: true };
  }
  const budget = await bumpRateBucket(`inbox:call:${call.callId}`, CHECKS_PER_CALL, CHECK_BUDGET_WINDOW_S);
  if (!budget.ok) {
    return { ok: false, error: "Too many inbox checks on this call.", retryable: false };
  }
  const tag = call.tagId ? await loadLiveTestTag(call.tagId) : null;
  const judge = { ...(await judgeDepsFromSecrets()), timeoutMs: 3000 };
  const spoof = (message: InboxMessage) => jevSpoof(message, judge);
  // Placeholders the model sometimes invents ("unknown", "none") are not addresses.
  const spoken = args.data.address && normalizeClaim(args.data.address) ? args.data.address : null;
  let result: CheckEmailResult;
  if (spoken) {
    result = await checkEmail(spoken, {
      listInbox: () => listDemoInbox(),
      since: call.startedAt,
      jevMatch: (claim, candidates) => jevMatch(claim, candidates, judge),
      jevSpoof: spoof,
    });
  } else if (tag) {
    result = await checkTag(tag.tag, { listTagged: () => listTaggedMessages(tag.tag, tag.issuedAt), jevSpoof: spoof });
  } else {
    return { ok: false, error: "This call has no test tag.", retryable: false };
  }
  if (result.status === "found" && result.exact && tag) {
    const { returning } = await recordTagMatch(tag, result);
    result = { ...result, returning };
  }
  return { ok: true, data: { ...checkResultToData(result), instructions: checkEmailInstructions(result) } };
}
