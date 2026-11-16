/**
 * Target validation for the email-pool worker.
 *
 * The worker is a fetch proxy, so the allowlist is the only thing standing
 * between it and an open proxy. This module is pure and has no I/O.
 */

export interface ValidateOptions {
  /** Exact `hostname[:port]` entries, lower-case, as configured in ALLOWED_TARGET_HOSTS. */
  allowedHosts: string[];
  /** Dev only: allow loopback / private IP literals. Prod leaves this false. */
  allowPrivate?: boolean;
}

export type ValidationResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string; detail: string };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that only make sense on a development machine. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function fail(reason: string, detail: string): ValidationResult {
  return { ok: false, reason, detail };
}

/** `hostname` from the URL parser keeps brackets on IPv6 literals. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function isPrivateIpv4(bytes: number[]): boolean {
  const [a, b] = bytes;
  // 0.0.0.0/8 (unspecified / this-network)
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 (carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const addr = stripBrackets(hostname).toLowerCase();
  if (addr === "::" || addr === "::1") return true;
  // IPv4-mapped / IPv4-compatible literals: ::ffff:127.0.0.1, ::127.0.0.1
  const mapped = addr.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) {
    const bytes = parseIpv4(mapped[1]);
    return bytes ? isPrivateIpv4(bytes) : false;
  }
  const firstHextet = addr.split(":")[0] ?? "";
  const first = Number.parseInt(firstHextet || "0", 16);
  if (!Number.isFinite(first)) return false;
  // fc00::/7 (unique local)
  if ((first & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local)
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}

/** True for IP literals in private / loopback / link-local ranges, and for loopback hostnames. */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(host) || host.endsWith(".localhost");
}

function normalizeAllowlist(allowedHosts: string[]): Set<string> {
  return new Set(
    allowedHosts
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * Validate a target URL against the pool contract.
 *
 * Checks, in order: parseable URL, http/https, no embedded credentials,
 * https unless the host is a loopback dev host on the allowlist, exact
 * `hostname:port` allowlist match, and no private/loopback IP literal unless
 * `allowPrivate` is set.
 */
export function validateTarget(
  rawUrl: unknown,
  options: ValidateOptions,
): ValidationResult {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return fail("invalid_url", "url must be a non-empty string");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail("invalid_url", "url could not be parsed");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return fail(
      "unsupported_protocol",
      `protocol ${url.protocol} is not allowed; use http or https`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    return fail("credentials", "url must not embed credentials");
  }

  const allowlist = normalizeAllowlist(options.allowedHosts);
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();

  const devHostAllowed =
    isLoopbackHostname(hostname) && allowlist.has(host);

  if (url.protocol === "http:" && !devHostAllowed) {
    return fail(
      "insecure_protocol",
      "http is only allowed for loopback dev hosts in the allowlist",
    );
  }

  if (!allowlist.has(host)) {
    return fail(
      "host_not_allowed",
      `host ${host} is not in ALLOWED_TARGET_HOSTS`,
    );
  }

  if (!options.allowPrivate && isPrivateHostname(hostname)) {
    return fail(
      "private_target",
      `host ${host} is a private/loopback address and ALLOW_PRIVATE_TARGETS is not true`,
    );
  }

  return { ok: true, url };
}
