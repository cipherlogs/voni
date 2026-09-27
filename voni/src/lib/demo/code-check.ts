import { createHmac } from "node:crypto";

/**
 * The demo's code check (ticket 04): Voni replies to the visitor's email
 * with a 4-digit code framed as a fun test, and the visitor reads it back.
 * It is really an OTP; the reveal comes after it passes. Pure: the route
 * (reply.ts) does the Gmail send and the `demo_calls` row.
 */

/** Two tries, then Voni moves on without the verified extension. */
export const MAX_CODE_TRIES = 2;

/**
 * The call's code, derived rather than stored: stable across a rejoin of the
 * same call, different per call, and unguessable without the server key.
 * 1000–9999, so no leading zero to trip over aloud.
 */
export function replyCode(key: string, callId: string): string {
  const n = createHmac("sha256", `demo-code:${key}`).update(callId).digest().readUInt32BE(0);
  return String(1000 + (n % 9000));
}

/** The four digits the visitor read back, as the model passed them. */
export function spokenCode(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 4 ? digits : null;
}

/** The call's side of the check, as `demo_calls` keeps it. */
export type CodeCall = { replyMessageId: string | null; codeAttempts: number; codeVerifiedAt: Date | null };

export type CodeStatus = "correct" | "wrong" | "out_of_tries" | "unclear" | "used" | "not_sent";

/** A garbled read-back ("unclear") costs no try; a verified code never passes twice. */
export function codeOutcome(
  call: CodeCall | null,
  spoken: string | null,
  expected: string,
): { status: CodeStatus; triesLeft: number } {
  if (!call?.replyMessageId) return { status: "not_sent", triesLeft: MAX_CODE_TRIES };
  if (call.codeVerifiedAt) return { status: "used", triesLeft: 0 };
  const left = MAX_CODE_TRIES - call.codeAttempts;
  if (left <= 0) return { status: "out_of_tries", triesLeft: 0 };
  if (!spoken) return { status: "unclear", triesLeft: left };
  return { status: spoken === expected ? "correct" : "wrong", triesLeft: left - 1 };
}

/** Fixed per language, so nothing in it reads like a security email; Voni only adds one line. */
const TEMPLATES: Record<string, { hi: (name: string | null) => string; code: (code: string) => string }> = {
  en: { hi: (n) => (n ? `Hi ${n},` : "Hi,"), code: (c) => `Here's a code to test things out: ${c}\nTell me what it says!` },
  es: { hi: (n) => (n ? `Hola ${n}:` : "Hola:"), code: (c) => `Aquí tienes un código para probar: ${c}\n¡Dime qué dice!` },
  fr: { hi: (n) => (n ? `Bonjour ${n},` : "Bonjour,"), code: (c) => `Voici un code pour tester : ${c}\nDites-moi ce qu'il indique !` },
  de: { hi: (n) => (n ? `Hallo ${n},` : "Hallo,"), code: (c) => `Hier ist ein Code zum Ausprobieren: ${c}\nSagen Sie mir, was da steht!` },
  it: { hi: (n) => (n ? `Ciao ${n},` : "Ciao,"), code: (c) => `Ecco un codice per provare: ${c}\nDimmi cosa c'è scritto!` },
  pt: { hi: (n) => (n ? `Olá ${n},` : "Olá,"), code: (c) => `Aqui está um código para testar: ${c}\nDiga-me o que diz!` },
};

const WARM_LINE_MAX = 300;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A first name as Voni heard it, or null for anything that isn't one. */
function cleanName(raw: string | null): string | null {
  const name = raw?.trim() ?? "";
  return /^\p{L}[\p{L}' -]{0,39}$/u.test(name) ? name : null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const encodeHeader = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

/** The reply as Gmail's `raw`: base64url RFC 2822, threaded to the visitor's email. */
export function replyEmail(opts: {
  language: string;
  to: string;
  subject: string;
  /** The visitor's RFC 2822 Message-ID, for In-Reply-To; "" when Gmail had none. */
  messageIdHeader: string;
  name: string | null;
  code: string;
  warmLine: string;
}): string {
  if (!EMAIL.test(opts.to)) throw new Error("reply address is not an email");
  const t = TEMPLATES[opts.language] ?? TEMPLATES.en;
  const warm = oneLine(opts.warmLine).slice(0, WARM_LINE_MAX);
  const body = [t.hi(cleanName(opts.name)), "", t.code(opts.code), ...(warm ? ["", warm] : []), "", "Voni"].join("\n");
  const subject = oneLine(opts.subject);
  const threaded = /^<[^\s<>]+>$/.test(opts.messageIdHeader)
    ? [`In-Reply-To: ${opts.messageIdHeader}`, `References: ${opts.messageIdHeader}`]
    : [];
  const mime = [
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(/^re:/i.test(subject) ? subject : `Re: ${subject}`)}`,
    ...threaded,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body.replace(/\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}
