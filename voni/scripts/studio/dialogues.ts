/**
 * Scripted dialogues for the Record surface: a list of prompt cards, in the
 * order the caller speaks them.
 *
 * A dialogue is data, authored by a human, and it is validated by name before
 * the surface shows it: a typo in a field, an unknown Locale, a duplicate line
 * id or a blank card is refused rather than rendered as a prompt nobody meant.
 * The file is never written by the Studio; the owner authors it and commits it
 * when a scenario starts using its takes.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { LOCALES, type Locale } from "../../src/lib/demo/verification/scenarios/types";
import { StudioError } from "./take-store";

export const DIALOGUE_SCHEMA_VERSION = 1;

export type DialogueTurn = {
  /** Stable id the landed take cites as its prompt card's line. */
  readonly line: string;
  /** The words the caller is asked to read. */
  readonly text: string;
  /** 1-based position in the dialogue; the surface walks these in order. */
  readonly turn: number;
};

export type DialogueScript = {
  readonly schemaVersion: typeof DIALOGUE_SCHEMA_VERSION;
  readonly name: string;
  readonly locale: Locale;
  readonly turns: readonly DialogueTurn[];
};

const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const FIELDS = ["schemaVersion", "name", "locale", "turns"] as const;
const TURN_FIELDS = ["line", "text"] as const;

function asRecord(value: unknown, from: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StudioError("malformed-dialogue", `${from} must be an object`);
  }
  return value as Record<string, unknown>;
}

function refuseUnknown(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new StudioError("malformed-dialogue", `${what} carries unknown field "${key}"; allowed: ${allowed.join(", ")}`);
    }
  }
}

/** Validate one authored dialogue; `from` names the file in every refusal. */
export function parseDialogue(raw: unknown, from: string): DialogueScript {
  const document = asRecord(raw, from);
  refuseUnknown(document, FIELDS, from);
  if (document.schemaVersion !== DIALOGUE_SCHEMA_VERSION) {
    throw new StudioError(
      "malformed-dialogue",
      `${from} has schema version ${String(document.schemaVersion)}; this Studio reads ${DIALOGUE_SCHEMA_VERSION}`,
    );
  }
  const name = document.name;
  if (typeof name !== "string" || !SAFE_NAME.test(name)) {
    throw new StudioError("malformed-dialogue", `${from} has an invalid dialogue name ${JSON.stringify(name)}`);
  }
  const locale = document.locale;
  if (typeof locale !== "string" || !(LOCALES as readonly string[]).includes(locale)) {
    throw new StudioError(
      "malformed-dialogue",
      `${from} declares Locale ${JSON.stringify(locale)}; the contract's Locales are ${LOCALES.join(", ")}`,
    );
  }
  if (!Array.isArray(document.turns) || document.turns.length === 0) {
    throw new StudioError("malformed-dialogue", `${from} has no turns; a dialogue with no prompt card records nothing`);
  }
  const seen = new Set<string>();
  const turns: DialogueTurn[] = [];
  document.turns.forEach((rawTurn, index) => {
    const turn = asRecord(rawTurn, `${from} turn ${index + 1}`);
    refuseUnknown(turn, TURN_FIELDS, `${from} turn ${index + 1}`);
    const line = turn.line;
    if (typeof line !== "string" || !SAFE_NAME.test(line)) {
      throw new StudioError("malformed-dialogue", `${from} turn ${index + 1} has an invalid line id ${JSON.stringify(line)}`);
    }
    if (seen.has(line)) {
      throw new StudioError("malformed-dialogue", `${from} declares line "${line}" twice; a take must cite one card`);
    }
    seen.add(line);
    const text = turn.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new StudioError("malformed-dialogue", `${from} turn ${index + 1} ("${line}") has no prompt text`);
    }
    turns.push({ line, text: text.trim(), turn: index + 1 });
  });
  return { schemaVersion: DIALOGUE_SCHEMA_VERSION, name, locale: locale as Locale, turns };
}

/**
 * Read every `*.json` script in `dir`. A missing directory means "no scripts
 * authored yet", not an error: the surface still records one-shot lines and
 * uploads. A malformed script is a named refusal.
 */
export async function loadDialogues(dir: string): Promise<DialogueScript[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new StudioError("unreadable-dialogue", `cannot read the dialogue directory ${dir}: ${errorText(error)}`);
  }
  const scripts: DialogueScript[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || !entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      throw new StudioError("unreadable-dialogue", `cannot read dialogue script ${path}: ${errorText(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new StudioError("malformed-dialogue", `${path} is not valid JSON: ${errorText(error)}`);
    }
    const script = parseDialogue(parsed, path);
    if (`${script.name}.json` !== entry) {
      throw new StudioError("malformed-dialogue", `${path} declares dialogue "${script.name}"; the file name and the script disagree`);
    }
    scripts.push(script);
  }
  return scripts;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
