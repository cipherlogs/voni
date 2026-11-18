/**
 * What a URL must be before it may become a click target.
 *
 * Three callers need the same answer, so the rule lives here once: the seed
 * guard in `pool.ts` (a hand-edited `targets.json` must fail loudly at load),
 * the panel's add form (`addTarget` in `src/app/email/actions.ts`), and the
 * redirect-hop check in `click-simulator.ts`.
 *
 * The panel is the reason this is strict. A target added from the UI is
 * fetched by Grafana's probes every few minutes and, on "Run one click now",
 * by this server itself — so an `http:`, a credentialed URL, an unusual port or
 * a private address is surface with no caller. The private-range helpers are
 * moved from `click-simulator.ts` rather than copied: two tables of what is
 * "internal" is one table that gets forgotten.
 */

/** The same bound `parseClickReport` applies to a reported target. */
export const TARGET_URL_MAX_LENGTH = 2048;

/**
 * `www.example.com.` and `WWW.example.com` name the same host: the trailing dot
 * is the legal "root" form. Dropping exactly one keeps `example.com..` — which
 * is not an approved host — distinct.
 */
export function normaliseHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

function ipv4Octets(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Loopback, private, link-local, CGNAT, documentation and multicast space. */
function isPrivateIpv4([first, second]: number[]): boolean {
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 100 && second !== undefined && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 169 && second === 254) return true;
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && (second === 0 || second === 168)) return true;
  if (first === 198 && (second === 18 || second === 19 || second === 51)) {
    return true;
  }
  if (first === 203 && second === 0) return true;
  // 224/4 multicast, 240/4 reserved, and the limited broadcast address.
  return first >= 224;
}

function isPrivateIpv6(raw: string): boolean {
  const value = raw.toLowerCase();
  if (value === "::" || value === "::1") return true;

  // `URL` normalises an IPv4-mapped address to `::ffff:7f00:1`, so the
  // dotted form only appears if a caller hands the hostname over directly.
  const mapped = /^::ffff:(.+)$/.exec(value)?.[1];
  if (mapped !== undefined) {
    if (mapped.includes(".")) {
      const v4 = ipv4Octets(mapped);
      return v4 !== null && isPrivateIpv4(v4);
    }
    const groups = mapped.split(":");
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0]!, 16);
      const low = Number.parseInt(groups[1]!, 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
      }
    }
  }

  const first = Number.parseInt(value.split(":")[0] ?? "", 16);
  if (!Number.isFinite(first)) return false;
  // fc00::/7 unique-local, fe80::/10 link-local.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * Whether a hostname is an IP literal in a range this must never dial.
 *
 * Defence in depth: a host allowlist already refuses every literal the panel
 * did not add, so this only matters because the panel can add one.
 */
export function isPrivateIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isPrivateIpv6(hostname.slice(1, -1));
  }
  const v4 = ipv4Octets(hostname);
  return v4 !== null && isPrivateIpv4(v4);
}

/**
 * What is wrong with this entry, as a sentence for the operator, or `null`
 * when it may be a target.
 *
 * The message names the rule that failed, never the reason in network terms,
 * so the add form can show it verbatim: "the host is a private address" tells
 * the operator what to change; "invalid URL" does not.
 */
export function targetUrlProblem(entry: string): string | null {
  const value = entry.trim();
  if (value === "") return "the URL is empty.";
  if (value.length > TARGET_URL_MAX_LENGTH) {
    return `the URL is longer than ${TARGET_URL_MAX_LENGTH} characters.`;
  }
  if (/\s/.test(value)) return "the URL contains whitespace.";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "it is not an absolute URL (include https:// and the host).";
  }

  if (url.protocol !== "https:") return "it must use https://.";
  if (url.username !== "" || url.password !== "") {
    return "the URL carries a username or password; remove it.";
  }
  if (!url.hostname) return "it has no host.";
  if (url.port !== "" && url.port !== "443") {
    return "only the default https port (443) is allowed.";
  }

  const hostname = normaliseHostname(url.hostname);
  // The literal check comes first so an address gets the accurate sentence:
  // `[::1]` carries no dot either, and "not a public domain name" would send
  // the operator looking for the wrong mistake.
  if (isPrivateIpLiteral(hostname)) {
    return "the host is a private, loopback or otherwise non-public address.";
  }
  // `https://localhost/` and `https://intranet/` are single-label names: they
  // resolve only inside a network, never to a public site a click can land on.
  if (!hostname.includes(".")) {
    return "the host is not a public domain name.";
  }

  return null;
}

/** Throwing form, for the seed at module load and for `addTarget`'s backstop. */
export function assertEmailTargetUrl(entry: string): string {
  const problem = targetUrlProblem(entry);
  if (problem !== null) {
    throw new RangeError(`Invalid click target ${JSON.stringify(entry)}: ${problem}`);
  }
  return entry;
}
