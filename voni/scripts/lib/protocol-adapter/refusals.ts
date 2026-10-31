/**
 * Startup refusals: the facts a protocol run cannot start without.
 *
 * The preflight names every missing item at once — a vendor key, the corpus, the
 * selected scenario and the recorded vendor builds — and returns exit 2. It does
 * not choose a default, did not skip the item and never starts a run that could
 * only report an unmeasured green.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Commands and exit codes" and
 * residual risk RR-03 (an unrecorded vendor build refuses the run).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadCorpus, ScenarioError, type LoadedScenario } from "@/lib/demo/verification/scenarios";

import { resolveTargets, RealLegsError } from "../real-legs";
import { ProtocolAdapterError } from "./errors";
import { QUIET_SOUNDSCAPE } from "./faults";
import {
  DEFAULT_VENDOR_BUILDS_PATH,
  type MissingItem,
  type ProtocolPreflight,
  type ProtocolPreflightInput,
  type VendorBuildEntry,
  type VendorBuildRecord,
} from "./types";

/** The vendor keys the real legs need. The envelope secret binds body and token. */
export const PROTOCOL_REQUIRED_KEYS = [
  "META_API_KEY",
  "ASSEMBLYAI_API_KEY",
  "VOICE_PIPELINE_ENVELOPE_SECRET",
] as const;

/** The legs a certificate records; the protocol run needs the same three. */
export const PROTOCOL_REQUIRED_LEGS = ["stt", "tts", "llm"] as const;

/** The committed record's absolute path, resolved from this module. */
export function defaultVendorBuildsPath(): string {
  return fileURLToPath(new URL(DEFAULT_VENDOR_BUILDS_PATH, import.meta.url));
}

function present(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "";
}

/** Read the committed vendor-build record; a missing file is `null`, not `{}`. */
export async function readVendorBuilds(path: string): Promise<VendorBuildRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProtocolAdapterError(
      "invalid-vendor-builds",
      `cannot read the vendor-build record ${path}: ${String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ProtocolAdapterError(
      "invalid-vendor-builds",
      `${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolAdapterError(
      "invalid-vendor-builds",
      `${path} must be an object with schemaVersion and builds`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new ProtocolAdapterError(
      "invalid-vendor-builds",
      `${path} declares schemaVersion ${JSON.stringify(record.schemaVersion)}; this reader reads 1`,
    );
  }
  if (!Array.isArray(record.builds)) {
    throw new ProtocolAdapterError(
      "invalid-vendor-builds",
      `${path} carries no builds array`,
    );
  }
  const builds: VendorBuildEntry[] = [];
  for (const [index, entry] of record.builds.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new ProtocolAdapterError(
        "invalid-vendor-builds",
        `${path} builds[${index}] is not an object`,
      );
    }
    const build = entry as Record<string, unknown>;
    const leg = build.leg;
    if (leg !== "stt" && leg !== "tts" && leg !== "llm" && leg !== "judge") {
      throw new ProtocolAdapterError(
        "invalid-vendor-builds",
        `${path} builds[${index}].leg is ${JSON.stringify(leg)}; expected stt, tts, llm or judge`,
      );
    }
    for (const field of ["vendor", "model", "buildId"] as const) {
      if (typeof build[field] !== "string" || build[field].trim() === "") {
        throw new ProtocolAdapterError(
          "invalid-vendor-builds",
          `${path} builds[${index}].${field} must name the recorded value`,
        );
      }
    }
    const buildId = build.buildId as string;
    if (buildId === "unknown") {
      throw new ProtocolAdapterError(
        "invalid-vendor-builds",
        `${path} builds[${index}] records buildId "unknown"; an unrecorded build refuses the run (RR-03)`,
      );
    }
    builds.push({
      leg,
      vendor: build.vendor as string,
      model: build.model as string,
      buildId,
    });
  }
  return { schemaVersion: 1, builds };
}

