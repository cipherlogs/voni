/**
 * Is this exit the one we are allowed to use?
 *
 * Two independent answers, both required. The country comes from the change reply's
 * own `countryiso` — never from its prose `country` — and the address class comes
 * from a reverse-DNS ASN lookup. A US address in a hosting ASN is worse than no
 * address at all: it looks like proxying without the residential trust the Source
 * exists to show. So anything we cannot classify is rejected (fail closed), and the
 * lookup is injected so a test never touches DNS.
 *
 * The real lookup is Team Cymru's DNS service: one TXT query for the origin
 * (ASN + prefix + registry country) and one for the AS name, both cached — the
 * origin by /24, the name by ASN — for the life of the process.
 */
import { promises as dns } from "node:dns";

export interface AsnRecord {
  asn: number;
  /** The announced prefix, e.g. `99.44.0.0/14`. */
  prefix: string;
  /** The registry's country for the prefix, not a geolocation. */
  country: string | null;
  /** The AS name, e.g. `ATT-INTERNET4 - AT&T Services, Inc.` */
  name: string | null;
}

/** Resolves an address to its ASN. Rejecting is a lookup failure, never a pass. */
export type AsnLookup = (ip: string) => Promise<AsnRecord>;

export type ExitRejectionReason =
  | "not-us"
  | "hosting"
  | "lookup-failed"
  | "name-lookup-failed";

export type ExitVerdict =
  | { accepted: true; asn: AsnRecord }
  | { accepted: false; reason: ExitRejectionReason; detail: string };

/** The only country this client serves. Not a default — a constraint. */
export const REQUIRED_COUNTRY = "US";

/**
 * Hosting and cloud providers a residential exit can never be. The list is a
 * deny-list by design: an unknown AS is judged by its name, so a new cloud provider
 * that calls itself "Hosting" or "Cloud" is still caught.
 */
export const HOSTING_ASNS: ReadonlySet<number> = new Set([
  15169, // Google
  16509, // Amazon
  14618, // Amazon
  8075, // Microsoft
  8068, // Microsoft
  14061, // DigitalOcean
  63949, // Akamai / Linode
  16276, // OVH
  24940, // Hetzner
  20473, // Vultr / Choopa
  12876, // Scaleway / Online SAS
  51167, // Contabo
  13335, // Cloudflare
  9009, // M247
  28753, // Leaseweb
  41378, // Kirino / hosting
  36352, // ColoCrossing
  46844, // Sharktech
  398324, // generic small cloud
]);

const HOSTING_NAME_HINTS = [
  "hosting",
  "hosted",
  "datacenter",
  "data center",
  "colocation",
  "cloud",
  "vps",
  "virtual server",
  "server",
  "amazon",
  "google",
  "microsoft",
  "digitalocean",
  "linode",
  "ovh",
  "hetzner",
  "vultr",
  "contabo",
  "cloudflare",
  "leaseweb",
  "colo",
];

export interface ExitValidationInput {
  ip: string;
  /** `countryiso` from the change reply. `null` is rejected, never assumed US. */
  countryIso: string | null;
  lookup: AsnLookup;
}

