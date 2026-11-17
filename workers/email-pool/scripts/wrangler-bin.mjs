#!/usr/bin/env node
/**
 * Shared helpers: locate wrangler, size the pool, and generate per-instance
 * configs from wrangler.jsonc.
 *
 * `wrangler deploy` and `wrangler dev` both accept `--config`, so the instance
 * name / POOL_INDEX override lives in a generated JSON file rather than in
 * `--var`, whose values are comma-split by wrangler.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const candidates = [
  join(projectRoot, "node_modules", ".bin", "wrangler"),
  resolve(projectRoot, "..", "..", "voni", "node_modules", ".bin", "wrangler"),
];

export function wranglerBin() {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "wrangler not found. Run `npm install` in workers/email-pool, or install voni's dependencies (../../voni/node_modules).",
  );
}

export function poolSize() {
  const raw = process.env.EMAIL_POOL_SIZE ?? "3";
  const size = Number.parseInt(raw, 10);
  if (!Number.isFinite(size) || size < 1) {
    throw new Error(`EMAIL_POOL_SIZE must be a positive integer, got "${raw}"`);
  }
  return size;
}

export function instanceName(prefix, index) {
  return `${prefix}-${String(index + 1).padStart(2, "0")}`;
}

/**
 * Location hints the worker can pin a click object to. Kept in sync with
 * `REGION_HINTS` in src/region-probe.ts (this file is plain ESM, so it cannot
 * import the TypeScript module that the worker runtime compiles).
 */
export const REGION_HINTS = [
  "wnam",
  "enam",
  "sam",
  "apac",
  "weur",
  "eeur",
  "oc",
  "afr",
  "me",
];

/**
 * Default per-instance placement: US east, US west, western Europe. Chosen so a
 * three-instance pool spreads across the regions voni measures from.
 */
export const DEFAULT_REGION_HINTS = ["enam", "wnam", "weur"];

/**
 * Hint list from EMAIL_POOL_REGION_HINTS. An unknown entry fails by name rather
 * than being dropped or silently defaulted — a typo would otherwise deploy a
 * pool pinned somewhere nobody asked for.
 */
export function regionHints() {
  const raw = process.env.EMAIL_POOL_REGION_HINTS;
  const source = raw === undefined || raw.trim() === "" ? "" : raw;
  const list =
    source === ""
      ? [...DEFAULT_REGION_HINTS]
      : source
          .split(",")
          .map((hint) => hint.trim())
          .filter((hint) => hint !== "");

  if (list.length === 0) {
    throw new Error(
      `EMAIL_POOL_REGION_HINTS has no hints; known: ${REGION_HINTS.join(", ")}`,
    );
  }

  const unknown = list.filter((hint) => !REGION_HINTS.includes(hint));
  if (unknown.length > 0) {
    throw new Error(
      `EMAIL_POOL_REGION_HINTS has unknown hint(s): ${unknown.join(", ")}; known: ${REGION_HINTS.join(", ")}`,
    );
  }

  return list;
}

/** Instance i gets the hint at i % list.length, so the pool cycles the list. */
export function regionHintFor(index, hints = regionHints()) {
  return hints[index % hints.length];
}

/** Minimal JSONC comment stripper that respects string literals. */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }

  return out;
}

export function readBaseConfig() {
  const raw = readFileSync(join(projectRoot, "wrangler.jsonc"), "utf8");
  const base = JSON.parse(stripJsonComments(raw));
  return { ...base, main: resolve(projectRoot, base.main ?? "src/index.ts") };
}

/**
 * Write `<configDir>/<name>.json` with the instance name, POOL_INDEX, the
 * per-instance POOL_REGION_HINT, and any extra vars applied. Returns the
 * absolute config path.
 *
 * Everything else in the base config is copied verbatim — including both
 * `durable_objects.bindings` entries (POOL_REGION / POOL_CLICK) and both
 * migrations (v1 RegionProbe, v2 PinnedClick), so each instance gets the same
 * object classes as the base file.
 */
export function writeInstanceConfig(configDir, base, { name, index, vars = {} }) {
  mkdirSync(configDir, { recursive: true });
  const config = {
    ...base,
    name,
    vars: { ...(base.vars ?? {}), POOL_INDEX: String(index), ...vars },
  };
  const configPath = join(configDir, `${name}.json`);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}
