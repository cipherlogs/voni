import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { LockKeyhole, MailIcon } from "lucide-react";
import {
  AffiliateControlPanel,
  ClickSurface,
  type CheckView,
  type ClickRowView,
  type ProbeView,
} from "@/components/affiliate-control-panel";
import { EmailGateForm } from "@/components/email-gate-form";
import { BurstCard } from "@/components/burst-card";
import { GithubSourceCard } from "@/components/github-source-card";
import { ProxyCard } from "@/components/proxy-card";
import { RotationCard } from "@/components/rotation-card";
import { TargetsCard } from "@/components/targets-card";
import {
  addTarget,
  dispatchGithubNow,
  pauseAllSources,
  removeTarget,
  restartGithubSegment,
  runBurst,
  saveGithubSchedule,
  saveProxy,
  saveRotation,
  setGithubSourceEnabled,
  toggleTarget,
} from "@/app/email/actions";
import { US_ZONES } from "@/lib/burst/plan";
import { GateFrame, GateSkeleton } from "@/components/email-gate-skeleton";
import { CardListSkeleton, TableSkeleton } from "@/components/page-skeletons";
import { Badge } from "@/components/ui/badge";
import { PUBLIC_CONTAINER } from "@/lib/public-container";
import { VoniLogo } from "@/components/voni-logo";
import { listAffiliateTargets } from "@/lib/email/targets";
import {
  affiliateClickStats,
  clickSourceChips,
  listAffiliateClicks,
  parseClickSource,
  runnerClicksSince,
  summariseRunnerClicks,
} from "@/lib/email/clicks";
import type { ClickProxyKind } from "@/lib/email/click-report";
import { PAGE_COOKIE, isPageUnlocked } from "@/lib/email/page-gate";
import { readRotationSetting } from "@/lib/email/rotation";
import { readProxyHealthOrReport } from "@/lib/email/proxy-health";
import { readProxySettings } from "@/lib/email/proxy-settings";
import {
  resolveTargetSelection,
  type TargetSelection,
} from "@/lib/email/target-selection";
import {
  GITHUB_SOURCE_PRODUCER,
  newestClickByOs,
  readSourceConfig,
} from "@/lib/email/source-config";
import {
  US_PROBES,
  clicksPerDay as grafanaClicksPerDay,
} from "@/lib/email/volume";
import { RUNNER_OSES, clicksPerDay as runnerClicksPerDay } from "@/lib/email/sources";
import { BROWSER_CHECK_RUN_URL } from "@/lib/github/dispatch";
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
 * One lock. The page password (`EMAIL_PAGE_PASSWORD`) decides whether the page
 * renders at all, and the same grant authorizes every write: until it is
 * satisfied the response contains the gate screen and nothing else — no check,
 * no probes, no click history, and no action that would accept a write.
 *
 * `noindex` so it never shows up in search, and nothing on load sends a click.
 */

export const metadata: Metadata = {
  title: "Email pool · Voni",
  description:
    "The sources console behind the email click campaign: one shared target list, a card per producer of clicks, and the clicks they recorded.",
  robots: { index: false, follow: false },
};

const PAGE_CLICK_LIMIT = 20;
const STATS_WINDOW_HOURS = 24;

function toCheckView(
  check: SyntheticCheck,
  rotation: TargetSelection,
): CheckView {
  return {
    id: check.id,
    job: check.job,
    target: check.target,
    enabled: check.enabled,
    frequencyMs: check.frequencyMs,
    probeIds: [...check.probeIds],
    clicksPerRun: check.clicksPerRun,
    // The mode every producer runs with, resolved from the page-level setting.
    // The script's own marker is only the fallback until that setting is
    // written, so the card describes the mode the clicks will actually use.
    targetSelection: rotation,
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
  exitIp?: string | null;
  exitCountry?: string | null;
  exitAsn?: string | null;
  proxyKind?: ClickProxyKind | null;
  failureReason?: string | null;
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
    exitIp: row.exitIp ?? null,
    exitCountry: row.exitCountry ?? null,
    exitAsn: row.exitAsn ?? null,
    proxyKind: row.proxyKind ?? null,
    failureReason: row.failureReason ?? null,
  };
}

/**
 * The page's search params. `source` is the shared table's filter and is
 * resolved against the stored producer here, in the request-time boundary: the
 * chips are links, not client state, so a copied URL opens the same table.
 */
