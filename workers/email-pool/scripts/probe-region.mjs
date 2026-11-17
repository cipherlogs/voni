#!/usr/bin/env node
/**
 * One-shot region-probe verifier.
 *
 * Calls GET /probe-region on one or every pool worker and prints, per worker,
 * where the Durable Object ran (trace colo) and where its outbound fetch
 * egressed (ipinfo geography). Exits 0 only when every probe produced at least
 * one of the two observations.
 *
 * The secret is read from --secret or POOL_SECRET and is never printed.
 */
import process from "node:process";

const USAGE = `Usage:
  node scripts/probe-region.mjs [--url <worker-url>]... [--hint <hint>] [--secret <secret>]

  --url     Worker base URL. Repeatable. Defaults to every URL in
            POOL_WORKER_URLS (comma-separated) when that is set.
  --hint    Durable Object location hint: wnam, enam, sam, apac, weur, eeur,
            oc, afr, me. Default: enam.
  --secret  Pool secret (x-pool-secret). Defaults to POOL_SECRET.

Exit code: 0 when every probe returned at least one of the two observations,
1 otherwise.

Environment:
  POOL_WORKER_URLS  Comma-separated worker base URLs to probe.
  POOL_SECRET       Shared pool secret.
  POOL_PROBE_HINT   Default hint when --hint is omitted.

Example:
  POOL_WORKER_URLS=https://email-pool-01.example.workers.dev \\
  POOL_SECRET=... node scripts/probe-region.mjs --hint enam
`;

const HINTS = ["wnam", "enam", "sam", "apac", "weur", "eeur", "oc", "afr", "me"];
const DEFAULT_HINT = "enam";
const REQUEST_TIMEOUT_MS = 15_000;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { urls: [], hint: null, secret: null, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, null];

    if (flag !== "--url" && flag !== "--hint" && flag !== "--secret") {
      fail(`Unknown argument: ${arg}\n\n${USAGE}`);
    }

    const value = inline ?? argv[i + 1];
    if (value === undefined || value === "") {
      fail(`${flag} needs a value\n\n${USAGE}`);
    }
    if (inline === null) i += 1;

    if (flag === "--url") options.urls.push(value);
    else if (flag === "--hint") options.hint = value;
    else options.secret = value;
  }

  return options;
}

function splitUrls(raw) {
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "");
}

function trimSlash(url) {
  return url.replace(/\/+$/, "");
}

/** The block header: the worker URL itself, so two local ports stay distinct. */
function labelOf(url) {
  return trimSlash(url);
}

/** Keep the secret out of every line we print, including error text. */
function makeScrubber(secret) {
  if (!secret) return (text) => text;
  return (text) => String(text).split(secret).join("[redacted]");
}

function verdict(probe) {
  const country = probe?.egress?.country;
  if (typeof country !== "string" || country === "") return "UNKNOWN";
  const normalized = country.toUpperCase();
  return normalized === "US" ? "US" : `NOT US (${normalized})`;
}

function describeErrors(probe) {
  const errors = probe?.errors;
  if (errors === null || typeof errors !== "object") return [];
  return Object.entries(errors).map(([source, code]) => `${source}=${code}`);
}

function printProbe(url, hint, body, elapsedMs) {
  const probe = body?.durableObject ?? null;
  const trace = probe?.trace ?? null;
  const egress = probe?.egress ?? null;

  const lines = [
    labelOf(url),
    `  invoking colo: ${body?.colo ?? "UNKNOWN"}   hint: ${body?.hint ?? hint}`,
    `  DO trace colo: ${trace?.colo ?? "—"}`,
  ];

  if (egress) {
    const place = [egress.city, egress.region, egress.country]
      .filter((part) => typeof part === "string" && part !== "")
      .join(", ");
    lines.push(
      `  egress: ${egress.ip}${place === "" ? "" : ` (${place})`}${
        egress.org ? ` org: ${egress.org}` : ""
      }`,
    );
  } else {
    lines.push("  egress: —");
  }

  lines.push(`  ms: ${probe?.ms ?? elapsedMs}`);

  const errors = describeErrors(probe);
  if (errors.length > 0) lines.push(`  errors: ${errors.join(", ")}`);
  if (body?.reason) lines.push(`  reason: ${body.reason}`);

  lines.push(`  verdict: ${verdict(probe)}`);

  process.stdout.write(`${lines.join("\n")}\n\n`);
}

async function probeOne(url, hint, secret, scrub) {
  const endpoint = `${trimSlash(url)}/probe-region?hint=${encodeURIComponent(hint)}`;
  const started = Date.now();

  let response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { "x-pool-secret": secret },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : String(error);
    process.stdout.write(
      `${labelOf(url)}\n  request failed: ${scrub(detail)}\n  verdict: UNKNOWN\n\n`,
    );
    return false;
  }

  const elapsedMs = Date.now() - started;

  let body;
  try {
    body = await response.json();
  } catch {
    process.stdout.write(
      `${labelOf(url)}\n  HTTP ${response.status}: response was not JSON\n  verdict: UNKNOWN\n\n`,
    );
    return false;
  }

  const probe = body?.durableObject ?? null;

  // Anything the route refused (401/400/503/502 unavailable) has no
  // durableObject: report why, once, without a probe block.
  if (probe === null) {
    const detail = body?.detail ? ` (${scrub(body.detail)})` : "";
    const reason = body?.reason ?? `HTTP ${response.status}`;
    process.stdout.write(
      `${labelOf(url)}\n  error: ${reason}${detail}\n  verdict: UNKNOWN\n\n`,
    );
    return false;
  }

  printProbe(url, hint, body, elapsedMs);
  return probe.trace != null || probe.egress != null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const hint = options.hint ?? process.env.POOL_PROBE_HINT ?? DEFAULT_HINT;
  if (!HINTS.includes(hint)) {
    fail(`Bad hint "${hint}". Expected one of: ${HINTS.join(", ")}`);
  }

  const urls =
    options.urls.length > 0
      ? options.urls
      : splitUrls(process.env.POOL_WORKER_URLS ?? "");
  if (urls.length === 0) {
    fail(`No worker URL. Pass --url or set POOL_WORKER_URLS.\n\n${USAGE}`);
  }

  const secret = options.secret ?? process.env.POOL_SECRET ?? "";
  if (secret === "") {
    fail("No secret. Pass --secret or set POOL_SECRET (it is never printed).");
  }

  const scrub = makeScrubber(secret);

  let allOk = true;
  for (const url of urls) {
    // Sequential: a shared 5s probe budget per object is easier to read one
    // worker at a time than interleaved.
    const ok = await probeOne(url, hint, secret, scrub);
    if (!ok) allOk = false;
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  fail(`probe-region failed: ${error instanceof Error ? error.message : String(error)}`);
});
