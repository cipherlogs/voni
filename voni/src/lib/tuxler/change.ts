/**
 * The change command, and every reply the relay can answer it with.
 *
 * The probe recognised two of the nine replies and called the rest "not ok". That
 * is not enough here: a limit, an overload, an unavailable peer, a reply that moved
 * nothing, and a success that forgot its port are five different things, and only a
 * success with a usable port may ever become an exit. Nothing in this file dials,
 * binds or falls back — it classifies, and the caller decides.
 */
import type { Frame } from "./frames";

export interface ChangeRequest {
  /** ISO-3166 alpha-2. Defaults to `US`: this client never asks for `any` country. */
  country?: string;
  /** A city name, or `any`. Percent-encoded on the wire, exactly once. */
  city?: string;
  /** `next_nearby:1` walks to a neighbouring exit in the same place. */
  nearby?: boolean;
}

/** The `<details>` of `CHANGE_IP_COUNTRY_CITY`, in the relay's argument order. */
export function encodeChangeRequest(request: ChangeRequest = {}): string {
  const country = (request.country ?? "US").trim() || "US";
  const city = (request.city ?? "any").trim() || "any";
  const nearby = request.nearby === true ? "1" : "0";
  return `next_nearby:${nearby};country:${country};city:${encodeURIComponent(city)};`;
}

export interface ExitLocation {
  /** The display name, e.g. `United States`. Prose; only a two-letter code is a claim. */
  country: string | null;
  /**
   * The reply's own country claim: `<countryiso>` when it is a two-letter code,
   * else `<country>` when that is one. `null` means the reply made no claim — the
   * registry then decides. A full country name is never mapped by guesswork.
   */
  countryIso: string | null;
  region: string | null;
  city: string | null;
}

export type ChangeOutcome =
  /** A new exit, with the port the relay itself assigned. */
  | {
      kind: "changed";
      tag: string;
      ip: string;
      port: number;
      location: ExitLocation;
      /** Element names only, in reply order — never values. */
      elements: string[];
      /** True for `…_BUT_LIMIT`: usable now, and this bucket has nothing left. */
      lastOfBucket: boolean;
    }
  /** The relay says we are already on that exit; no move happened. */
  | { kind: "no-change"; tag: string; ip: string | null; port: number | null; location: ExitLocation }
  | { kind: "limit"; tag: string }
  | { kind: "not-available"; tag: string }
  | { kind: "overloaded"; tag: string }
  | { kind: "not-entitled"; tag: string }
  | { kind: "exit-unavailable"; tag: string; limitReached: boolean }
  /** A success tag that carries no usable port — treated as no exit at all. */
  | { kind: "incomplete"; tag: string; reason: string; location: ExitLocation }
  | { kind: "unrecognised"; tag: string };

const CHANGE_TAG_PREFIXES = ["IP_CHANGED", "IP_NOT_CHANGED", "IP_BECAME_UNAVAILABLE"] as const;

/** Whether this tag is a change reply rather than heartbeat or account traffic. */
export function isChangeReplyTag(tag: string): boolean {
  const normalised = tag.trim();
  return CHANGE_TAG_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}

/** First `<name>…</name>` anywhere in the payload; handles flat and nested shapes. */
function readElement(details: string, element: string): string | null {
  const match = new RegExp(`<${element}>([\\s\\S]*?)</${element}>`).exec(details);
  if (match === null) return null;
  const value = match[1].trim();
  return value === "" ? null : value;
}

/**
 * `<ip>` appears twice in some payloads (`<location><ip>` and a top-level `<ip>`);
 * prefer the top-level one and fall back to the nested form.
 */
function readAddress(details: string): string | null {
  const top = /<ip>([\s\S]*?)<\/ip>/.exec(details);
  return top === null ? null : top[1].trim() || null;
}

/** `US` in either element is a claim; `United States`, or anything else, is not. */
function readCountryIso(details: string): string | null {
  const iso = readElement(details, "countryiso");
  if (iso !== null && /^[A-Za-z]{2}$/.test(iso)) return iso.toUpperCase();
  const country = readElement(details, "country");
  if (country !== null && /^[A-Za-z]{2}$/.test(country)) return country.toUpperCase();
  return null;
}

export function readLocation(details: string): ExitLocation {
  return {
    country: readElement(details, "country"),
    countryIso: readCountryIso(details),
    region: readElement(details, "region"),
    city: readElement(details, "city"),
  };
}

/** Every element name in the reply, first-seen order. Names only: never values. */
export function readElementNames(details: string): string[] {
  const names: string[] = [];
  for (const match of details.matchAll(/<([A-Za-z][^>\s/]*)[^>]*>/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function readPort(details: string): number | null {
  const raw = readElement(details, "port");
  if (raw === null) return null;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return port;
}

/**
 * The relay gates its own port read on `<status>OK</status>`; so do we. A missing
 * `<status>` is accepted because the probe saw live successes without one, but any
 * other value means the port is not ours to use.
 */
function statusAllowsPort(details: string): boolean {
  const status = readElement(details, "status");
  return status === null || status.toUpperCase() === "OK";
}

export function parseChangeReply(frame: Frame): ChangeOutcome {
  const tag = frame.tag.trim();
  const details = frame.details;
  const location = readLocation(details);

  switch (tag) {
    case "IP_CHANGED_SUCCESSFULLY":
    case "IP_CHANGED_SUCCESSFULLY_BUT_LIMIT": {
      const lastOfBucket = tag === "IP_CHANGED_SUCCESSFULLY_BUT_LIMIT";
      const ip = readAddress(details);
      const port = readPort(details);
      if (ip === null) return { kind: "incomplete", tag, reason: "the reply named no address", location };
      if (port === null) return { kind: "incomplete", tag, reason: "the reply named no port", location };
      if (!statusAllowsPort(details)) {
        return { kind: "incomplete", tag, reason: "the reply's status was not OK", location };
      }
      return { kind: "changed", tag, ip, port, location, elements: readElementNames(details), lastOfBucket };
    }
    case "IP_CHANGED_SUCCESSFULLY_ALREADY_USING":
      return {
        kind: "no-change",
        tag,
        ip: readAddress(details),
        port: readPort(details),
        location,
      };
    case "IP_NOT_CHANGED_LIMITS":
      return { kind: "limit", tag };
    case "IP_NOT_CHANGED_NOT_AVAILABLE":
      return { kind: "not-available", tag };
    case "IP_NOT_CHANGED_OVERLOADED":
      return { kind: "overloaded", tag };
    case "IP_CHANGED_FAILED_FREE":
      return { kind: "not-entitled", tag };
    case "IP_BECAME_UNAVAILABLE":
      return { kind: "exit-unavailable", tag, limitReached: false };
    case "IP_BECAME_UNAVAILABLE_AND_YOU_HAVE_REACHED_LIMITS":
      return { kind: "exit-unavailable", tag, limitReached: true };
    default:
      return { kind: "unrecognised", tag };
  }
}
