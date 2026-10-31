/**
 * The corpus loader: one directory per scenario, discovered from disk, every
 * take hashed against the digest its scenario declares.
 *
 * There is no checked-in index of scenarios. Adding a corpus adds a directory
 * and its files; the only shared file is `manifest.json`, which carries the
 * comparability version and never the scenario list.
 *
 * A changed take is a refusal, not a new baseline: the run names the scenario
 * and take whose bytes no longer match, so a certificate can never silently
 * compare against audio nobody pinned.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex as sha256 } from "./digest";
import { ScenarioError } from "./errors";
import { parseCorpusManifest, parseScenario } from "./parse";
import {
  CORPUS_MANIFEST_FILE,
  CORPUS_SCHEMA_VERSION,
  SCENARIO_FILE,
  type Corpus,
  type CorpusReference,
  type LoadedScenario,
  type LoadedTake,
  type ScenarioDocument,
} from "./types";

/**
 * Where the committed corpora live. Ticket 12 adds the English corpus and
 * tickets 13–16 add the class and Locale directories under this root; this
 * loader never reads a list of them.
 */
export const DEFAULT_CORPUS_DIR = new URL("./corpus/", import.meta.url);

export type LoadCorpusOptions = {
  /** Every id the contract owns; a scenario citing anything else is refused. */
  readonly knownProperties: ReadonlySet<string> | Iterable<string>;
  /** Defaults to the committed corpus root. Tests and probe corpora pass one. */
  readonly dir?: URL | string;
};

/** Code-unit order, not locale order: a fingerprint may not depend on the host. */
function byCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rootPath(dir: URL | string): string {
  return dir instanceof URL ? fileURLToPath(dir) : dir;
}

