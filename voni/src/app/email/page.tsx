import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { CheckCircle2, LockKeyhole, MailIcon } from "lucide-react";
import {
  AffiliateControlPanel,
  type CheckView,
  type ClickRowView,
  type ProbeView,
} from "@/components/affiliate-control-panel";
import { EmailGateForm } from "@/components/email-gate-form";
import { BurstCard } from "@/components/burst-card";
import { TargetsCard } from "@/components/targets-card";
import { addTarget, removeTarget, runBurst, toggleTarget } from "@/app/email/actions";
import { US_ZONES } from "@/lib/burst/plan";
import { GateFrame, GateSkeleton } from "@/components/email-gate-skeleton";
import { CardListSkeleton, TableSkeleton } from "@/components/page-skeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { PUBLIC_CONTAINER } from "@/lib/public-container";
import { VoniLogo } from "@/components/voni-logo";
import { listAffiliateTargets } from "@/lib/email/targets";
import { affiliateClickStats, listAffiliateClicks } from "@/lib/email/clicks";
import {
  EMAIL_CONTROL_COOKIE,
  controlCookieMatches,
} from "@/lib/email/control";
import { PAGE_COOKIE, isPageUnlocked } from "@/lib/email/page-gate";
import { US_PROBES } from "@/lib/email/volume";
import { secret } from "@/lib/env";
import {
  getCheck,
  listProbes,
  resolveCheckId,
  type Probe,
  type SyntheticCheck,
} from "@/lib/grafana/synthetic";

/**
 * The `/email` affiliate-click control panel. It used to fan out a drawn target
 * from every edge Worker on load; it now shows and edits the Grafana synthetic
 * check that sends the clicks, plus the click history that check produces.
 *
 * Two locks, in this order:
 *
 *   1. the page password (`EMAIL_PAGE_PASSWORD`) decides whether the page
 *      renders at all. Until it is satisfied the response contains the gate
 *      screen and nothing else — no check, no probes, no click history;
 *   2. the control secret (`EMAIL_CONTROL_SECRET`) only decides whether the
 *      panel it renders is read-only.
 *
 * `noindex` so it never shows up in search, and nothing on load sends a click.
 */

export const metadata: Metadata = {
  title: "Email pool · Voni",
  description:
    "Control the Grafana synthetic check that sends affiliate clicks and review the clicks it recorded.",
  robots: { index: false, follow: false },
};

const PAGE_CLICK_LIMIT = 20;
const STATS_WINDOW_HOURS = 24;

function toCheckView(check: SyntheticCheck): CheckView {
  return {
    id: check.id,
    job: check.job,
    target: check.target,
    enabled: check.enabled,
    frequencyMs: check.frequencyMs,
    probeIds: [...check.probeIds],
    clicksPerRun: check.clicksPerRun,
    // The SM API reports `modified` as epoch seconds, not milliseconds.
    modified:
      check.modified === null
        ? null
        : new Date(check.modified * 1000).toISOString(),
  };
}

/** US probes first, then the rest in Grafana's order; never drops a probe. */
const US_PROBE_RANK = new Map<number, number>(
  US_PROBES.map((probe, index) => [probe.id, index]),
);

