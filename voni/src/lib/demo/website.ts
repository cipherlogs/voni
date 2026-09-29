import { isFreeEmailDomain } from "./email-test";

/**
 * Website research (ticket 05): once the visitor's work email lands, the
 * server reads their domain's site and summarizes what the business does, so
 * Voni talks about it truthfully. The fetch and the summarizer are injected
 * (website-read.ts wires fetch and lib/llm), so the no-site paths and the
 * pre-read match are testable offline. Browser-safe.
 */

/**
 * Fetch + summary, end to end, before Voni falls back to "tell me what you
 * do" (owner, 2026-09-29). Meta's summary measured 17–45s at high effort,
 * 9–11s at the low effort it now runs; Voni keeps talking meanwhile, so a
 * long budget costs no dead air.
 */
export const READ_BUDGET_MS = 60_000;

/** A read still "reading" after this died with its Worker: no site, never a hung call. */
export const STALE_READ_MS = READ_BUDGET_MS + 15_000;

/** What reached the summarizer: enough for a small model, short of its context. */
const TEXT_MAX = 6000;

export type WebsiteState =
  | { status: "reading"; domain: string }
  | { status: "read"; domain: string; summary: string }
  | { status: "none"; domain: string };

export type WebsiteDeps = {
  /** The page's HTML, or null when it didn't answer with HTML. */
  fetchPage: (url: string) => Promise<string | null>;
  /** `business: false` when the text shows no real business (parked, placeholder, error page). */
  summarize: (domain: string, text: string) => Promise<{ business: boolean; summary: string }>;
  /**
   * The page as text through a reader service, or null. Tried when no page
   * came back direct (a network that can't reach the host, a blocked bot) or
   * the page was little more than its title (built in JavaScript).
   */
  fetchReader?: (url: string) => Promise<string | null>;
  budgetMs?: number;
};

const HOST = /^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** The sender's domain, when it is a business's own (free email has no site to read). */
export function siteDomain(address: string): string | null {
  const domain = address.trim().toLowerCase().split("@")[1] ?? "";
  if (!HOST.test(domain) || isFreeEmailDomain(domain)) return null;
  return domain;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Title, meta description and visible body words, whitespace-collapsed. */
export function pageText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const description =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ??
    "";
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return [title, description, body]
    .join(" \n ")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_MAX);
}

const PARKED = /\b(domain (is |may be )?for sale|buy this domain|parked (free|domain)|domain parking|coming soon|under construction|this domain has been registered)\b/i;

/** Nothing worth summarizing: a parked or for-sale page, or next to no text. */
export function looksParked(text: string): boolean {
  return text.length < 80 || PARKED.test(text);
}

/** A reader's Markdown as plain words: images dropped, links to their text. */
export function readerText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_MAX);
}

const NONE = { status: "none" } as const;

/** Below this, a page is little more than its title and description (measured: a JavaScript-built site gave 145). */
const THIN = 400;

export async function readWebsite(
  domain: string,
  deps: WebsiteDeps,
): Promise<{ status: "read"; summary: string } | { status: "none" }> {
  const summarized = async (text: string) => {
    if (looksParked(text)) return NONE;
    const { business, summary } = await deps.summarize(domain, text);
    return business && summary.trim() ? { status: "read" as const, summary: summary.trim() } : NONE;
  };
  const work = async () => {
    let direct = "";
    for (const url of [`https://${domain}/`, `https://www.${domain}/`]) {
      const html = await deps.fetchPage(url).catch(() => null);
      if (!html) continue;
      direct = pageText(html);
      if (PARKED.test(direct)) return NONE;
      if (direct.length >= THIN) return summarized(direct);
      break; // Little more than a title: built in JavaScript, the reader renders it.
    }
    const markdown = await deps.fetchReader?.(`https://${domain}/`).catch(() => null);
    const rendered = markdown ? readerText(markdown) : "";
    return summarized(rendered.length > direct.length ? rendered : direct);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof NONE>((resolve) => {
    timer = setTimeout(() => resolve(NONE), deps.budgetMs ?? READ_BUDGET_MS);
  });
  try {
    return await Promise.race([work().catch(() => NONE), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The site-read side of a `demo_calls` row. */
export type WebsiteRow = {
  websiteDomain: string | null;
  websiteStatus: string | null;
  websiteSummary: string | null;
  websiteStartedAt: Date | null;
};

/**
 * The call's read, if it is for this sender's domain. A read for another
 * domain (a pre-read the claim didn't match) is not theirs: null, and the
 * normal flow reads their site.
 */
export function preReadFor(row: WebsiteRow | null, address: string, now = Date.now()): WebsiteState | null {
  const domain = siteDomain(address);
  if (!row || !domain || row.websiteDomain !== domain) return null;
  if (row.websiteStatus === "read" && row.websiteSummary) return { status: "read", domain, summary: row.websiteSummary };
  if (row.websiteStatus === "reading" && row.websiteStartedAt && now - row.websiteStartedAt.getTime() < STALE_READ_MS) {
    return { status: "reading", domain };
  }
  return { status: "none", domain };
}
