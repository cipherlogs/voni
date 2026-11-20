/**
 * The `/email` page's target and source selection.
 *
 * The contract both producers implement is `docs/agents/email-pool.md`: the
 * Grafana check script generated from these bags, and the panel's one-off click.
 * This module used to live in `src/proxy.ts` as the source of a 307; `/email` is
 * a page now, so nothing here may assume a redirect. The browser never picks the
 * target: it comes from the live list in `targets.ts`, and the source from the
 * provider bag below.
 */

/**
 * The seed list, validated and exported for tests and the generator. The live
 * list the check and the one-off click use is a database read:
 * `src/lib/email/targets.ts`.
 */
import TARGETS_JSON from "./targets.json";
import { targetUrlProblem } from "./target-url";

/** Named in the guard's error so a bad seed edit points straight at the file. */
export const EMAIL_TARGETS_FILE = "src/lib/email/targets.json";

/**
 * What a click may fetch. Every entry is an absolute https URL: the bag carries
 * no paths, so there is no origin to resolve against and no second source of
 * truth for where a target lives.
 *
 * `https://cipherlogs.github.io/print/` keeps its trailing slash because GitHub
 * Pages 301s `/print` to `/print/`, the slashless form would arrive as a
 * followed redirect rather than the page that was asked for.
 *
 * The rules are the panel's add-form rules (`targetUrlProblem` in
 * `target-url.ts`) — a seed entry cannot be looser than something the operator
 * can add from `/email`. A bad edit fails loudly at module load, by name and by
 * file.
 */
export function assertEmailTargets(
  entries: readonly string[],
): readonly string[] {
  for (const entry of entries) {
    const problem = targetUrlProblem(entry);
    if (problem !== null) {
      throw new Error(
        `Invalid email target ${JSON.stringify(entry)} in ${EMAIL_TARGETS_FILE}: ` +
          `every entry must be an absolute https:// URL with a public host (${problem})`,
      );
    }
  }
  return entries;
}

export const EMAIL_TARGETS: readonly string[] = assertEmailTargets(TARGETS_JSON);

/** The claimed source of the visit, used only as `utm_source`. */
export const EMAIL_PROVIDERS = [
  "xfinity.com",
  "spectrum.com",
  "att.com",
  "verizon.com",
  "cox.com",
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
];

export const EMAIL_SOURCE_PARAM = "utm_source";
/** The channel the visit is attributed to, stamped on every target. */
export const UTM_MEDIUM_PARAM = "utm_medium";
/** The campaign the visit is attributed to, stamped on every target. */
export const UTM_CAMPAIGN_PARAM = "utm_campaign";
export const EMAIL_MEDIUM = "email";
export const EMAIL_CAMPAIGN = "voni-email";

/**
 * The three params every click is stamped with. Rotation compares "when was
 * this target last visited", and a recorded click holds the *stamped* URL — one
 * per provider — so the target it belongs to is the URL with these removed.
 */
const ATTRIBUTION_PARAMS = [
  EMAIL_SOURCE_PARAM,
  UTM_MEDIUM_PARAM,
  UTM_CAMPAIGN_PARAM,
] as const;

/**
 * Draw without replacement: every entry appears once per pass, in its own
 * shuffled order, then the bag refills. `random` is injectable so a test can
 * pin the order. Instances live as long as the module instance, so a cold start
 * simply begins a new shuffle.
 */
export function shuffleBag<T>(
  items: readonly T[],
  random: () => number = Math.random,
): () => T {
  let order: T[] = [];
  let cursor = 0;
  return () => {
    if (cursor >= order.length) {
      order = [...items];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      cursor = 0;
    }
    return order[cursor++];
  };
}

export const nextEmailProvider = shuffleBag(EMAIL_PROVIDERS);

/**
 * One target URL with the claimed attribution stamped on as `utm_source`,
 * `utm_medium` and `utm_campaign`. The source is drawn from the same no-repeat
 * bag as the target.
 *
 * The entry is absolute and keeps its own host, path and query; the three params
 * are `set`, never appended, so an entry's own query keys survive and no utm key
 * is duplicated. A non-absolute entry throws here, at the boundary, rather than
 * being silently resolved against some origin.
 */
export function resolveTarget(
  entry: string,
  source: string = nextEmailProvider(),
): string {
  const url = new URL(entry);
  url.searchParams.set(EMAIL_SOURCE_PARAM, source);
  url.searchParams.set(UTM_MEDIUM_PARAM, EMAIL_MEDIUM);
  url.searchParams.set(UTM_CAMPAIGN_PARAM, EMAIL_CAMPAIGN);
  return url.toString();
}

/**
 * The target a recorded click belongs to: the URL it visited with the three
 * attribution params removed, in the same canonical form `canonicalTargetUrl`
 * gives a target row.
 *
 * A click row stores the stamped URL, so two visits to one target from two
 * providers are two different strings. Rotation needs the target, not the
 * stamp: `baseTargetUrl(recorded) === baseTargetUrl(row.url)`, so the "last
 * visited" lookup has one key per target. A URL with no attribution (a row
 * written before the pool stamped them) passes through unchanged, which is what
 * makes old history count too.
 */
export function baseTargetUrl(stamped: string): string {
  const url = new URL(stamped);
  for (const param of ATTRIBUTION_PARAMS) url.searchParams.delete(param);
  return url.toString();
}