function vendorBuildGaps(record: VendorBuildRecord | null, path: string): MissingItem[] {
  if (record === null) {
    return [
      {
        item: `vendor-builds:${path}`,
        detail:
          `the vendor-build record is missing at ${path}; the certificate and the diagnosis ` +
          "must name the vendor builds they ran (RR-03)",
      },
    ];
  }
  const byLeg = new Map(record.builds.map((build) => [build.leg, build]));
  const gaps: MissingItem[] = [];
  for (const leg of PROTOCOL_REQUIRED_LEGS) {
    const build = byLeg.get(leg);
    if (build === undefined) {
      gaps.push({
        item: `vendor-build:${leg}`,
        detail: `the vendor-build record ${path} has no build for leg "${leg}"`,
      });
    } else if (build.buildId.trim() === "" || build.buildId === "unknown") {
      gaps.push({
        item: `vendor-build:${leg}`,
        detail: `the vendor-build record ${path} records no usable build id for leg "${leg}"`,
      });
    }
  }
  const duplicated = record.builds
    .map((build) => build.leg)
    .filter((leg, index, legs) => legs.indexOf(leg) !== index);
  for (const leg of new Set(duplicated)) {
    gaps.push({
      item: `vendor-build:${leg}`,
      detail: `the vendor-build record ${path} names leg "${leg}" more than once`,
    });
  }
  return gaps;
}

function corpusGap(error: unknown, dir: string): MissingItem {
  if (error instanceof ScenarioError) {
    const item =
      error.code === "missing-manifest" || error.code === "unreadable-corpus"
        ? `corpus:${dir}`
        : error.code === "missing-take" || error.code === "take-drift" || error.code === "empty-take"
          ? `corpus-take:${dir}`
          : `corpus:${dir}`;
    return { item, detail: error.message };
  }
  return { item: `corpus:${dir}`, detail: String(error) };
}

/**
 * Preflight one diagnosis run. Every missing item is collected, then the whole
 * list is refused by name; a partially runnable preflight is still a refusal.
 */
export async function preflight(input: ProtocolPreflightInput): Promise<ProtocolPreflight> {
  const missing: MissingItem[] = [];

  for (const name of PROTOCOL_REQUIRED_KEYS) {
    if (!present(input.env, name)) {
      missing.push({
        item: name,
        detail: `${name} is required for a real vendor call and is not set`,
      });
    }
  }

  let target;
  try {
    target = resolveTargets(input.targetUrl);
  } catch (error) {
    missing.push({
      item: "target",
      detail:
        error instanceof RealLegsError
          ? `${error.code}: ${error.message}`
          : String(error),
    });
    target = null;
  }

  let corpus = null;
  try {
    corpus = await loadCorpus({
      dir: input.corpusDir,
      knownProperties: input.knownProperties,
    });
  } catch (error) {
    missing.push(corpusGap(error, String(input.corpusDir)));
  }

  let scenario: LoadedScenario | null = null;
  if (corpus !== null) {
    scenario = corpus.scenarios.find((entry) => entry.name === input.scenarioName) ?? null;
    if (scenario === null) {
      missing.push({
        item: `scenario:${input.scenarioName}`,
        detail:
          `the corpus at ${String(input.corpusDir)} has no scenario "${input.scenarioName}"; ` +
          `available: ${corpus.scenarios.map((entry) => entry.name).join(", ") || "(none)"}`,
      });
    } else if (input.locale !== undefined && scenario.locale !== input.locale) {
      missing.push({
        item: `scenario:${input.scenarioName}:locale`,
        detail:
          `scenario "${input.scenarioName}" is Locale "${scenario.locale}", ` +
          `but the run asked for "${input.locale}"`,
      });
    }
  }

  missing.push(...vendorBuildGaps(input.vendorBuilds, input.vendorBuildsPath));

  if (scenario !== null && scenario.soundscape.id !== QUIET_SOUNDSCAPE) {
    if (input.soundscapes[scenario.soundscape.id] === undefined) {
      missing.push({
        item: `soundscape:${scenario.soundscape.id}`,
        detail:
          `scenario "${scenario.name}" names soundscape "${scenario.soundscape.id}", ` +
          "but the run carries no 24 kHz PCM for it",
      });
    }
  }

  if (missing.length > 0 || target === null || corpus === null || scenario === null) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    vendorBuilds: input.vendorBuilds?.builds ?? [],
    corpus,
    scenario,
    target: { httpBase: target.httpBase, wsUrl: target.wsUrl, local: target.local },
  };
}
