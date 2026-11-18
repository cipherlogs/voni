/**
 * The burst run's k6 `options`, as a transform of the generated click script.
 *
 * The committed script (`scripts/affiliate-click-check.k6.js`) is the Grafana
 * check: one click per iteration, no fixed VUs or duration, no load-zone
 * distribution. A burst is the same clicks at scale, from several US zones, for
 * a fixed window — all three of which are `options` facts the k6 Cloud CLI
 * cannot express for zones.
 *
 * So the generator (`scripts/generate-affiliate-k6.mts`) writes the committed
 * script exactly as before, and only when `BURST_VUS`, `BURST_DURATION` and
 * `K6_LOAD_ZONES` are present does it apply this transform before writing. With
 * them unset the output is byte-identical, which `check-script.test.ts` asserts
 * — the SM check must never gain a distribution.
 *
 * Pure: the env is a parameter and the transform is a string in, string out, so
 * a test can prove both branches without spawning anything.
 */
import { US_ZONES, isUsZone } from "./plan";

export type BurstK6Options = {
  vus: number;
  durationSec: number;
  zones: { id: string; percent: number }[];
  /**
   * k6 Cloud's project for this stack. The CLI refuses a run without it once a
   * stack is configured, and the default project of a stack is not discoverable
   * from the token alone — `k6 cloud login --show` reports it.
   */
  projectId: number;
};

export const BURST_ENV_KEYS = [
  "BURST_VUS",
  "BURST_DURATION",
  "K6_LOAD_ZONES",
  "BURST_PROJECT_ID",
] as const;

/**
 * The `export const options` block the generator always emits. The transform
 * anchors on it and throws when it is gone: an unrecognised script would
 * otherwise be written with no distribution and the run would spread over
 * whatever zones k6 picks, not the ones the operator chose.
 */
const OPTIONS_ANCHOR = `export const options = {
  dns: { policy: "onlyIPv4" },
  thresholds: { report_failed: ["count==0"] },
};`;

function parsePositiveInt(name: string, raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive whole number when set (got ${JSON.stringify(raw)}).`,
    );
  }
  return value;
}

function parseZones(raw: string | undefined): BurstK6Options["zones"] {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("K6_LOAD_ZONES must be a JSON array of { id, percent } zones.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("K6_LOAD_ZONES is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("K6_LOAD_ZONES must be a non-empty JSON array.");
  }

  const zones = parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`K6_LOAD_ZONES[${index}] must be an object with id and percent.`);
    }
    const { id, percent } = entry as { id?: unknown; percent?: unknown };
    if (typeof id !== "string" || !isUsZone(id)) {
      throw new Error(
        `K6_LOAD_ZONES[${index}].id must be one of ${US_ZONES.map((zone) => zone.id).join(", ")}.`,
      );
    }
    if (
      typeof percent !== "number" ||
      !Number.isInteger(percent) ||
      percent < 1 ||
      percent > 100
    ) {
      throw new Error(`K6_LOAD_ZONES[${index}].percent must be a whole number 1-100.`);
    }
    return { id, percent };
  });

  if (new Set(zones.map((zone) => zone.id)).size !== zones.length) {
    throw new Error("K6_LOAD_ZONES names the same zone more than once.");
  }
  const total = zones.reduce((sum, zone) => sum + zone.percent, 0);
  if (total !== 100) {
    throw new Error(`K6_LOAD_ZONES percentages must sum to 100 (got ${total}).`);
  }
  return zones;
}

/**
 * The burst options a generation should carry, or `null` for the committed
 * script. Any one key set without the other two is a broken workflow
 * invocation, not a request for the default, so it throws instead of silently
 * generating a run with the wrong shape.
 */
export function burstK6OptionsFromEnv(
  env: Record<string, string | undefined>,
): BurstK6Options | null {
  const set = BURST_ENV_KEYS.filter((key) => {
    const value = env[key];
    return value !== undefined && value.trim() !== "";
  });
  if (set.length === 0) return null;
  if (set.length !== BURST_ENV_KEYS.length) {
    const missing = BURST_ENV_KEYS.filter((key) => !set.includes(key));
    throw new Error(
      `Burst generation needs all of ${BURST_ENV_KEYS.join(", ")}; missing ${missing.join(", ")}.`,
    );
  }

  return {
    vus: parsePositiveInt("BURST_VUS", env.BURST_VUS),
    durationSec: parsePositiveInt("BURST_DURATION", env.BURST_DURATION),
    zones: parseZones(env.K6_LOAD_ZONES),
    projectId: parsePositiveInt("BURST_PROJECT_ID", env.BURST_PROJECT_ID),
  };
}

/** The replacement block, so the distribution is reviewable in the log. */
export function renderBurstOptions(options: BurstK6Options): string {
  const distribution = Object.fromEntries(
    options.zones.map((zone) => [zone.id, { loadZone: zone.id, percent: zone.percent }]),
  );
  const distributionJson = JSON.stringify(distribution, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `      ${line}`))
    .join("\n");

  return [
    "export const options = {",
    '  dns: { policy: "onlyIPv4" },',
    '  thresholds: { report_failed: ["count==0"] },',
    "  // Burst only (burst.yml): the committed SM check has none of these.",
    `  vus: ${options.vus},`,
    `  duration: ${JSON.stringify(`${options.durationSec}s`)},`,
    "  ext: {",
    "    loadimpact: {",
    `      projectID: ${options.projectId},`,
    `      distribution: ${distributionJson},`,
    "    },",
    "  },",
    "};",
  ].join("\n");
}

/** Swap the script's `options` block for one that carries the burst settings. */
export function applyBurstOptions(
  script: string,
  options: BurstK6Options,
): string {
  if (!script.includes(OPTIONS_ANCHOR)) {
    throw new Error(
      "Cannot apply burst options: the generated script has no recognisable `export const options` block. " +
        "Update OPTIONS_ANCHOR in src/lib/burst/k6-options.ts to match src/lib/email/check-script.ts.",
    );
  }
  return script.replace(OPTIONS_ANCHOR, renderBurstOptions(options));
}
