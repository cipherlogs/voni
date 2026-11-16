#!/usr/bin/env node
/**
 * Derive the pool's `ALLOWED_TARGET_HOSTS` from voni's email targets file, so
 * the operator edits exactly one file (`voni/src/lib/email/targets.json`) and
 * both `dev.mjs` and `deploy.mjs` pick the change up.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { projectRoot } from "./wrangler-bin.mjs";

export const TARGETS_FILE = resolve(
  projectRoot,
  "..",
  "..",
  "voni",
  "src",
  "lib",
  "email",
  "targets.json",
);

function parseTarget(entry) {
  if (typeof entry !== "string") {
    throw new Error(
      `Invalid email target entry ${JSON.stringify(entry)}: expected an absolute https URL string.`,
    );
  }
  let url;
  try {
    url = new URL(entry);
  } catch {
    throw new Error(
      `Invalid email target entry "${entry}": expected an absolute https URL (for example "https://voni.cc/test").`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `Invalid email target entry "${entry}": expected an absolute https URL, got protocol "${url.protocol}".`,
    );
  }
  return url;
}

/**
 * Pure: turn targets-file entries into the ordered, de-duplicated
 * `hostname[:port]` allowlist. `URL.host` already lower-cases the hostname and
 * drops the default port, so `https://A.test:443/x` yields `a.test`.
 */
export function hostsFromTargets(entries) {
  if (!Array.isArray(entries)) {
    throw new Error(
      `Email targets must be a JSON array of absolute https URLs, got ${typeof entries}.`,
    );
  }
  const hosts = [];
  const seen = new Set();
  for (const entry of entries) {
    const host = parseTarget(entry).host.toLowerCase();
    if (seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

/**
 * Read the targets file and return the comma-joined allowlist. A missing file
 * is an error, never a silent empty allowlist.
 */
export function allowlistFromTargetsFile(file = TARGETS_FILE) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `Email pool targets file not found: ${file}. The pool allowlist is derived from that file; create it with a JSON array of absolute https URLs.`,
      );
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Email pool targets file is not valid JSON: ${file} (${error.message}).`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Email pool targets file must contain a JSON array of absolute https URLs: ${file}.`,
    );
  }

  return hostsFromTargets(parsed).join(",");
}
