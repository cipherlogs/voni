/**
 * Record the committed caller takes for the scenario corpus.
 *
 * The corpus is not hand-written audio: this tool synthesizes each take's
 * `text` through the caller voice, writes the WAV beside its scenario and
 * records the sha256 in `scenario.json`. Run it once when a take is authored.
 *
 * Re-running is a no-op for recorded takes. A changed byte refuses by name,
 * because comparability must not move silently; replacing one is
 * `--retake <scenario>/<take>`, which bumps the corpus manifest version.
 *
 * Usage:
 *   npm run corpus:takes
 *   npm run corpus:takes -- --scenario tools-email-send
 *   npm run corpus:takes -- --retake tools-email-send/tag
 *   npm run corpus:takes -- --dry-run
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadContract } from "@/lib/demo/verification/contract";
import {
  ScenarioError,
  applyTakeGeneration,
  loadCorpus,
  parseCorpusManifest,
  parseScenario,
  planTakeGeneration,
  synthesizeCartesia,
  type ScenarioDocument,
} from "@/lib/demo/verification/scenarios";

const CORPUS_DIR = fileURLToPath(
  new URL("../src/lib/demo/verification/scenarios/corpus/", import.meta.url),
);
const MANIFEST = "manifest.json";

type Args = {
  readonly scenarios: readonly string[];
  readonly retakes: readonly string[];
  readonly dryRun: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const scenarios: string[] = [];
  const retakes: string[] = [];
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--scenario" || token === "--retake") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ScenarioError("missing-field", `${token} needs a value`);
      }
      (token === "--scenario" ? scenarios : retakes).push(value);
      index += 1;
      continue;
    }
    throw new ScenarioError(
      "missing-field",
      `unknown flag "${token}"; the generator takes --scenario, --retake and --dry-run`,
    );
  }
  return { scenarios, retakes, dryRun };
}

async function scenarioFiles(): Promise<string[]> {
  const entries = await readdir(CORPUS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

async function readManifestVersion(): Promise<number> {
  const raw = JSON.parse(await readFile(join(CORPUS_DIR, MANIFEST), "utf8")) as unknown;
  return parseCorpusManifest(raw).version;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.CARTESIA_API_KEY ?? "").trim();
  if (!args.dryRun && apiKey === "") {
    throw new ScenarioError(
      "tts-failed",
      "CARTESIA_API_KEY is not set; the committed takes are generated with the real caller " +
        "voice, never a placeholder. Set it in voni/.env.local or the environment.",
    );
  }

  const contract = await loadContract();
  const knownProperties = new Set(contract.properties.map((property) => property.id));
  const available = await scenarioFiles();
  const selected =
    args.scenarios.length === 0
      ? available
      : available.filter((name) => args.scenarios.includes(name));
  const unknownScenarios = args.scenarios.filter((name) => !available.includes(name));
  if (unknownScenarios.length > 0) {
    throw new ScenarioError(
      "missing-fast-scenario",
      `--scenario names ${unknownScenarios.join(", ")}, which ${CORPUS_DIR} does not hold; ` +
        `available: ${available.join(", ")}`,
    );
  }
  if (selected.length === 0) {
    throw new ScenarioError(
      "empty-corpus",
      `the corpus at ${CORPUS_DIR} holds no scenario directory; author one before recording takes`,
    );
  }

  const retakes = new Set(args.retakes);
  const documents = new Map<string, ScenarioDocument>();
  for (const name of selected) {
    const path = join(CORPUS_DIR, name, "scenario.json");
    const document = parseScenario(JSON.parse(await readFile(path, "utf8")) as unknown, {
      knownProperties,
    });
    documents.set(name, document);
  }

  if (args.dryRun) {
    let drift = 0;
    for (const [name, document] of documents) {
      const plan = await planTakeGeneration(join(CORPUS_DIR, name), document);
      for (const entry of plan) {
        console.log(`${entry.retake}: ${entry.state} (${entry.declaredSha256.slice(0, 12)})`);
        if (entry.state === "drift" || entry.state === "missing") drift += 1;
      }
    }
    if (drift > 0) process.exitCode = 2;
    return;
  }

  let versionBump = 0;
  let wrote = 0;
  for (const [name, document] of documents) {
    const result = await applyTakeGeneration({
      scenarioDir: join(CORPUS_DIR, name),
      document,
      synthesize: (text) => synthesizeCartesia({ text, apiKey }),
      retake: retakes,
    });
    if (result.wrote > 0) {
      await writeFile(
        join(CORPUS_DIR, name, "scenario.json"),
        `${JSON.stringify(result.document, null, 2)}\n`,
      );
      for (const take of result.document.takes) {
        const before = result.plan.find((candidate) => candidate.take === take.id);
        if (before === undefined || before.declaredSha256 === take.sha256) continue;
        console.log(`${name}/${take.id}: recorded ${take.audio} sha256=${take.sha256}`);
      }
    }
    wrote += result.wrote;
    versionBump += result.versionBump;
  }

  if (versionBump > 0) {
    const version = (await readManifestVersion()) + versionBump;
    await writeFile(
      join(CORPUS_DIR, MANIFEST),
      `${JSON.stringify({ schemaVersion: 1, version }, null, 2)}\n`,
    );
    console.log(`corpus manifest version -> ${version} (a deliberate retake moved comparability)`);
  }

  // A recorded corpus must load, hashes included, before the tool claims success.
  const corpus = await loadCorpus({ dir: CORPUS_DIR, knownProperties });
  console.log(
    `corpus version ${corpus.version}: ${corpus.scenarios.length} scenarios, ` +
      `${corpus.scenarios.reduce((sum, scenario) => sum + scenario.takes.length, 0)} takes, ` +
      `${wrote} recorded this run`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ScenarioError) {
    console.error(`corpus:takes refused (${error.code}): ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error);
  process.exit(1);
});
