import { TALK_BASE_S } from "./talk-clock";
import { containsTag, countTags } from "./test-tag";

/**
 * The demo's email test (beats 2–4, docs/adr/0004): the visitor emails the
 * shared test inbox with their Test tag in the subject, and Voni finds it
 * among everyone else's (`checkTag`); the sender's own address is the claim.
 * A spoken address (`checkEmail`, Jev near-miss matcher) is only the
 * fallback when the visitor forgot the tag. The inbox read (inbox.ts) and
 * the Jev judges are injected, so the gate, the matchers and the extension
 * are testable offline. Browser-safe: the call component imports the state
 * half, plus the two localStorage helpers for the browser's tag token.
 */

/** The shared test inbox. Moves to test@voni.cc once the domain's email routing exists (spec: deferred). */
export const DEMO_INBOX_ADDRESS = "hi@pilotxstudio.com";

/** Talk clock once the visitor's email arrives from a business address: provisional, until the code check (04). */
export const PROVISIONAL_TALK_S = 360;

/** How far back the inbox is searched: covers a whole call (wall cap) plus a margin. */
export const INBOX_LOOKBACK_S = 15 * 60;

export type InboxMessage = {
  id: string;
  threadId: string;
  /** Sender address, lowercased. */
  from: string;
  fromName: string;
  subject: string;
  /** Epoch ms, from Gmail's internalDate. */
  receivedAt: number;
  /** Gmail's Authentication-Results header (SPF/DKIM/DMARC). */
  authResults: string;
  /** Gmail's start-of-body snippet: visitors put the tag in the body too. */
  snippet?: string;
};

export type CheckEmailResult =
  | { status: "invalid" }
  | { status: "free"; address: string }
  /** `address` is null on the tag path: there is no claimed address to say. */
  | { status: "not_arrived"; address: string | null; name: string | null }
  | {
      status: "found";
      address: string;
      from: string;
      name: string | null;
      /** False when speech-to-text heard the address slightly differently: Voni confirms it. */
      exact: boolean;
      messageId: string;
      threadId: string;
      /** The sender matched an earlier tag: a returning visitor (another device). */
      returning?: boolean;
    };

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A claim as the model passes it, written or spelled out ("andres at casaverde dot pt"). */
export function normalizeClaim(raw: string): string | null {
  const address = ` ${raw.toLowerCase()} `
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+(dash|hyphen)\s+/g, "-")
    .replace(/\s+underscore\s+/g, "_")
    .replace(/\s+/g, "")
    .replace(/\.+$/, "");
  return EMAIL.test(address) ? address : null;
}

const FREE_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "msn.com", "ymail.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me", "web.de", "mail.ru", "inbox.ru", "zoho.com", "zohomail.com",
  "tutanota.com", "tuta.io", "fastmail.com", "hey.com", "qq.com", "163.com", "126.com", "libero.it",
  "virgilio.it", "orange.fr", "free.fr", "laposte.net", "wanadoo.fr", "sfr.fr", "t-online.de",
  "freenet.de", "uol.com.br", "bol.com.br", "terra.com.br", "sapo.pt", "mail.com", "email.com",
]);
/** Brands with a domain per country (hotmail.co.uk, yahoo.fr, gmx.de…). */
const FREE_BRANDS = new Set(["outlook", "hotmail", "live", "yahoo", "gmx", "yandex"]);

export function isFreeEmailDomain(domain: string): boolean {
  if (FREE_DOMAINS.has(domain)) return true;
  const [brand, ...tld] = domain.split(".");
  return FREE_BRANDS.has(brand) && tld.length > 0 && tld.length <= 2 && tld.every((l) => l.length <= 3);
}

const ROLE_BOXES = new Set([
  "info", "sales", "contact", "hello", "hi", "admin", "office", "team", "support", "mail", "email",
  "test", "me", "enquiries", "inquiries", "booking", "bookings", "reception", "hr", "jobs", "noreply",
]);

/** A first name to greet by: the address's first word, else the display name's. Null when there is none. */
export function nameFromAddress(address: string, displayName = ""): string | null {
  const first = (words: string[]) => {
    const word = words[0] ?? "";
    if (!/^\p{L}{2,}$/u.test(word) || ROLE_BOXES.has(word.toLowerCase())) return null;
    return word[0].toUpperCase() + word.slice(1).toLowerCase();
  };
  const fromAddress = first(address.split("@")[0].split(/[._\-+]/));
  if (fromAddress || !displayName || displayName.includes("@")) return fromAddress;
  return first(displayName.trim().split(/\s+/));
}

