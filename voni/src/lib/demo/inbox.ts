import { z } from "zod";
import { secret } from "@/lib/env";
import type { ToolResponse } from "@/lib/tools/execute";
import { jevEvaluate, judgeDepsFromSecrets, type JevDeps } from "@/lib/voice/voice-judge";
import { bumpRateBucket } from "./rate-limit";
import { checkEmail, checkResultToData, INBOX_LOOKBACK_S, type InboxMessage } from "./email-test";
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
  };
}

export async function listDemoInbox(now = Date.now()): Promise<InboxMessage[]> {
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const after = Math.floor(now / 1000) - INBOX_LOOKBACK_S;
  const list = new URL(`${GMAIL}/messages`);
  list.searchParams.set("q", `in:inbox -from:me after:${after}`);
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

const argsSchema = z.object({ address: z.string().trim().min(1).max(200) });

/** The `check_email` tool for one verified demo call. */
export async function runCheckEmail(
  call: { callId: string; startedAt: number },
  rawArguments: unknown,
): Promise<ToolResponse> {
  const args = argsSchema.safeParse(rawArguments);
  if (!args.success) {
    return { ok: false, error: "Ask the caller which address they used, then check again.", retryable: true };
  }
  const budget = await bumpRateBucket(`inbox:call:${call.callId}`, CHECKS_PER_CALL, CHECK_BUDGET_WINDOW_S);
  if (!budget.ok) {
    return { ok: false, error: "Too many inbox checks on this call.", retryable: false };
  }
  const judge = { ...(await judgeDepsFromSecrets()), timeoutMs: 3000 };
  const result = await checkEmail(args.data.address, {
    listInbox: () => listDemoInbox(),
    since: call.startedAt,
    jevMatch: (claim, candidates) => jevMatch(claim, candidates, judge),
    jevSpoof: (message) => jevSpoof(message, judge),
  });
  return { ok: true, data: { ...checkResultToData(result), instructions: checkEmailInstructions(result) } };
}
