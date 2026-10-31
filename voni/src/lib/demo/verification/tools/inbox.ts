/**
 * The real test inbox, as evidence for X4, X5 and X8.
 *
 * The demo's `check_email` claims an email landed; this module re-reads the
 * same Gmail inbox by the call's Test tag and answers what actually arrived:
 * the message id, its thread, whether the sender is a personal domain, and how
 * many replies the inbox account sent into that thread. It never sends mail and
 * never accepts a customer address: a live check reads the shared test inbox
 * only.
 *
 * A missing key is `inbox-not-configured`; a rejected token is
 * `inbox-auth-failed`; an unreadable inbox is `inbox-unreachable`. Every one is
 * exit 2 and named, because an inbox nobody could read is unrun evidence, never
 * a green.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "No mocks on the golden path"
 * and the "Tools and email" table.
 */

import { DEMO_INBOX_ADDRESS, isFreeEmailDomain, spoofedByHeaders } from "@/lib/demo/email-test";
import { containsTag, countTags } from "@/lib/demo/test-tag";

export const INBOX_ERROR_CODES = [
  "inbox-not-configured",
  "inbox-auth-failed",
  "inbox-unreachable",
  "inbox-malformed",
  "tag-not-delivered",
  "delivery-mismatch",
] as const;

export type InboxErrorCode = (typeof INBOX_ERROR_CODES)[number];

export class InboxError extends Error {
  readonly code: InboxErrorCode;
  readonly exitCode = 2 as const;

  constructor(code: InboxErrorCode, message: string) {
    super(message);
    this.name = "InboxError";
    this.code = code;
  }
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const INBOX_LOOKBACK_MARGIN_S = 60;
const INBOX_PAGE = 30;

/** The three values the inbox needs; all three are required together. */
export const INBOX_ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "DEMO_INBOX_REFRESH_TOKEN",
] as const;

export type InboxEnv = Readonly<Record<string, string | undefined>>;

export type InboxConfig =
  | {
      readonly configured: true;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly refreshToken: string;
    }
  | { readonly configured: false; readonly missing: readonly string[] };