type EmailSearchParams = {
  source?: string | string[];
};

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
  searchParams: Promise<EmailSearchParams>;
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
            A console of sources that send affiliate clicks. Every source draws
            from the one shared target list at the top; each source card below
            has its own cadence, health and numbers. A source change applies on
            its next run. The one-off button is the exception — it runs from
            voni&apos;s server, not Grafana, and the result says so.
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
  searchParams: Promise<EmailSearchParams>;
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
      <CardListSkeleton rows={3} />
      <TableSkeleton rows={6} columns={8} />
    </div>
  );
}

/**
 * The console's data. Reaching this function means `EmailPageGate` already
 * proved the page grant, so the console is writable: a locked or expired page
 * renders the gate screen instead and never arrives here. That is why no card
 * takes a `locked` prop: there is no unlocked console that still renders one.
 *
 * The four reads share this boundary. Cookies make this subtree dynamic, so it
 * streams behind the static shell instead of blocking the page's first paint
 * (and `cacheComponents` requires the boundary).
 *
 * `connection()` is what makes that true for the clock too: without it the
 * subtree is still attempted at prerender time, and the `new Date()` below is
 * the unstable value that fails the route.
 */
async function EmailControlData({
  searchParams,
}: {
  searchParams: Promise<EmailSearchParams>;
}) {
  await connection();
  const params = await searchParams;

  // The table's filter is resolved here, against the stored producer, rather
  // than in the page shell or a client component: the narrowed query and the
  // chip links below therefore come from the same value, and an unknown or
  // missing `?source=` is All.
  const selectedSource = parseClickSource(params.source);
  const sourceChips = clickSourceChips(selectedSource);

  const id = resolveCheckId(await secret("EMAIL_CLICK_CHECK_ID"));
  // The click window is measured from the request, so the boundary comes from
  // here rather than from a clock read inside the query helper.
  const now = new Date();
  // The GitHub card's coverage basis: since the last real dispatch, falling
  // back to 24 h when this source has never dispatched. The clicks read needs
  // the cutoff, so the config is read first; everything else still fans out.
  const githubConfig = await readSourceConfig();
  const githubSince =
    githubConfig?.lastDispatchedAt ?? new Date(now.getTime() - 24 * 3_600_000);

  const [
    checkResult,
    probesResult,
    stats,
    surfaceStats,
    clicks,
    targets,
    githubNewest,
    githubClicks,
    rotationSetting,
    proxySettings,
    proxyHealth,
  ] = await Promise.all([
    getCheck(id),
    listProbes(),
    // The Grafana card shows its own numbers, so its read is narrowed too.
    affiliateClickStats(STATS_WINDOW_HOURS, now, "grafana"),
    // The shared table's stats follow its filter; `undefined` is All.
    affiliateClickStats(
      STATS_WINDOW_HOURS,
      now,
      selectedSource ?? undefined,
    ),
    listAffiliateClicks(PAGE_CLICK_LIMIT, selectedSource ?? undefined),
    // Adds and pauses land here, not in the repository: this read is the list
    // both click producers use, so the card shows what will actually run.
    listAffiliateTargets(),
    // The same heartbeat the ticker reads: newest click per runner OS.
    newestClickByOs(),
    // The GitHub card's own rows for the basis window, folded below so its
    // counts and its `targets x/x` come from one aggregation.
    runnerClicksSince(GITHUB_SOURCE_PRODUCER, githubSince),
    // The page-level rotation setting every producer reads. `null` is "nobody
    // has chosen yet", which is what keeps an existing script's mode reported.
    readRotationSetting(),
    // The proxy card's two facts: what the operator chose, and the pool. The
    // read prefers a live `GET /health` on the configured control address, then
    // falls back to the newest report a Segment pushed, then says no Segment
    // has reported yet; an absent client is a state, not an error.
    readProxySettings(),
    readProxyHealthOrReport(),
  ]);

  // One resolution rule for the whole console: the setting when it exists, else
  // what Grafana's script already does. A failed check read is `null`, so the
  // setting still answers when it is the only one.
  const rotation = resolveTargetSelection(
    rotationSetting,
    checkResult.ok ? checkResult.data.targetSelection : null,
  );

  // A paused target is not clicked by any source, so it is neither part of the
  // card's denominator nor of the volume the card promises.
  const activeTargets = targets.filter((target) => target.enabled);

  const githubSummary = summariseRunnerClicks(
    githubClicks,
    activeTargets.map((target) => target.url),
  );

  // Ticket 09: the aggregate the console exists to show. Both terms come from
  // the volume modules the cards already render — Grafana's from the live
  // check, GitHub's from the saved schedule, the active targets and the closed
  // OS set — so the header cannot grow a second formula. Disabled sources
  // contribute 0; a Grafana read that failed is `null` (Unavailable), never 0,
  // because "we could not see the check" and "the check is off" are different
  // facts. Burst is on demand, so it has no daily volume to add.
  const grafanaVolume =
    checkResult.ok && checkResult.data.enabled
      ? grafanaClicksPerDay(
          checkResult.data.frequencyMs,
          checkResult.data.probeIds.length,
          checkResult.data.clicksPerRun,
        )
      : checkResult.ok
        ? 0
        : null;
  const githubVolume =
    githubConfig?.enabled === true
      ? runnerClicksPerDay(
          githubConfig.intervalSeconds,
          githubConfig.windowSeconds,
          activeTargets.length,
          RUNNER_OSES.length,
        )
      : 0;
  const totalClicksPerDay =
    grafanaVolume === null ? null : grafanaVolume + githubVolume;

  return (
    <div className="grid gap-6">
      {/* Targets first: one list, every source. The card's own add, pause,
          resume and remove controls are the only target controls on the page. */}
      <TargetsCard
        targets={targets}
        volume={{
          totalClicksPerDay,
          sources: [
            {
              label: "Grafana",
              enabled: checkResult.ok && checkResult.data.enabled,
              clicksPerDay: grafanaVolume,
            },
            {
              label: "GitHub",
              enabled: githubConfig?.enabled === true,
              clicksPerDay: githubVolume,
            },
          ],
        }}
        addTarget={addTarget}
        toggleTarget={toggleTarget}
        removeTarget={removeTarget}
        pauseAll={pauseAllSources}
      />
      {/* Rotation sits with the targets, not inside a source card: one list,
          one way of drawing from it, and every producer reads this setting. */}
      <RotationCard
        mode={rotation}
        chosen={rotationSetting !== null}
        action={saveRotation}
      />
      {/* The exit layer sits beside the targets and before the sources: it is
          shared by every click, and an operator should see whether the pool can
          serve a click before reading any source that claims to send them. */}
      <ProxyCard
        settings={proxySettings}
        health={proxyHealth}
        now={now}
        action={saveProxy}
      />
      <section className="grid gap-6" aria-labelledby="email-sources-heading">
        <h2
          id="email-sources-heading"
          className="text-lg font-semibold tracking-tight"
        >
          Sources
        </h2>
        <AffiliateControlPanel
          check={checkResult.ok ? toCheckView(checkResult.data, rotation) : null}
          checkError={checkResult.ok ? null : checkResult.message}
          probes={probesResult.ok ? toProbeViews(probesResult.data) : []}
          oneOffTargets={targets
            .filter((target) => target.enabled)
            .map((target) => ({ id: target.id, url: target.url }))}
          stats={{
            total: stats.total,
            byStatus: stats.byStatus,
            avgMs: stats.avgMs,
            byDevice: stats.byDevice,
          }}
        />
        <GithubSourceCard
          config={githubConfig}
          targetCount={activeTargets.length}
          newestByOs={githubNewest}
          summary={githubSummary}
          basis={
            githubConfig?.lastDispatchedAt
              ? "since last dispatch"
              : "last 24 hours"
          }
          workflowUrl={BROWSER_CHECK_RUN_URL}
          now={now}
          setEnabled={setGithubSourceEnabled}
          saveSchedule={saveGithubSchedule}
          dispatchNow={dispatchGithubNow}
          restart={restartGithubSegment}
        />
        <BurstCard
          action={runBurst}
          defaultZones={US_ZONES.map((zone) => zone.id)}
        />
      </section>
      {/* The shared click history: every source writes through the same intake,
          so its table belongs to the console rather than to one source card. */}
      <ClickSurface
        stats={{
          total: surfaceStats.total,
          byStatus: surfaceStats.byStatus,
          avgMs: surfaceStats.avgMs,
          byDevice: surfaceStats.byDevice,
        }}
        clicks={clicks.map(toClickRow)}
        sources={sourceChips}
      />
    </div>
  );
}