export async function validateExit(input: ExitValidationInput): Promise<ExitVerdict> {
  const countryIso = input.countryIso?.trim().toUpperCase() ?? "";
  if (countryIso !== REQUIRED_COUNTRY) {
    return {
      accepted: false,
      reason: "not-us",
      detail: `the change reply named ${countryIso === "" ? "no country" : countryIso}; only ${REQUIRED_COUNTRY} is served`,
    };
  }

  let record: AsnRecord;
  try {
    record = await input.lookup(input.ip);
  } catch (error) {
    return {
      accepted: false,
      reason: "lookup-failed",
      detail: `the ASN lookup for ${input.ip} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!Number.isInteger(record.asn) || record.asn <= 0 || record.prefix === "") {
    return {
      accepted: false,
      reason: "lookup-failed",
      detail: `the ASN lookup for ${input.ip} named no origin`,
    };
  }

  const asnClass = classifyAsn(record);
  if (asnClass === "hosting") {
    return {
      accepted: false,
      reason: "hosting",
      detail: `${input.ip} is in AS${record.asn} (${record.name ?? record.prefix}), which is not a consumer ISP`,
    };
  }

  // A resolved origin whose AS name could not be read is not a consumer ISP by
  // default: the deny-list only covers known providers, so an unlisted hosting
  // ASN with a failed name query would otherwise be served. Fail closed.
  if (asnClass === "unclassifiable") {
    return {
      accepted: false,
      reason: "name-lookup-failed",
      detail:
        `AS${record.asn} (${record.prefix}) answered no AS name, so ${input.ip} ` +
        "could not be classified as a consumer ISP",
    };
  }

  return { accepted: true, asn: record };
}

/**
 * The three answers the classifier can give. `unclassifiable` is not a fourth
 * kind of network: it means the name query that would have decided the question
 * did not answer, and the caller must refuse rather than assume a consumer ISP.
 */
export type AsnClass = "consumer" | "hosting" | "unclassifiable";

export function classifyAsn(record: AsnRecord): AsnClass {
  if (HOSTING_ASNS.has(record.asn)) return "hosting";
  const name = record.name?.trim().toLowerCase() ?? "";
  if (name === "") return "unclassifiable";
  if (HOSTING_NAME_HINTS.some((hint) => name.includes(hint))) return "hosting";
  return "consumer";
}

/** `198.51.100.7` becomes `7.100.51.198`, the order Team Cymru reads. */
function reverseIPv4(ip: string): string | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  if (parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  return parts.reverse().join(".");
}

/** `2001:db8::1` → the nibble-reversed form Team Cymru expects. */
function reverseIPv6(ip: string): string | null {
  const expanded = expandIPv6(ip.trim());
  if (expanded === null) return null;
  return expanded.split("").reverse().join(".");
}

function expandIPv6(ip: string): string | null {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === null || tail === "" ? [] : tail.split(":");
  if (headParts.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return null;
  if (tailParts.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))) return null;
  const groups =
    tail === null
      ? headParts
      : [...headParts, ...Array(8 - headParts.length - tailParts.length).fill("0"), ...tailParts];
  if (groups.length !== 8) return null;
  return groups.map((group) => group.padStart(4, "0").toLowerCase()).join("");
}

/** `"7018 | 99.44.0.0/14 | US | arin | 1992-12-01"` → the three fields we keep. */
export function parseCymruOrigin(
  answers: string[],
): { asn: number; prefix: string; country: string | null } | null {
  const text = answers.join(" ").trim();
  if (text === "") return null;
  const fields = text.split("|").map((field) => field.trim());
  if (fields.length < 2) return null;
  const asn = Number.parseInt(fields[0], 10);
  if (!Number.isInteger(asn) || asn <= 0) return null;
  const prefix = /^[0-9a-fA-F.:]+\/\d{1,3}$/.test(fields[1]) ? fields[1] : "";
  const country = fields[2] && /^[A-Za-z]{2}$/.test(fields[2]) ? fields[2].toUpperCase() : null;
  return { asn, prefix, country };
}

/** `"7018 | US | arin | 2000-03-30 | ATT-INTERNET4, US"` → the AS name. */
export function parseCymruName(answers: string[]): string | null {
  const text = answers.join(" ").trim();
  if (text === "") return null;
  const fields = text.split("|").map((field) => field.trim());
  if (fields.length < 5) return null;
  return fields[fields.length - 1] || null;
}

/** The cache key for an address: its /24 for IPv4, its /48 for IPv6. */
export function prefixKey(ip: string): string {
  const trimmed = ip.trim();
  if (reverseIPv4(trimmed) === null) {
    const expanded = expandIPv6(trimmed);
    return expanded === null ? trimmed : `${expanded.slice(0, 12)}`;
  }
  return trimmed.split(".").slice(0, 3).join(".");
}

export type TxtResolver = (name: string) => Promise<string[][]>;

export interface CymruOptions {
  resolveTxt?: TxtResolver;
  /** Shared between lookups so a process keeps one cache. */
  cache?: Map<string, AsnRecord>;
}

/**
 * The real classifier: Team Cymru over DNS. The origin query is authoritative and
 * its failure fails the whole lookup — that is the fail-closed rule. The AS-name
 * query decides whether an *unlisted* ASN is a consumer ISP, so its failure is
 * recorded as a missing name and `classifyAsn` refuses the exit rather than
 * defaulting to "consumer".
 */
export function cymruLookup(options: CymruOptions = {}): AsnLookup {
  const resolveTxt: TxtResolver =
    options.resolveTxt ??
    (async (name: string) => {
      const answers = await dns.resolveTxt(name);
      return answers;
    });
  const cache = options.cache ?? new Map<string, AsnRecord>();
  const names = new Map<number, string | null>();

  const nameFor = async (asn: number): Promise<string | null> => {
    if (names.has(asn)) return names.get(asn) ?? null;
    let name: string | null = null;
    try {
      const answers = (await resolveTxt(`AS${asn}.asn.cymru.com`)).map((entry) => entry.join(""));
      name = parseCymruName(answers);
    } catch {
      name = null;
    }
    names.set(asn, name);
    return name;
  };

  return async (ip: string): Promise<AsnRecord> => {
    const key = prefixKey(ip);
    const cached = cache.get(key);
    if (cached) return cached;

    const reversed = reverseIPv4(ip.trim()) ?? reverseIPv6(ip.trim());
    if (reversed === null) throw new Error(`cannot reverse ${ip}`);
    const answers = (await resolveTxt(`${reversed}.origin.asn.cymru.com`)).map((entry) =>
      entry.join(""),
    );
    const origin = parseCymruOrigin(answers);
    if (origin === null) throw new Error(`no origin answer for ${ip}`);
    const name = await nameFor(origin.asn);
    const record: AsnRecord = { ...origin, name };
    cache.set(key, record);
    return record;
  };
}
