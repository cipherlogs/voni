import { readFileSync } from "node:fs";
import {
  SCOREBOARD_SCHEMA_VERSION,
  parseGateRows,
  type ArtifactCaptureLeg,
  type ArtifactCaptures,
  type ArtifactPipeline,
  type ScoreboardArtifact,
} from "./scoreboard";

/**
 * The shared artifact reader (meta-cascade M12): the managed artifact and the
 * cascade artifact differ by a `pipeline` discriminator and by which capture
 * legs exist, not by a second vocabulary. This is the one module the local
 * readers in `scripts/` migrate to; none of them parse a second schema.
 */
export const ARTIFACT_PIPELINES: readonly ArtifactPipeline[] = ["managed", "cascade"];

export function isArtifactPipeline(value: unknown): value is ArtifactPipeline {
  return typeof value === "string" && (ARTIFACT_PIPELINES as readonly string[]).includes(value);
}

/** Capture legs an artifact may name; an unknown leg is refused, never guessed. */
export const ARTIFACT_CAPTURE_LEGS: readonly ArtifactCaptureLeg[] = ["reference", "platform", "delivered"];

export function isArtifactCaptureLeg(value: unknown): value is ArtifactCaptureLeg {
  return typeof value === "string" && (ARTIFACT_CAPTURE_LEGS as readonly string[]).includes(value);
}

/**
 * Event types only a cascade run can emit (M12). A managed artifact claiming
 * one is an invalid artifact: the managed path has no provider choice, breaker
 * or cascade budget to report.
 */
export const CASCADE_ONLY_EVENT_TYPES: readonly string[] = [
  "provider_fallback",
  "breaker.transition",
  "budget.crossing",
  "budget.stopped",
];

export function isCascadeOnlyEvent(type: string): boolean {
  return CASCADE_ONLY_EVENT_TYPES.includes(type);
}

/** One refused artifact, named by the field and the value that failed. */
export class ArtifactReadError extends Error {
  /** The label or path the artifact was read from. */
  readonly source: string;
  /** The field that failed, e.g. `schemaVersion` or `captures.platform`. */
  readonly field: string;
  /** Why it failed, with the offending value spelled out. */
  readonly reason: string;

  constructor(source: string, field: string, reason: string) {
    super(`${source}: ${reason}`);
    this.name = "ArtifactReadError";
    this.source = source;
    this.field = field;
    this.reason = reason;
  }
}

function showValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

/**
 * Read one artifact, whoever wrote it. Pure: the caller owns the bytes.
 *
 * The returned artifact keeps what was recorded (an absent `pipeline` stays
 * absent — `pipelineOfArtifact` reads it as `managed`) and its gate rows come
 * from the one shared gate validator.
 */
export function parseScoreboardArtifact(raw: unknown, source: string): ScoreboardArtifact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(source, "artifact", `not a scoreboard artifact object (${showValue(raw)})`);
  }
  const record = raw as Record<string, unknown>;

  // Never guessed, never coerced: `"4"` is not 4 and 99 is not "close enough".
  if (record.schemaVersion !== SCOREBOARD_SCHEMA_VERSION) {
    throw new ArtifactReadError(
      source,
      "schemaVersion",
      `unknown schemaVersion ${showValue(record.schemaVersion)}; this reader reads ${SCOREBOARD_SCHEMA_VERSION}`,
    );
  }
  if (
    typeof record.voice !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.recordedAt !== "string" ||
    !Array.isArray(record.gates) ||
    !Array.isArray(record.subScores)
  ) {
    throw new ArtifactReadError(
      source,
      "artifact",
      "missing voice/runId/recordedAt/schemaVersion/gates/subScores",
    );
  }

  const pipeline = pipelineOfArtifact(record as Pick<ScoreboardArtifact, "pipeline">, source);
  const captures = parseCaptures(record.captures, source);
  if (pipeline === "cascade" && captures?.platform) {
    throw new ArtifactReadError(
      source,
      "captures.platform",
      "cascade artifact claims a platform capture; the cascade carries {reference, delivered} only, so the platform leg must be N/A",
    );
  }

  const eventTypes = parseArtifactEventTypes(record.events, source);
  if (pipeline === "managed") {
    const cascadeOnly = eventTypes.find(isCascadeOnlyEvent);
    if (cascadeOnly !== undefined) {
      throw new ArtifactReadError(
        source,
        "events",
        `managed artifact carries the cascade-only event "${cascadeOnly}"; a fallback-contaminated run is not a managed run`,
      );
    }
  }

  return {
    ...(record as unknown as ScoreboardArtifact),
    gates: parseGateRows(record.gates, source),
  };
}

/**
 * The effective discriminator. An artifact written before the cascade has no
 * field and is a managed artifact (`subjectOrLegacy`'s precedent); a field that
 * is present but not a known pipeline is refused, not defaulted.
 */
export function pipelineOfArtifact(
  artifact: Pick<ScoreboardArtifact, "pipeline">,
  source = "artifact",
): ArtifactPipeline {
  if (artifact.pipeline === undefined) return "managed";
  if (!isArtifactPipeline(artifact.pipeline)) {
    throw new ArtifactReadError(
      source,
      "pipeline",
      `unknown pipeline ${showValue(artifact.pipeline)}; expected one of ${ARTIFACT_PIPELINES.join(", ")}`,
    );
  }
  return artifact.pipeline;
}

/**
 * Validate the readable capture record. A `null` leg is an explicit N/A (the
 * cascade's platform leg); a claimed leg names a file and its hash, never
 * audio bytes.
 */
function parseCaptures(raw: unknown, source: string): ArtifactCaptures | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactReadError(source, "captures", `captures is not an object (${showValue(raw)})`);
  }
  const record = raw as Record<string, unknown>;
  for (const [leg, capture] of Object.entries(record)) {
    if (!isArtifactCaptureLeg(leg)) {
      throw new ArtifactReadError(
        source,
        `captures.${leg}`,
        `unknown capture leg "${leg}"; expected one of ${ARTIFACT_CAPTURE_LEGS.join(", ")}`,
      );
    }
    if (capture === null) continue;
    const entry = capture as Record<string, unknown>;
    if (
      typeof capture !== "object" ||
      Array.isArray(capture) ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new ArtifactReadError(
        source,
        `captures.${leg}`,
        `capture leg "${leg}" needs path/sha256 (never audio bytes)`,
      );
    }
  }
  return record as ArtifactCaptures;
}

/** Validate the readable event list and return its types for the pipeline check. */
function parseArtifactEventTypes(raw: unknown, source: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ArtifactReadError(source, "events", `events is not an array (${showValue(raw)})`);
  }
  return raw.map((event, index) => {
    if (
      event === null ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      typeof (event as Record<string, unknown>).type !== "string"
    ) {
      throw new ArtifactReadError(source, `events.${index}`, `event ${index} needs a string type`);
    }
    return (event as Record<string, unknown>).type as string;
  });
}

/** Read and parse an artifact file; a bad file is named by its path. */
export function readScoreboardArtifactFile(path: string): ScoreboardArtifact {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ArtifactReadError(path, "file", `cannot read artifact (${(error as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ArtifactReadError(path, "file", `is not JSON (${(error as Error).message})`);
  }
  return parseScoreboardArtifact(raw, path);
}
