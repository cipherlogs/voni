import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { demoCalls } from "@/lib/db/schema";
import { generateJSON } from "@/lib/llm";
import type { DemoCall } from "./call-token";
import { preReadFor, readWebsite, siteDomain, STALE_READ_MS, type WebsiteState } from "./website";

/**
 * Server half of the site read (ticket 05). The call's poll drives it: the
 * first poll after their work email is found claims the read and runs it
 * inline, so it is usually done by the time Voni's reply goes out, even
 * while the visitor is away. Inline, not after the response: a Worker keeps
 * `waitUntil` work only ~30s, a read may take 60s. Once per call and
 * domain, on the call's `demo_calls` row.
 *
 * ponytail: no pre-read while the page is frozen (no request comes in);
 * a Queue job started by the inbox match would cover it, if iPhones need it.
 */

const FETCH_TIMEOUT_MS = 10_000;
const PAGE_MAX = 400_000;

async function fetchPage(url: string): Promise<string | null> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; Voni/1.0; +https://voni.cc)" },
  });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
  return (await res.text()).slice(0, PAGE_MAX);
}

const summarySchema = z.object({ business: z.boolean(), summary: z.string().max(800) });

async function summarize(domain: string, text: string) {
  const { data } = await generateJSON(summarySchema, {
    system:
      'You read a business\'s website for a voice agent about to talk with its owner. Use only facts stated in the text; never guess or add. Reply with JSON {"business": boolean, "summary": string}. business is false when the text shows no real business (parked, for sale, placeholder, login or error page). summary: two or three short English sentences: what the business does, for whom, and where, plus one or two specific details (services, products, places) worth mentioning in conversation.',
    user: `Website: ${domain}\n\n${text}`,
    maxTokens: 400,
    // Meta reasons at high effort before it answers: the shared 400 would go to thinking.
    metaMaxTokens: 4000,
    timeoutMs: 45_000,
  });
  // The summary rides in Voni's instructions, inside """: a site's text must not close them.
  return { ...data, summary: data.summary.replace(/["`]/g, "'") };
}

/**
 * The call's read for this sender: claim it and run it now, or report the
 * one already running or done. A stuck read (its request died) is taken
 * over. `keepAlive` (the route's `after`) lets a read outlive a poll whose
 * visitor dropped, for as long as the platform allows.
 */
export async function runWebsiteRead(
  call: DemoCall,
  address: string,
  keepAlive: (work: Promise<unknown>) => void,
): Promise<WebsiteState | null> {
  const domain = siteDomain(address);
  if (!domain) return null;
  const [claimed] = await db
    .update(demoCalls)
    .set({ websiteDomain: domain, websiteStatus: "reading", websiteSummary: null, websiteStartedAt: new Date() })
    .where(
      and(
        eq(demoCalls.callId, call.callId),
        or(
          isNull(demoCalls.websiteDomain),
          ne(demoCalls.websiteDomain, domain),
          and(eq(demoCalls.websiteStatus, "reading"), lt(demoCalls.websiteStartedAt, new Date(Date.now() - STALE_READ_MS))),
        ),
      ),
    )
    .returning({ callId: demoCalls.callId });
  if (!claimed) return loadWebsite(call.callId, address);
  const work = readWebsite(domain, { fetchPage, summarize }).then(async (result) => {
    await db
      .update(demoCalls)
      .set({ websiteStatus: result.status, websiteSummary: result.status === "read" ? result.summary : null })
      .where(and(eq(demoCalls.callId, call.callId), eq(demoCalls.websiteDomain, domain)));
    return result.status === "read" ? { ...result, domain } : { status: "none" as const, domain };
  });
  keepAlive(work.catch(() => {}));
  return work;
}

/** The call's read for this sender, or null when none was started for their domain. */
export async function loadWebsite(callId: string, address: string): Promise<WebsiteState | null> {
  const [row] = await db
    .select({
      websiteDomain: demoCalls.websiteDomain,
      websiteStatus: demoCalls.websiteStatus,
      websiteSummary: demoCalls.websiteSummary,
      websiteStartedAt: demoCalls.websiteStartedAt,
    })
    .from(demoCalls)
    .where(eq(demoCalls.callId, callId));
  return preReadFor(row ?? null, address);
}
