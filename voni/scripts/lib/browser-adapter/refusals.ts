/**
 * Startup refusals: the facts a certifying browser run cannot start without.
 *
 * A browser run is only certifying when it is the real stack. A fake pipeline,
 * a test build, a missing vendor key, a missing corpus, scenario, vendor build
 * or soundscape is refused by name with exit 2 before Chromium opens. So is a
 * stack whose dev capture sink is absent: without the delivered WAV and the
 * marks there is no evidence to certify, and a missing artifact is never a
 * short-but-valid run.
 *
 * Spec: `.scratch/demo-verification/spec.md`, "Commands and exit codes",
 * "One seam, two adapters" and residual risk RR-03.
 */

import { fileURLToPath } from "node:url";

import { loadCorpus, ScenarioError, type LoadedScenario } from "@/lib/demo/verification/scenarios";

import {
  PROTOCOL_REQUIRED_KEYS,
  PROTOCOL_REQUIRED_LEGS,
  defaultVendorBuildsPath,
  readVendorBuilds,
} from "../protocol-adapter/refusals";
import { QUIET_SOUNDSCAPE } from "../protocol-adapter/faults";
import { BrowserAdapterError } from "./errors";
import type {
  BrowserPreflight,
  BrowserPreflightInput,
  BrowserStackProbe,
  BrowserStackProbeResponse,
  BrowserTarget,
  MissingItem,
  VendorBuildRecord,
} from "./types";

export {
  PROTOCOL_REQUIRED_KEYS as BROWSER_REQUIRED_KEYS,
  PROTOCOL_REQUIRED_LEGS as BROWSER_REQUIRED_LEGS,
  defaultVendorBuildsPath,
  readVendorBuilds,
};

/** The test-build flags that must never certify: they are the e2e seam. */
export const TEST_BUILD_ENV = [
  "NEXT_PUBLIC_VONI_E2E_CAPTURE",
  "VONI_INSTANT_TEST_BUILD",
] as const;

/** The reserved host the PR e2e rig points the app at. */
export const FAKE_PIPELINE_HOST = "pipeline.invalid";

/** The app's dev marks route; a production build answers it with 404. */
export const MARKS_PROBE_PATH = "/api/dev/call-marks";

/** A loopback host: a local certificate is never true for a remote stack. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function present(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "";
}

/** A URL with a host, or a named refusal item. */
function parseUrl(
  value: string,
  what: string,
  missing: MissingItem[],
): URL | null {
  if (value.trim() === "") {
    missing.push({
      item: what,
      detail: `${what} is not set; a certifying run names the stack it certifies`,
    });
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    missing.push({
      item: what,
      detail: `${what} is not a URL: ${JSON.stringify(value)}`,
    });
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    missing.push({
      item: what,
      detail: `${what} uses ${url.protocol}; only http and https are callable`,
    });
    return null;
  }
  return url;
}

/**
 * A fake pipeline is a named refusal, never a URL the harness quietly talks to.
 * The two tells are the reserved `.invalid` host and the e2e capture build.
 */
export function fakePipelineReason(pipelineUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(pipelineUrl);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase().endsWith(".invalid") || url.hostname === FAKE_PIPELINE_HOST) {
    return (
      `the pipeline URL "${pipelineUrl}" is the reserved fake host; a certifying ` +
      "run needs the real pipeline, never the fake service"
    );
  }
  return null;
}

/** The e2e capture/test-build flags; one is present, the run is not the real build. */
export function testBuildReason(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const testFlags = TEST_BUILD_ENV.filter((name) => present(env, name));
  if (testFlags.length === 0) return null;
  return (
    `${testFlags.join(", ")} marks an e2e test build; a test build can never certify, ` +
    "because the certifying run must be the app a visitor gets"
  );
}

