/**
 * The `/email` page's target and source selection.
 *
 * The contract both halves implement is `docs/agents/email-pool.md`. This module
 * used to live in `src/proxy.ts` as the source of a 307; `/email` is a page now,
 * so nothing here may assume a redirect. The browser never picks the target:
 * callers draw it from the bags below.
 *
 * The server-side fan-out to the pool Workers used to live here as well. Its
 * route (`POST /api/email-pool`) lost its last caller with the old panel and was
 * retired, so the pool is exercised by the Grafana check instead.
 */

/** Targets are edited here, never in this file: `src/lib/email/targets.json`. */
import TARGETS_JSON from "./targets.json";

/** Named in the guard's error so a bad edit points straight at the file. */
export const EMAIL_TARGETS_FILE = "src/lib/email/targets.json";

/**
 * What a Worker may be asked to fetch. Every entry is an absolute URL: the bag
 * carries no paths, so there is no origin to resolve against and no second
 * source of truth for where a target lives.
 *
 * `https://cipherlogs.github.io/print/` keeps its trailing slash because GitHub
 * Pages 301s `/print` to `/print/`; the slashless form would arrive as a
 * followed redirect rather than the page that was asked for.
 *
 * A path-only, `http` or non-URL entry would otherwise be fetched as something
 * else (or silently fetch nothing), so the guard below throws by name and by
 * file at module load: a bad edit fails loudly.
 */
export function assertEmailTargets(
  entries: readonly string[],
): readonly string[] {
  for (const entry of entries) {
    let url: URL | null = null;
    try {
      url = new URL(entry);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || !url.hostname) {
      throw new Error(
        `Invalid email target ${JSON.stringify(entry)} in ${EMAIL_TARGETS_FILE}: ` +
          "every entry must be an absolute https:// URL with a host.",
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
export const EMAIL_MEDIUM = "email";
/** The campaign the visit is attributed to, stamped on every target. */
export const EMAIL_CAMPAIGN = "voni-email";

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

export const nextEmailTarget = shuffleBag(EMAIL_TARGETS);
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
  url.searchParams.set("utm_medium", EMAIL_MEDIUM);
  url.searchParams.set("utm_campaign", EMAIL_CAMPAIGN);
  return url.toString();
}
