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
 * Write `<configDir>/<name>.json` with the instance name, POOL_INDEX, and any
 * extra vars applied. Returns the absolute config path.
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
