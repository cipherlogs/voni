/**
 * Generates scripts/affiliate-click-check.k6.js from the same sources the app
 * uses, so the load script cannot drift from the click simulator: one profile
 * pool, one target list, one provider list, one referer map.
 *
 *   npm run affiliate:check   # regenerate scripts/affiliate-click-check.k6.js
 *
 * The output is committed and reviewable. It is self-contained because k6
 * cannot import TypeScript, so the matrix, targets, providers and referers are
 * inlined as plain data — never edit the generated file, edit its sources.
 *
 * The builder itself lives in `src/lib/email/check-script.ts`, not here: the
 * panel's save action rebuilds and uploads the same script when
 * clicks-per-run changes, so the app has to be able to import it. This file is
 * only the writer.
 *
 * A burst run (`.github/workflows/burst.yml`) needs the same script with fixed
 * VUs, a duration and a load-zone distribution. Setting BURST_VUS,
 * BURST_DURATION and K6_LOAD_ZONES applies those in memory before writing,
 * AFFILIATE_TARGETS_JSON swaps the seed for the panel's live list, and
 * AFFILIATE_TARGET_SELECTION picks the target-selection mode; with all of them
 * unset the committed script is produced byte-for-byte as before, because
 * Grafana's synthetic check must not gain a distribution.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_FAMILIES, BROWSER_PROFILES } from "../src/lib/email/user-agents";
import TARGETS_JSON from "../src/lib/email/targets.json";
import { EMAIL_PROVIDERS, assertEmailTargets } from "../src/lib/email/pool";
import { buildCheckScript } from "../src/lib/email/check-script";
import {
  TARGET_SELECTION_DEFAULT,
  parseTargetSelection,
  type TargetSelection,
} from "../src/lib/email/target-selection";
import {
  applyBurstOptions,
  burstK6OptionsFromEnv,
} from "../src/lib/burst/k6-options";

const OUT = join(import.meta.dirname, "affiliate-click-check.k6.js");

/**
 * A burst dispatched from `/email` carries today's target list, because the
 * panel owns it and the branch only holds the seed. The workflow passes it as
 * JSON in `AFFILIATE_TARGETS_JSON`; unset (a local run, CI) means the seed.
 *
 * `[]` is refused on purpose: a run with no targets would spend VU-hours
 * clicking nothing and report a green result.
 */
function targetsFromEnv(raw: string | undefined): readonly string[] | null {
  const value = raw?.trim();
  if (!value) return null;

  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("AFFILIATE_TARGETS_JSON must be a JSON array of URL strings");
  }
  if (parsed.length === 0) {
    throw new Error("AFFILIATE_TARGETS_JSON is empty: a burst needs at least one target");
  }
  return assertEmailTargets(parsed as string[]);
}

const targets = targetsFromEnv(process.env.AFFILIATE_TARGETS_JSON) ?? TARGETS_JSON;

/**
 * The burst's target-selection mode. Unset (a local run, CI) means the default
 * the committed script already carries. An unrecognised value throws instead of
 * silently falling back: a burst that ran the wrong mode would report green
 * while doing something the operator did not ask for.
 */
function selectionFromEnv(raw: string | undefined): TargetSelection {
  const value = raw?.trim();
  if (!value) return TARGET_SELECTION_DEFAULT;

  const parsed = parseTargetSelection(value);
  if (!parsed) {
    throw new Error(
      `AFFILIATE_TARGET_SELECTION must be "random" or "rotate" (got ${JSON.stringify(value)})`,
    );
  }
  return parsed;
}

const selection = selectionFromEnv(process.env.AFFILIATE_TARGET_SELECTION);

/**
 * The committed script is the one-click variant with the placeholder: it is
 * reviewed, and it holds no secret. A multi-click script is built by the panel
 * at save time, where the real secret is already in hand.
 */
const generated = buildCheckScript({
  clicksPerRun: 1,
  reportSecret: null,
  targets,
  selection,
});

const burst = burstK6OptionsFromEnv(process.env);
writeFileSync(OUT, burst ? applyBurstOptions(generated, burst) : generated);
console.log(
  `wrote ${OUT} (${BROWSER_PROFILES.length} profiles, ${BROWSER_FAMILIES.length} families, ${targets.length} targets, ${EMAIL_PROVIDERS.length} providers, selection ${selection}` +
    (burst
      ? `, burst: ${burst.vus} VUs, ${burst.durationSec}s, ${burst.zones.length} zones)`
      : ")"),
);