/** Gmail's verdict: DMARC fail, or SPF fail with no DKIM pass (forwarders break SPF, not DKIM). */
export function spoofedByHeaders(authResults: string): boolean {
  const h = authResults.toLowerCase();
  if (/\bdmarc=fail\b/.test(h)) return true;
  return /\bspf=fail\b/.test(h) && !/\bdkim=pass\b/.test(h);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** Speech-to-text near-misses: a letter or two off, a dash or dot dropped. */
const NEAR_MISS_EDITS = 2;
/** Jev may reach further ("and dress" for "andres"), but never to an unrelated sender. */
const JEV_MAX_EDITS = 6;
/** Gmail's arrival stamp and the Worker clock may disagree by a little. */
const CLOCK_SKEW_MS = 60_000;

/** The matcher without Jev: the newest exact sender, else the newest near miss. */
export function fallbackMatch(
  claim: string,
  messages: InboxMessage[],
): { message: InboxMessage; exact: boolean } | null {
  const newest = [...messages].sort((a, b) => b.receivedAt - a.receivedAt);
  const exact = newest.find((m) => m.from === claim);
  if (exact) return { message: exact, exact: true };
  const near = newest.find((m) => editDistance(m.from, claim) <= NEAR_MISS_EDITS);
  return near ? { message: near, exact: false } : null;
}

export type CheckEmailDeps = {
  listInbox: () => Promise<InboxMessage[]>;
  /** The call's start (epoch ms): only email that arrived during this call can be the caller's. */
  since?: number;
  /** Jev's pick among the candidates: a message id, or null for none. Throws when Jev is unavailable. */
  jevMatch?: (claim: string, candidates: InboxMessage[]) => Promise<string | null>;
  /** Jev's spoof/spam flag on the matched email. Throws when Jev is unavailable. */
  jevSpoof?: (message: InboxMessage) => Promise<boolean>;
};

export async function checkEmail(raw: string, deps: CheckEmailDeps): Promise<CheckEmailResult> {
  const address = normalizeClaim(raw);
  // Our own inbox is never the caller's address (a mishearing of what Voni said).
  if (!address || address === DEMO_INBOX_ADDRESS) return { status: "invalid" };
  if (isFreeEmailDomain(address.split("@")[1])) return { status: "free", address };
  const notArrived: CheckEmailResult = { status: "not_arrived", address, name: nameFromAddress(address) };

  const inbox = await deps.listInbox().catch((e: unknown) => {
    console.error(`[demo-inbox] read failed: ${e}`);
    return [];
  });
  const since = (deps.since ?? 0) - CLOCK_SKEW_MS;
  const candidates = inbox.filter((m) => m.receivedAt >= since && !spoofedByHeaders(m.authResults));

  // An exact sender needs no judge; Jev only weighs near misses.
  let match = fallbackMatch(address, candidates);
  if (!match?.exact) {
    try {
      if (!deps.jevMatch) throw new Error("no jev");
      const id = await deps.jevMatch(address, candidates);
      const picked = candidates.find((m) => m.id === id && editDistance(m.from, address) <= JEV_MAX_EDITS);
      match = picked ? { message: picked, exact: false } : null;
    } catch {
      // Jev unavailable: keep the fallback's near miss.
    }
  }
  if (!match) return notArrived;

  // A spoof judge that is down counts as "not flagged": Gmail's DMARC/SPF
  // verdict already filtered the candidates above.
  const flagged = await (deps.jevSpoof?.(match.message) ?? Promise.resolve(false)).catch(() => false);
  if (flagged) return notArrived;

  const { message, exact } = match;
  return {
    status: "found",
    address,
    from: message.from,
    // A near miss is not confirmed yet: its sender's display name is not ours to say.
    name: exact ? nameFromAddress(message.from, message.fromName) : nameFromAddress(address),
    exact,
    messageId: message.id,
    threadId: message.threadId,
  };
}

export type CheckTagDeps = {
  /** Inbox email since the tag was issued that may carry it (inbox.ts narrows by the tag's word). */
  listTagged: () => Promise<InboxMessage[]>;
  /** Jev's spoof/spam flag. Throws when Jev is unavailable. */
  jevSpoof?: (message: InboxMessage) => Promise<boolean>;
};

/**
 * The main path: the newest authentic email carrying the Test tag is the
 * visitor's, and its sender is the claim. The work-email gate applies to that
 * sender's domain. The tag is unique among live tags, so a match is exact.
 */
export async function checkTag(tag: string, deps: CheckTagDeps): Promise<CheckEmailResult> {
  const notArrived: CheckEmailResult = { status: "not_arrived", address: null, name: null };
  const inbox = await deps.listTagged().catch((e: unknown) => {
    console.error(`[demo-inbox] read failed: ${e}`);
    return [];
  });
  // Subject or the start of the body (the owner's own test put it in the
  // body), and exactly one tag across both: an email listing many tags
  // would otherwise claim every live visitor whose tag it names.
  const text = (m: InboxMessage) => `${m.subject} ${m.snippet ?? ""}`;
  const carrying = inbox
    .filter((m) => containsTag(text(m), tag) && countTags(text(m), tag) === 1 && !spoofedByHeaders(m.authResults))
    .sort((a, b) => b.receivedAt - a.receivedAt);
  for (const message of carrying) {
    // A spoof judge that is down counts as "not flagged": Gmail's verdict
    // already filtered above.
    const flagged = await (deps.jevSpoof?.(message) ?? Promise.resolve(false)).catch(() => false);
    if (flagged) continue;
    if (isFreeEmailDomain(message.from.split("@")[1] ?? "")) return { status: "free", address: message.from };
    return {
      status: "found",
      address: message.from,
      from: message.from,
      name: nameFromAddress(message.from, message.fromName),
      exact: true,
      messageId: message.id,
      threadId: message.threadId,
    };
  }
  return notArrived;
}

/** The call's side of the test: whether Voni invited it, and whether the visitor's business email landed. */
export type EmailTestState = {
  /** Voni showed the address and the tag and invited the test. */
  invited: boolean;
  found: boolean;
  /** Their email landed from a personal address: the work-email gate was given. */
  gated?: boolean;
};

export const EMAIL_TEST_START: EmailTestState = { invited: false, found: false };

export function emailTestAfterCheck(state: EmailTestState, result: CheckEmailResult): EmailTestState {
  if (state.found) return state;
  // A near miss (spoken fallback) waits for the spelled-out address.
  if (result.status === "found" && result.exact) return { ...state, found: true };
  if (result.status === "free") return { ...state, gated: true };
  return state;
}

/** Only an arrived business email earns the provisional extension (never a spoken claim). */
export function talkLimitS(state: EmailTestState): number {
  return state.found ? PROVISIONAL_TALK_S : TALK_BASE_S;
}

/**
 * A check as the tool route sends it. Message and thread ids stay
 * server-side (the reply in 04 re-finds them), and so does the sender: a
 * near miss may be another tester's address.
 */
export function checkResultToData(result: CheckEmailResult): Record<string, unknown> {
  if (result.status === "found") {
    const { status, address, name, exact, returning } = result;
    return { status, address, name, exact, ...(returning ? { returning } : {}) };
  }
  return { ...result };
}

/** The browser's view of a check: `checkResultToData` read back. */
export function checkResultFromData(data: Record<string, unknown>): CheckEmailResult {
  const address = typeof data.address === "string" ? data.address : "";
  const name = typeof data.name === "string" ? data.name : null;
  if (data.status === "free" && address) return { status: "free", address };
  if (data.status === "not_arrived") return { status: "not_arrived", address: address || null, name };
  if (data.status === "found" && address) {
    return {
      status: "found",
      address,
      from: "",
      name,
      exact: data.exact === true,
      messageId: "",
      threadId: "",
      ...(data.returning === true ? { returning: true } : {}),
    };
  }
  return { status: "invalid" };
}

/** Where the browser keeps its signed Test-tag token (a day; the server re-checks expiry). */
export const TAG_TOKEN_KEY = "voni:test-tag";

export function loadTagToken(): string | undefined {
  try {
    return localStorage.getItem(TAG_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveTagToken(token: string): void {
  try {
    localStorage.setItem(TAG_TOKEN_KEY, token);
  } catch {
    // Private mode or blocked storage: a callback just gets a fresh tag.
  }
}

/**
 * Voni talked about her screen without calling the show tool (measured 2 in
 * 50 live runs: "Let me put something on your screen." and no tool call).
 * The call then puts the test up itself.
 */
export function mentionsScreen(text: string): boolean {
  // Voni putting something up, not business talk about someone's screen.
  return /\bput(?:ting)?\b[^.!?]{0,40}\bon (?:your |the )?screen\b/i.test(text);
}