export type InboxDeps = {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export function inboxConfig(env: InboxEnv): InboxConfig {
  const missing = INBOX_ENV_KEYS.filter((key) => (env[key] ?? "").trim() === "");
  if (missing.length > 0) return { configured: false, missing };
  return {
    configured: true,
    clientId: (env.GOOGLE_CLIENT_ID ?? "").trim(),
    clientSecret: (env.GOOGLE_CLIENT_SECRET ?? "").trim(),
    refreshToken: (env.DEMO_INBOX_REFRESH_TOKEN ?? "").trim(),
  };
}

function requireConfig(env: InboxEnv): Extract<InboxConfig, { configured: true }> {
  const config = inboxConfig(env);
  if (!config.configured) {
    throw new InboxError(
      "inbox-not-configured",
      `the demo test inbox is not configured: ${config.missing.join(", ")} ` +
        `${config.missing.length === 1 ? "is" : "are"} not set. The golden path sends a real ` +
        "email to the test inbox and reads it back; without these values that check cannot run.",
    );
  }
  return config;
}

async function accessToken(
  config: Extract<InboxConfig, { configured: true }>,
  deps: InboxDeps,
): Promise<string> {
  let response: Response;
  try {
    response = await deps.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (error) {
    throw new InboxError(
      "inbox-unreachable",
      `the demo inbox's token endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new InboxError(
      "inbox-auth-failed",
      `the demo inbox's refresh token was rejected with HTTP ${response.status}; ` +
        "re-mint it with scripts/mint-demo-inbox-token.mts",
    );
  }
  const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  const token = typeof body?.access_token === "string" ? body.access_token : "";
  if (token === "") {
    throw new InboxError("inbox-auth-failed", "the demo inbox's token response carried no access token");
  }
  return token;
}

async function gmailJson(
  url: URL,
  token: string,
  deps: InboxDeps,
  what: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    throw new InboxError(
      "inbox-unreachable",
      `the demo inbox could not be read while ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new InboxError(
      "inbox-unreachable",
      `the demo inbox answered HTTP ${response.status} while ${what}`,
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InboxError("inbox-malformed", `the demo inbox's ${what} response is not an object`);
  }
  return body as Record<string, unknown>;
}

export type InboxProbe = {
  readonly ok: true;
  readonly emailAddress: string;
  readonly messagesTotal: number;
};

/** Read the inbox's own profile: the one cheap proof it is reachable and authenticated. */
export async function probeInbox(env: InboxEnv, deps: InboxDeps): Promise<InboxProbe> {
  const config = requireConfig(env);
  const token = await accessToken(config, deps);
  const body = await gmailJson(new URL(`${GMAIL}/profile`), token, deps, "reading its profile");
  const emailAddress = typeof body.emailAddress === "string" ? body.emailAddress : "";
  const messagesTotal = typeof body.messagesTotal === "number" ? body.messagesTotal : 0;
  if (emailAddress === "") {
    throw new InboxError("inbox-malformed", "the demo inbox's profile carries no address");
  }
  return { ok: true, emailAddress, messagesTotal };
}

type GmailMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
};

function asMessage(raw: unknown, what: string): GmailMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InboxError("inbox-malformed", `${what} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const threadId = typeof record.threadId === "string" ? record.threadId : "";
  if (id === "" || threadId === "") {
    throw new InboxError("inbox-malformed", `${what} carries no id or thread id`);
  }
  return {
    id,
    threadId,
    internalDate: typeof record.internalDate === "string" ? record.internalDate : "0",
    snippet: typeof record.snippet === "string" ? record.snippet : "",
    ...(record.payload === undefined
      ? {}
      : { payload: record.payload as GmailMessage["payload"] }),
  };
}

function header(message: GmailMessage, name: string): string {
  return (message.payload?.headers ?? [])
    .filter((entry) => entry.name.toLowerCase() === name.toLowerCase())
    .map((entry) => entry.value)
    .join("; ");
}

/** `"Andres" <Andres@CasaVerde.pt>` → `andres@casaverde.pt`. */
function fromAddress(headerValue: string): string {
  const angled = /<([^>]+)>/.exec(headerValue);
  return (angled?.[1] ?? headerValue).trim().toLowerCase();
}

function senderKind(from: string): "work" | "personal" {
  return isFreeEmailDomain(from.split("@")[1] ?? "") ? "personal" : "work";
}

/** The same Gmail query `listTaggedMessages` uses: the tag both ways, since Gmail tokenizes them apart. */
function taggedQuery(tag: string, issuedAt: Date): string {
  const [word, digits] = tag.toLowerCase().split(" ");
  const after = Math.floor(issuedAt.getTime() / 1_000) - INBOX_LOOKBACK_MARGIN_S;
  return `in:inbox -from:me after:${after} {${word} ${word}${digits}}`;
}

export type TaggedMessage = {
  readonly found: true;
  readonly messageId: string;
  readonly threadId: string;
  readonly senderKind: "work" | "personal";
  readonly receivedAt: number;
};

export type TaggedLookup = TaggedMessage | { readonly found: false };

/**
 * Re-read the inbox for one tag. The app's own filters are repeated: the tag
 * must appear once (an email naming several tags belongs to nobody) and Gmail's
 * own authentication verdict must not call it a spoof.
 */
export async function findTaggedMessage(input: {
  readonly tag: string;
  readonly issuedAt: Date;
  readonly env: InboxEnv;
  readonly deps: InboxDeps;
}): Promise<TaggedLookup> {
  const config = requireConfig(input.env);
  if (!Number.isFinite(input.issuedAt.getTime())) {
    throw new InboxError("inbox-malformed", "the call's tag issue time is not a valid date");
  }
  const token = await accessToken(config, input.deps);
  const list = new URL(`${GMAIL}/messages`);
  list.searchParams.set("q", taggedQuery(input.tag, input.issuedAt));
  list.searchParams.set("maxResults", String(INBOX_PAGE));
  const listed = await gmailJson(list, token, input.deps, "listing tagged mail");
  const ids = Array.isArray(listed.messages)
    ? listed.messages
        .map((entry) =>
          typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string"
            ? (entry as { id: string }).id
            : null,
        )
        .filter((id): id is string => id !== null)
    : [];
  if (ids.length === 0) return { found: false };

  const messages: GmailMessage[] = [];
  for (const id of ids) {
    const url = new URL(`${GMAIL}/messages/${id}`);
    url.searchParams.set("format", "metadata");
    for (const name of ["From", "Subject", "Authentication-Results"]) {
      url.searchParams.append("metadataHeaders", name);
    }
    messages.push(asMessage(await gmailJson(url, token, input.deps, `reading message ${id}`), `message ${id}`));
  }
  const carrying = messages
    .filter((message) => {
      const text = `${header(message, "Subject")} ${message.snippet ?? ""}`;
      return (
        containsTag(text, input.tag) &&
        countTags(text, input.tag) === 1 &&
        !spoofedByHeaders(header(message, "Authentication-Results"))
      );
    })
    .sort((left, right) => Number(right.internalDate) - Number(left.internalDate));
  const matched = carrying[0];
  if (matched === undefined) return { found: false };
  const from = fromAddress(header(matched, "From"));
  return {
    found: true,
    messageId: matched.id,
    threadId: matched.threadId,
    senderKind: senderKind(from),
    receivedAt: Number(matched.internalDate),
  };
}

export type ThreadReplyCount = {
  readonly threadId: string;
  readonly repliesFromInbox: number;
};

/**
 * How many messages in one thread were sent by the inbox account. Two replies
 * to one caller email is the double send X8 fails; the count is the inbox's
 * own, never the tool's claim.
 */
export async function countThreadReplies(input: {
  readonly threadId: string;
  readonly env: InboxEnv;
  readonly deps: InboxDeps;
}): Promise<number> {
  const config = requireConfig(input.env);
  const token = await accessToken(config, input.deps);
  const url = new URL(`${GMAIL}/threads/${encodeURIComponent(input.threadId)}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "From");
  const body = await gmailJson(url, token, input.deps, "reading a thread");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const mine = DEMO_INBOX_ADDRESS.toLowerCase();
  return messages.filter((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new InboxError("inbox-malformed", "a thread message is not an object");
    }
    const headers = (entry as { payload?: { headers?: unknown } }).payload?.headers;
    const list = Array.isArray(headers) ? headers : [];
    const from = list
      .filter(
        (headerEntry): headerEntry is { name: string; value: string } =>
          typeof headerEntry === "object" &&
          headerEntry !== null &&
          typeof (headerEntry as { name?: unknown }).name === "string" &&
          typeof (headerEntry as { value?: unknown }).value === "string",
      )
      .filter((headerEntry) => headerEntry.name.toLowerCase() === "from")
      .map((headerEntry) => headerEntry.value)
      .join("; ");
    return fromAddress(from) === mine;
  }).length;
}

