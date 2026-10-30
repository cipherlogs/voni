/**
 * Which body a claim comes from (demo-cascade ticket 24).
 *
 * The scoreboard and readiness paths read two different bodies, and a reader
 * must be able to tell them apart:
 *
 * - the **managed** path judges the platform-served stored-agent body, read
 *   back through `GET /v1/agents/{id}` (`stored-agents.ts`). That read is
 *   managed-only: a cascade run has no stored agent, so the read says nothing
 *   about it.
 * - the **cascade** path judges the cascade call's own evidence — the end
 *   message / trace artifact. The body was the app-signed demo body
 *   (`cascade-body.ts`) delivered to the pipeline; it is not re-read from the
 *   platform.
 *
 * The claim strings below are quoted verbatim by `docs/agents/demo-scoreboard.md`
 * and pinned by `body-source.test.ts`, so a claim cannot silently lose its
 * source label.
 */

export const BODY_SOURCES = ["cascade", "managed"] as const;

export type BodySource = (typeof BODY_SOURCES)[number];

export const BODY_SOURCE_CLAIMS: Readonly<Record<BodySource, string>> = {
  cascade:
    "cascade: claims come from the cascade call's own evidence; the body was the app-signed demo body delivered to the pipeline, never a platform stored-agent read",
  managed:
    "managed: claims come from the platform-served stored-agent body; this is a managed-only read and never describes a cascade run",
};

/**
 * The body source an artifact's claim belongs to. An artifact with no pipeline
 * discriminator predates the cascade and was a managed run
 * (`pipelineOfArtifact` reads it the same way).
 */
export function bodySourceForPipeline(pipeline: string | undefined): BodySource {
  return pipeline === "cascade" ? "cascade" : "managed";
}

/** The one sentence to print beside a claim, chosen by its pipeline. */
export function bodySourceClaim(pipeline: string | undefined): string {
  return BODY_SOURCE_CLAIMS[bodySourceForPipeline(pipeline)];
}