async function readJson(path: string, code: "malformed-scenario" | "malformed-manifest"): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ScenarioError(
      "unreadable-corpus",
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ScenarioError(
      code,
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The fingerprint of one scenario: its validated record plus the actual bytes
 * of every take. Declaration order of takes is normalised; script order is not,
 * because the order the caller speaks is part of the scenario.
 */
function scenarioFingerprint(document: ScenarioDocument, takes: readonly LoadedTake[]): string {
  const canonical = {
    schemaVersion: document.schemaVersion,
    name: document.name,
    class: document.class,
    locale: document.locale,
    heldOut: document.heldOut,
    expectedProperties: document.expectedProperties,
    soundscape: document.soundscape,
    faults: document.faults,
    takes: [...takes]
      .sort((left, right) => byCodepoint(left.id, right.id))
      .map((take) => ({
        id: take.id,
        audio: take.audio,
        sha256: take.sha256,
        bytes: take.bytes,
        ...(take.text === undefined ? {} : { text: take.text }),
      })),
    script: document.script,
  };
  return sha256(JSON.stringify(canonical));
}

/** Hash every declared take and refuse a missing, empty, escaping or drifted file. */
async function loadTakes(
  scenarioDir: string,
  document: ScenarioDocument,
): Promise<LoadedTake[]> {
  const loaded: LoadedTake[] = [];
  for (const take of document.takes) {
    const path = resolve(scenarioDir, take.audio);
    if (path !== scenarioDir && !path.startsWith(`${scenarioDir}${sep}`)) {
      throw new ScenarioError(
        "unsafe-take-path",
        `scenario "${document.name}" take "${take.id}" resolves outside its directory: ${path}`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new ScenarioError(
        missing ? "missing-take" : "unreadable-corpus",
        `scenario "${document.name}" take "${take.id}" is ${missing ? "missing" : "unreadable"}: ${path}. ` +
          "A take is a committed corpus file; record it before the scenario runs.",
      );
    }
    if (bytes.byteLength === 0) {
      throw new ScenarioError(
        "empty-take",
        `scenario "${document.name}" take "${take.id}" is empty: ${path}. An empty take has nothing to speak and no hash to compare.`,
      );
    }
    const actual = sha256(bytes);
    if (actual !== take.sha256) {
      throw new ScenarioError(
        "take-drift",
        `scenario "${document.name}" take "${take.id}" changed: declared sha256 ${take.sha256}, ` +
          `file ${path} is ${actual}. Retaking a line means updating its digest and the corpus version deliberately.`,
      );
    }
    loaded.push({ ...take, path, bytes: bytes.byteLength });
  }
  return loaded;
}

async function loadScenarioDir(
  dir: string,
  knownProperties: ReadonlySet<string>,
): Promise<LoadedScenario> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    throw new ScenarioError(
      "unreadable-corpus",
      `cannot read scenario directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!entries.includes(SCENARIO_FILE)) {
    throw new ScenarioError(
      "missing-scenario",
      `scenario directory ${dir} has no ${SCENARIO_FILE}; every scenario directory is one scenario`,
    );
  }
  const raw = await readJson(join(dir, SCENARIO_FILE), "malformed-scenario");
  let document: ScenarioDocument;
  try {
    document = parseScenario(raw, { knownProperties });
  } catch (error) {
    if (error instanceof ScenarioError) {
      throw new ScenarioError(error.code, `${join(dir, SCENARIO_FILE)}: ${error.message}`);
    }
    throw error;
  }
  const takes = await loadTakes(dir, document);
  return { ...document, directory: dir, takes, fingerprint: scenarioFingerprint(document, takes) };
}

/** Discover and validate the corpus under `dir`. */
export async function loadCorpus(options: LoadCorpusOptions): Promise<Corpus> {
  // Absolute root: the take-path containment check compares resolved paths, so
  // a relative corpus path must not make every take look like an escape.
  const root = resolve(rootPath(options.dir ?? DEFAULT_CORPUS_DIR));
  const knownProperties = new Set(options.knownProperties);

  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new ScenarioError(
      "unreadable-corpus",
      `cannot read the corpus at ${root}: ${error instanceof Error ? error.message : String(error)}. ` +
        "A missing corpus is a named refusal, never a run over zero scenarios.",
    );
  }

  const manifestEntry = entries.find((entry) => entry.name === CORPUS_MANIFEST_FILE);
  if (!manifestEntry || !manifestEntry.isFile()) {
    throw new ScenarioError(
      "missing-manifest",
      `corpus ${root} has no ${CORPUS_MANIFEST_FILE}; the corpus version must be explicit`,
    );
  }
  const manifest = parseCorpusManifest(await readJson(join(root, CORPUS_MANIFEST_FILE), "malformed-manifest"));

  const scenarioDirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === CORPUS_MANIFEST_FILE) continue;
    if (!entry.isDirectory()) {
      throw new ScenarioError(
        "unexpected-corpus-entry",
        `corpus ${root} holds unexpected entry "${entry.name}"; the root carries ${CORPUS_MANIFEST_FILE} and one directory per scenario`,
      );
    }
    scenarioDirs.push(entry.name);
  }
  scenarioDirs.sort();
  if (scenarioDirs.length === 0) {
    throw new ScenarioError(
      "empty-corpus",
      `corpus ${root} holds no scenario directory; a run over zero scenarios measures nothing`,
    );
  }

  const scenarios: LoadedScenario[] = [];
  const byName = new Map<string, string>();
  for (const name of scenarioDirs) {
    const dir = join(root, name);
    const scenario = await loadScenarioDir(dir, knownProperties);
    const previous = byName.get(scenario.name);
    if (previous) {
      throw new ScenarioError(
        "duplicate-scenario",
        `scenario name "${scenario.name}" is declared twice: ${previous} and ${dir}; one directory per scenario`,
      );
    }
    byName.set(scenario.name, dir);
    scenarios.push(scenario);
  }

  const fingerprint = sha256(
    JSON.stringify({
      schemaVersion: CORPUS_SCHEMA_VERSION,
      version: manifest.version,
      scenarios: scenarios
        .map((scenario) => ({ name: scenario.name, fingerprint: scenario.fingerprint }))
        .sort((left, right) => byCodepoint(left.name, right.name)),
    }),
  );

  return { version: manifest.version, fingerprint, scenarios };
}

/** What a certificate cites: the corpus version and the hash of its exact bytes. */
export function corpusReference(corpus: Corpus): CorpusReference {
  return { version: corpus.version, sha256: corpus.fingerprint };
}
