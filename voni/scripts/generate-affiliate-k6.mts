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
 * BURST_DURATION and K6_LOAD_ZONES applies those in memory before writing; with
 * them unset the committed script is produced byte-for-byte as before, because
 * Grafana's synthetic check must not gain a distribution.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_FAMILIES, BROWSER_PROFILES } from "../src/lib/email/user-agents";
import TARGETS_JSON from "../src/lib/email/targets.json";
import { EMAIL_PROVIDERS } from "../src/lib/email/pool";
import { buildCheckScript } from "../src/lib/email/check-script";
import {
  applyBurstOptions,
  burstK6OptionsFromEnv,
} from "../src/lib/burst/k6-options";

const OUT = join(import.meta.dirname, "affiliate-click-check.k6.js");

/**
 * The committed script is the one-click variant with the placeholder: it is
 * reviewed, and it holds no secret. A multi-click script is built by the panel
 * at save time, where the real secret is already in hand.
 */
const generated = buildCheckScript({
  clicksPerRun: 1,
  reportSecret: null,
});

const burst = burstK6OptionsFromEnv(process.env);
writeFileSync(OUT, burst ? applyBurstOptions(generated, burst) : generated);
console.log(
  `wrote ${OUT} (${BROWSER_PROFILES.length} profiles, ${BROWSER_FAMILIES.length} families, ${TARGETS_JSON.length} targets, ${EMAIL_PROVIDERS.length} providers` +
    (burst
      ? `, burst: ${burst.vus} VUs, ${burst.durationSec}s, ${burst.zones.length} zones)`
      : ")"),
);