function toProbeViews(probes: Probe[]): ProbeView[] {
  return [...probes]
    .sort(
      (a, b) =>
        (US_PROBE_RANK.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (US_PROBE_RANK.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((probe) => ({
      id: probe.id,
      name: probe.name,
      region: probe.region,
    }));
}

function toClickRow(row: {
  id: string;
  ranAt: Date;
  target: string;
  source: string | null;
  status: number | null;
  ms: number | null;
  finalUrl: string | null;
  userAgent: string | null;
  device: string | null;
  browser: string | null;
}): ClickRowView {
  return {
    id: row.id,
    ranAt: row.ranAt.toISOString(),
    target: row.target,
    source: row.source,
    status: row.status,
    ms: row.ms,
    finalUrl: row.finalUrl,
    userAgent: row.userAgent,
    device: row.device,
    browser: row.browser,
  };
}

/**
 * The query string only selects one of two fixed sentences. Nothing from the
 * URL is echoed, so `?notice=<anything>` cannot put attacker copy on the page.
 */
function noticeCopy(value: string | undefined): string | null {
  switch (value) {
    case "unlocked":
      return "Controls unlocked for 12 hours.";
    case "locked":
      return "Controls locked. This panel is read-only again.";
    default:
      return null;
  }
}

/** Title, one line of copy, the password form. Nothing else is rendered. */
function EmailGateScreen() {
  return (
    <GateFrame>
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <LockKeyhole className="size-5" />
          Email pool
        </h1>
        <p className="text-muted-foreground text-sm">
          This page is private. Enter the password to continue.
        </p>
      </div>
      <EmailGateForm />
    </GateFrame>
  );
}

/**
 * The page gate runs here, before any read of the check, the probes or the
 * click history — those live in `EmailControlData`, which is only reached when
 * this returns the panel. Keep the order: the tripwire in
 * `page.gate.test.ts` compares source positions and fails if a data call
 * moves above this check.
 *
 * `cookies()` needs a request, and Cache Components requires request-time
 * access to sit inside a `<Suspense>` boundary, so the gate is the boundary's
 * child rather than the page's top-level body. That boundary's fallback is the
 * shared gate skeleton (`@/components/email-gate-skeleton`), which the route's
 * `loading.tsx` renders too: a locked visitor must never see panel chrome.
 */
async function EmailPageGate({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const jar = await cookies();
  const unlocked = isPageUnlocked(
    jar.get(PAGE_COOKIE)?.value,
    await secret("EMAIL_PAGE_PASSWORD"),
  );

  if (!unlocked) return <EmailGateScreen />;

  return (
    <main className="flex min-h-svh flex-1 flex-col">
      <header className="border-b">
        <div
          className={`${PUBLIC_CONTAINER} flex h-14 items-center justify-between`}
        >
          <Link href="/" aria-label="Voni home">
            <VoniLogo wordmark />
          </Link>
          <Badge variant="outline">Email pool</Badge>
        </div>
      </header>

      <div className={`${PUBLIC_CONTAINER} flex flex-col gap-6 py-8 md:py-10`}>
        <div className="flex max-w-2xl flex-col gap-2">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <MailIcon className="size-5" />
            Email pool
          </h1>
          <p className="text-muted-foreground text-sm">
            The Grafana synthetic check behind the email click campaign: its
            interval, probes and state, plus the clicks it recorded. Changes
            apply on the check&apos;s next run. The one-off button is the
            exception — it runs from voni&apos;s server, not Grafana, and the
            result says so.
          </p>
        </div>

        <Suspense fallback={<PanelSkeleton />}>
          <EmailControlData searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

export default async function EmailControlPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  return (
    <Suspense fallback={<GateSkeleton />}>
      <EmailPageGate searchParams={searchParams} />
    </Suspense>
  );
}

function PanelSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading email control panel"
      className="grid gap-6"
    >
      <CardListSkeleton rows={2} />
      <TableSkeleton rows={6} columns={8} />
    </div>
  );
}

/**
 * The lock state and the four reads share the same boundary. Cookies make this
 * subtree dynamic, so it streams behind the static shell instead of blocking
 * the page's first paint (and `cacheComponents` requires the boundary).
 *
 * `connection()` is what makes that true for the clock too: without it the
 * subtree is still attempted at prerender time, and the `new Date()` below is
 * the unstable value that fails the route.
 */
async function EmailControlData({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  await connection();
  const params = await searchParams;
  const cookieStore = await cookies();
  const expected = await secret("EMAIL_CONTROL_SECRET");
  const locked = !controlCookieMatches(
    cookieStore.get(EMAIL_CONTROL_COOKIE)?.value,
    expected,
  );

  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));
  // The click window is measured from the request, so the boundary comes from
  // here rather than from a clock read inside the query helper.
  const now = new Date();
  const [checkResult, probesResult, stats, clicks, targets] = await Promise.all([
    getCheck(id),
    listProbes(),
    affiliateClickStats(STATS_WINDOW_HOURS, now),
    listAffiliateClicks(PAGE_CLICK_LIMIT),
    // Adds and pauses land here, not in the repository: this read is the list
    // both click producers use, so the card shows what will actually run.
    listAffiliateTargets(),
  ]);

  const notice = noticeCopy(params.notice);

  return (
    <div className="grid gap-6">
      {notice ? (
        <Alert className="status-enter">
          <CheckCircle2 />
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      <AffiliateControlPanel
        locked={locked}
        check={checkResult.ok ? toCheckView(checkResult.data) : null}
        checkError={checkResult.ok ? null : checkResult.message}
        probes={probesResult.ok ? toProbeViews(probesResult.data) : []}
        stats={{
          total: stats.total,
          byStatus: stats.byStatus,
          avgMs: stats.avgMs,
          byDevice: stats.byDevice,
        }}
        clicks={clicks.map(toClickRow)}
      />
      <TargetsCard
        locked={locked}
        targets={targets}
        addTarget={addTarget}
        toggleTarget={toggleTarget}
        removeTarget={removeTarget}
      />
      <BurstCard
        locked={locked}
        action={runBurst}
        defaultZones={US_ZONES.map((zone) => zone.id)}
      />
    </div>
  );
}