function defaultProbe(): BrowserStackProbe {
  return async (method, url) => {
    try {
      const response = await fetch(url, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : undefined,
        body: method === "POST" ? "{}" : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      let body: unknown = null;
      if (method === "GET") body = await response.json().catch(() => null);
      return { status: response.status, body };
    } catch (error) {
      throw new BrowserAdapterError(
        "pipeline-unreachable",
        `cannot reach ${method} ${url}: ${(error as Error).message}`,
      );
    }
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function probeStack(
  input: BrowserPreflightInput,
  app: URL,
  pipeline: URL,
  missing: MissingItem[],
): Promise<string | null> {
  const probe = input.probe ?? defaultProbe();
  const pipelineBase = pipeline.toString().replace(/\/$/, "");
  let health: BrowserStackProbeResponse;
  let ready: BrowserStackProbeResponse;
  try {
    health = await probe("GET", `${pipelineBase}/healthz`);
    ready = await probe("GET", `${pipelineBase}/readyz`);
  } catch (error) {
    missing.push({
      item: "pipeline-unreachable",
      detail:
        error instanceof BrowserAdapterError
          ? error.message
          : `the pipeline at ${pipelineBase} is not reachable: ${String(error)}`,
    });
    return null;
  }
  if (health.status !== 200) {
    missing.push({
      item: "pipeline-unreachable",
      detail: `the pipeline's /healthz answered ${health.status}; a certifying run needs a live service`,
    });
    return null;
  }
  const healthBody = recordOf(health.body);
  const build = typeof healthBody?.buildVersion === "string" ? healthBody.buildVersion : "";
  if (build.trim() === "" || build === "unversioned") {
    missing.push({
      item: "pipeline-build",
      detail:
        `${pipelineBase}/healthz reports ${JSON.stringify(build || null)}; a certificate records ` +
        "the pipeline image it ran, never `unversioned` (RR-03)",
    });
  }
  if (ready.status !== 200) {
    missing.push({
      item: "pipeline-unreachable",
      detail:
        `the pipeline's /readyz answered ${ready.status}; it is draining or unready and cannot ` +
        "start a call",
    });
  }
  const appBase = app.toString().replace(/\/$/, "");
  const page = await probe("GET", `${appBase}/`).catch(() => null);
  if (page === null || page.status !== 200) {
    missing.push({
      item: "app-unreachable",
      detail: `the app at ${appBase} answered ${page?.status ?? "nothing"}; a certifying run needs the real landing page`,
    });
  }
  const marks = await probe("POST", `${appBase}${MARKS_PROBE_PATH}`).catch(() => null);
  // Dev answers a malformed body with 400; a production build short-circuits
  // the route with 404. 404 is the named "no capture evidence" refusal.
  if (marks === null || marks.status === 404) {
    missing.push({
      item: "capture-unavailable",
      detail:
        `${appBase}${MARKS_PROBE_PATH} answers 404; the app is a production build without the ` +
        "dev capture sink, so this run could not read the delivered WAV or the marks",
    });
  } else if (marks.status !== 400) {
    missing.push({
      item: "capture-unavailable",
      detail:
        `${appBase}${MARKS_PROBE_PATH} answered ${marks.status} to the probe, not the dev route's ` +
        "400 for an invalid body",
    });
  }
  return build.trim() === "" || build === "unversioned" ? null : build;
}

function vendorBuildGaps(record: VendorBuildRecord | null, path: string): MissingItem[] {
  if (record === null) {
    return [
      {
        item: `vendor-builds:${path}`,
        detail:
          `the vendor-build record is missing at ${path}; a certificate must name the vendor ` +
          "builds it ran (RR-03)",
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
 * Preflight one certifying browser run. Every missing item is collected, then
 * the whole list is refused by name; a partially runnable preflight is still a
 * refusal.
 */
export async function preflightBrowserRun(
  input: BrowserPreflightInput,
): Promise<BrowserPreflight> {
  const missing: MissingItem[] = [];

  for (const name of PROTOCOL_REQUIRED_KEYS) {
    if (!present(input.env, name)) {
      missing.push({
        item: name,
        detail: `${name} is required for a real vendor call and is not set`,
      });
    }
  }

  const fake = fakePipelineReason(input.pipelineUrl);
  if (fake !== null) {
    missing.push({ item: "fake-pipeline", detail: fake });
  }
  const testBuild = testBuildReason(input.env);
  if (testBuild !== null) {
    missing.push({ item: "test-build", detail: testBuild });
  }

  if (input.target !== "local") {
    missing.push({
      item: "target",
      detail:
        `target "${input.target}" has no evidence sink: the delivered WAV and browser marks ` +
        "are written by the app's local dev capture path, so a remote target cannot be " +
        "certified without inventing evidence",
    });
  }

  const app = parseUrl(input.appUrl, "app-url", missing);
  const pipeline = parseUrl(input.pipelineUrl, "pipeline-url", missing);
  let target: BrowserTarget | null = null;
  if (app !== null && pipeline !== null) {
    const loopback = isLoopbackHost(app.hostname) && isLoopbackHost(pipeline.hostname);
    if (input.target === "local" && !loopback) {
      missing.push({
        item: "target-mismatch",
        detail:
          `a local certificate needs a loopback app and pipeline; got ${app.hostname} and ` +
          `${pipeline.hostname}`,
      });
    }
    if (pipeline.protocol !== "https:" && !isLoopbackHost(pipeline.hostname)) {
      missing.push({
        item: "target-invalid",
        detail: `the pipeline base must be https outside loopback; got ${pipeline.toString()}`,
      });
    }
    target = {
      appUrl: app.toString().replace(/\/$/, ""),
      pipelineUrl: pipeline.toString().replace(/\/$/, ""),
      local: loopback,
    };
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
          `scenario "${input.scenarioName}" is Locale "${scenario.locale}", but the run ` +
          `asked for "${input.locale}"`,
      });
    }
  }

  missing.push(...vendorBuildGaps(input.vendorBuilds, input.vendorBuildsPath));

  if (scenario !== null && scenario.soundscape.id !== QUIET_SOUNDSCAPE) {
    if (input.soundscapes[scenario.soundscape.id] === undefined) {
      missing.push({
        item: `soundscape:${scenario.soundscape.id}`,
        detail:
          `scenario "${scenario.name}" names soundscape "${scenario.soundscape.id}", but the ` +
          "run carries no 24 kHz PCM for it",
      });
    }
  }

  let pipelineBuild: string | null = null;
  if (missing.length === 0 && app !== null && pipeline !== null) {
    pipelineBuild = await probeStack(input, app, pipeline, missing);
  }

  if (
    missing.length > 0 ||
    target === null ||
    corpus === null ||
    scenario === null ||
    pipelineBuild === null
  ) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    vendorBuilds: input.vendorBuilds?.builds ?? [],
    corpus,
    scenario,
    target,
    pipelineBuild,
  };
}

/** The refusal code for a collected missing list; the first named cause wins. */
export function refusalCodeFor(
  missing: readonly MissingItem[],
): BrowserAdapterError["code"] {
  const items = missing.map((item) => item.item);
  if (items.some((item) => item === "fake-pipeline")) return "fake-pipeline";
  if (items.some((item) => item === "test-build")) return "test-build";
  if (items.some((item) => item.endsWith("_KEY") || item.endsWith("_SECRET"))) return "missing-key";
  if (items.some((item) => item.startsWith("vendor-build"))) return "missing-vendor-build";
  if (items.some((item) => item === "pipeline-build")) return "missing-vendor-build";
  if (items.some((item) => item === "capture-unavailable")) return "capture-unavailable";
  if (items.some((item) => item === "pipeline-unreachable")) return "pipeline-unreachable";
  if (items.some((item) => item === "app-unreachable")) return "app-unreachable";
  if (items.some((item) => item.startsWith("soundscape:"))) return "missing-soundscape";
  if (items.some((item) => item === "target" || item === "target-mismatch" || item === "target-invalid"))
    return "target-invalid";
  if (items.some((item) => item.startsWith("scenario:"))) return "missing-scenario";
  return "missing-corpus";
}

/** The corpus directory alias the runner prints in a refusal. */
export function corpusDirFrom(input: string | URL): string {
  return input instanceof URL ? fileURLToPath(input) : input;
}