export type InboxDelivery = {
  readonly verified: true;
  readonly tag: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly senderKind: "work" | "personal";
  readonly repliesFromInbox: number;
};

/**
 * Verify a tool's delivery claim against the inbox. A missing tag is
 * `tag-not-delivered`; a different message id is `delivery-mismatch`. Both are
 * refusals because the golden path cannot be asserted from the tool's prose.
 */
export async function verifyDelivery(
  input: {
    readonly tag: string;
    readonly issuedAt: Date;
    readonly claimedMessageId?: string;
    readonly threadId?: string;
    readonly env: InboxEnv;
  },
  deps: InboxDeps,
): Promise<InboxDelivery> {
  const found = await findTaggedMessage({
    tag: input.tag,
    issuedAt: input.issuedAt,
    env: input.env,
    deps,
  });
  if (!found.found) {
    throw new InboxError(
      "tag-not-delivered",
      `no message carrying tag "${input.tag}" is in the test inbox since the call; ` +
        "the tool's delivery claim cannot be verified",
    );
  }
  if (input.claimedMessageId !== undefined && input.claimedMessageId !== found.messageId) {
    throw new InboxError(
      "delivery-mismatch",
      `the tool matched message "${input.claimedMessageId}", but the inbox's tag "${input.tag}" ` +
        `is message "${found.messageId}"; one of the two is not this call's email`,
    );
  }
  const repliesFromInbox =
    input.threadId === undefined
      ? 0
      : await countThreadReplies({ threadId: input.threadId, env: input.env, deps });
  return {
    verified: true,
    tag: input.tag,
    messageId: found.messageId,
    threadId: found.threadId,
    senderKind: found.senderKind,
    repliesFromInbox,
  };
}
