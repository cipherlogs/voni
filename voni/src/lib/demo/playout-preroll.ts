/**
 * The caller-perceived first-sound offset (demo-latency ticket 02).
 *
 * The playout worklet holds a reply's first audio for `PREROLL_S` before it
 * starts, so the pre-roll is part of what the caller hears but never part of
 * the measured delivery (and never a gate input). The worklet has to stay
 * plain JavaScript loaded by URL from `/public`, so this module reads its one
 * constant from the real source instead of keeping a second copy that can
 * drift from it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKLET_URL = new URL("../../../public/playout-processor.js", import.meta.url);
const PREROLL_DECLARATION = /^const PREROLL_S = ([0-9]*\.?[0-9]+);$/m;

const workletPath = fileURLToPath(WORKLET_URL);
const declaration = PREROLL_DECLARATION.exec(readFileSync(workletPath, "utf8"));
if (!declaration) {
  throw new Error(`playout-processor.js: PREROLL_S constant not found in ${workletPath}`);
}

/** The worklet's `PREROLL_S` in whole milliseconds (500). */
export const PLAYOUT_PREROLL_MS = Math.round(Number(declaration[1]) * 1000);
