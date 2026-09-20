/**
 * Built in-style per voni/DESIGN.md §4 (feedback): no skeleton block exists
 * in Blocks, so every loading shape here is composed from the Skeleton
 * primitive + flex/grid + gap in Blocks idiom. Route loading.tsx boundaries
 * stay; markup only, no logic.
 */
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { SettingsTabValue } from "@/lib/settings-tabs";

/**
 * Stagger the shimmer sweep so rows don't pulse in lockstep. Negative delays
 * start each bar mid-cycle (one 1600ms period split three ways); positive
 * delays would leave bars static on first paint. Arbitrary *properties* are
 * fine here — the §5 ban covers arbitrary color/spacing *values*.
 */
const SHIMMER_DELAYS = [
  "[animation-delay:0ms]",
  "[animation-delay:-533ms]",
  "[animation-delay:-1066ms]",
] as const;

/** Vary title/meta widths per row so stacked rows don't stripe identically. */
const CARD_TITLE_WIDTHS = ["w-48", "w-40", "w-56"] as const;
const CARD_META_WIDTHS = ["w-32", "w-40", "w-24"] as const;

/** Header row shared by every list page: a title/subtitle pair and an optional action button. */
export function PageHeaderSkeleton({ withAction = true }: { withAction?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      {withAction ? <Skeleton className="h-8 w-28" /> : null}
    </div>
  );
}

/** Matches the agents/campaigns list shape: a stack of cards, each one row. */
export function CardListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <Card key={i}>
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className={`h-4 ${CARD_TITLE_WIDTHS[i % CARD_TITLE_WIDTHS.length]} ${SHIMMER_DELAYS[i % SHIMMER_DELAYS.length]}`} />
              <Skeleton className={`h-3 w-full max-w-md ${SHIMMER_DELAYS[(i + 1) % SHIMMER_DELAYS.length]}`} />
              <Skeleton className={`h-3 ${CARD_META_WIDTHS[i % CARD_META_WIDTHS.length]} ${SHIMMER_DELAYS[(i + 2) % SHIMMER_DELAYS.length]}`} />
            </div>
            <Skeleton className="h-8 w-16 shrink-0" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Matches the leads/numbers table shape. */
export function TableSkeleton({ rows = 6, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex flex-col gap-4">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-4">
              {Array.from({ length: columns }, (_, j) => (
                <Skeleton key={j} className={`h-4 flex-1 ${SHIMMER_DELAYS[(i + j) % SHIMMER_DELAYS.length]}`} />
              ))}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Matches the dashboard's pipeline-stage stat grid. */
export function StatGridSkeleton({ cards = 5 }: { cards?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: cards }, (_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Skeleton className={`h-4 w-20 ${SHIMMER_DELAYS[i % SHIMMER_DELAYS.length]}`} />
          </CardHeader>
          <CardContent>
            <Skeleton className={`h-7 w-10 ${SHIMMER_DELAYS[(i + 1) % SHIMMER_DELAYS.length]}`} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** A single detail page: a header block plus a couple of content cards. */
export function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 py-6">
          <Skeleton className="h-4 w-full max-w-sm" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-4 w-full max-w-xs" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-3 py-6">
          <Skeleton className="h-4 w-full max-w-sm" />
          <Skeleton className="h-4 w-full max-w-md" />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Settings section frame (ticket 03): mirrors the `SettingsSection`
 * flat idiom — side h2 + muted description left, content right. Markup
 * only, no logic; composed from the Skeleton primitive + grid + gap.
 */
function SettingsSectionFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-10 md:grid-cols-3">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full max-w-xs" />
      </div>
      <div className="md:col-span-2">{children}</div>
    </div>
  );
}

/** Mirrors AccountSection: avatar + name/email row plus the sign-out action. */
export function SettingsAccountSkeleton() {
  return (
    <SettingsSectionFrame>
      <div className="flex max-w-xl flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 rounded-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
    </SettingsSectionFrame>
  );
}

/** Mirrors VoiceCopilotCard: two selects with hints plus the save footer. */
export function SettingsVoiceSkeleton() {
  return (
    <SettingsSectionFrame>
      <div className="grid max-w-xl gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
        <div className="flex items-center justify-end gap-3 border-t pt-4">
          <Skeleton className="h-9 w-36" />
        </div>
      </div>
    </SettingsSectionFrame>
  );
}

/** Mirrors WorkspaceSection: three stacked fields plus the save footer. */
export function SettingsWorkspaceSkeleton() {
  return (
    <SettingsSectionFrame>
      <div className="grid max-w-xl gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
        <div className="flex items-center justify-end gap-3 border-t pt-4">
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
    </SettingsSectionFrame>
  );
}

/**
 * Mirrors ServicesSection: provider connection cards plus the
 * service-readiness grid. Two cards each keep the streaming shape honest
 * without fetching the catalog.
 */
export function SettingsServicesSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <SettingsSectionFrame>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardContent className="flex flex-col gap-4 p-4">
                <div className="flex items-center gap-4">
                  <Skeleton className="size-10 rounded-full" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-full max-w-xs" />
                  </div>
                </div>
                <Skeleton className="h-16 w-full" />
                <div className="flex items-center justify-end">
                  <Skeleton className="h-8 w-24" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </SettingsSectionFrame>
      <SettingsSectionFrame>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardContent className="flex items-center gap-4 p-4">
                <Skeleton className="size-10 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-full max-w-xs" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </SettingsSectionFrame>
    </div>
  );
}

/** Mirrors AppearanceSection: the theme toggle row. */
export function SettingsAppearanceSkeleton() {
  return (
    <SettingsSectionFrame>
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-4 w-48" />
      </div>
    </SettingsSectionFrame>
  );
}

/**
 * Per-section skeleton switch (ticket 03): the section shell renders the
 * skeleton shaped to the tab being streamed, so the loading state reads as
 * the real layout incoming. Typed to the tab union — adding a registry
 * section without a case here fails typecheck, so no new route can silently
 * stream the wrong shape. The shell 404s unknown tabs before this paints.
 */
export function SettingsSectionSkeleton({ tab }: { tab: SettingsTabValue }) {
  switch (tab) {
    case "account":
      return <SettingsAccountSkeleton />;
    case "voice":
      return <SettingsVoiceSkeleton />;
    case "workspace":
      return <SettingsWorkspaceSkeleton />;
    case "services":
      return <SettingsServicesSkeleton />;
    case "appearance":
      return <SettingsAppearanceSkeleton />;
  }
}

/**
 * Mirrors the /agents/new 2-step creator: heading, timeline bar, one form
 * card with two labeled sections, and the Back/primary footer row.
 */
export function NewAgentSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-hidden>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <Skeleton className="h-2 w-full" />
      <Card>
        <CardContent className="flex flex-col gap-6 py-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full max-w-sm" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full max-w-xs" />
            <Skeleton className="h-16 w-full" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full max-w-xs" />
            <Skeleton className="h-16 w-full" />
          </div>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-32" />
      </div>
    </div>
  );
}
