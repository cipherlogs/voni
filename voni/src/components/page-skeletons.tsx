/**
 * Built in-style per voni/DESIGN.md §4 (feedback): no skeleton block exists
 * in Blocks, so every loading shape here is composed from the Skeleton
 * primitive + flex/grid + gap in Blocks idiom. Route loading.tsx boundaries
 * stay; presentational only — static data iteration (catalog/registry row
 * counts) but no fetches, no state, no real copy.
 *
 * Skeletons mirror the neutral first paint: conditional states that resolve
 * with data are intentionally omitted (non-owner workspace alert, voice
 * pairing note, dirty notes, save feedback, admin-gated operator tile).
 */
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { buildServiceReadiness } from "@/lib/settings-badges";
import { PROVIDER_CATALOG } from "@/lib/providers/registry";
import { SETTINGS_TILES } from "@/lib/settings-tiles";
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

/** Matches the few remaining card-list shapes: a stack of cards, each one row. */
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
 * One loading section in the exact form-layout-02/03 shape: flat side label,
 * responsive field column, and no Card body. The final render decides how
 * many rows its section needs.
 */
export function FlatFormSectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid grid-cols-1 gap-10 md:grid-cols-3">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-4 w-full max-w-xs" />
      </div>
      <div className="flex flex-col gap-4 sm:max-w-3xl md:col-span-2">
        {Array.from({ length: rows }, (_, index) => (
          <div className="flex flex-col gap-2" key={index}>
            <Skeleton className={`h-4 ${CARD_META_WIDTHS[index % CARD_META_WIDTHS.length]} ${SHIMMER_DELAYS[index % SHIMMER_DELAYS.length]}`} />
            <Skeleton className={`h-8 w-full max-w-md ${SHIMMER_DELAYS[(index + 1) % SHIMMER_DELAYS.length]}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A complete flat form with ruled sections and the shared wrapping action row. */
export function FlatFormSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div>
      {Array.from({ length: sections }, (_, index) => (
        <div key={index}>
          {index > 0 ? <Separator className="my-8" /> : null}
          <FlatFormSectionSkeleton rows={index === 0 ? 2 : 3} />
        </div>
      ))}
      <Separator className="my-8" />
      <div className="flex flex-col-reverse flex-wrap gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-full sm:w-24" />
        <Skeleton className="h-8 w-full sm:w-32" />
      </div>
    </div>
  );
}

/** Mirrors the agent editor: heading, deployment meters, then four flat sections. */
export function AgentDetailSkeleton() {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="flex flex-col gap-2" key={index}>
              <Skeleton className={`h-1.5 w-full ${SHIMMER_DELAYS[index]}`} />
              <Skeleton className={`h-3 w-full ${SHIMMER_DELAYS[(index + 1) % SHIMMER_DELAYS.length]}`} />
            </div>
          ))}
        </div>
      </div>
      <FlatFormSkeleton sections={4} />
    </div>
  );
}

/** Mirrors campaign/new: its page heading plus the three flat form sections. */
export function CampaignFormPageSkeleton({ withHeader = true }: { withHeader?: boolean }) {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      {withHeader ? <PageHeaderSkeleton withAction={false} /> : null}
      <FlatFormSkeleton sections={3} />
    </div>
  );
}

/** Mirrors campaign detail: heading, dialer/import sections, and queue table. */
export function CampaignDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-full max-w-lg" />
        <Skeleton className="h-8 w-40" />
      </div>
      <Separator />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-28 w-full max-w-3xl" />
      </div>
      <Separator />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-28" />
        <TableSkeleton rows={5} columns={7} />
      </div>
    </div>
  );
}

/** Mirrors lead detail: six summary Tiles followed by record tables/cards. */
export function LeadDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton withAction={false} />
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Card key={index}>
            <CardContent className="flex flex-col gap-3 py-6">
              <Skeleton className={`h-4 w-24 ${SHIMMER_DELAYS[index % SHIMMER_DELAYS.length]}`} />
              <Skeleton className={`h-6 w-32 ${SHIMMER_DELAYS[(index + 1) % SHIMMER_DELAYS.length]}`} />
            </CardContent>
          </Card>
        ))}
      </div>
      <TableSkeleton rows={4} columns={5} />
      <TableSkeleton rows={4} columns={4} />
      <CardListSkeleton rows={1} />
    </div>
  );
}

/** Mirrors call detail: the heading and four stacked information cards. */
export function CallDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton withAction={false} />
      <CardListSkeleton rows={4} />
    </div>
  );
}

/**
 * Settings section frame: mirrors the `FormSection` flat idiom
 * (form-layout-03 / campaign density) — side h2 + muted description left,
 * content right. Markup only, no logic; composed from the Skeleton
 * primitive + grid + gap.
 */
function SettingsSectionFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-10 md:grid-cols-3">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full max-w-xs" />
      </div>
      <div className="md:col-span-2 sm:max-w-3xl">{children}</div>
    </div>
  );
}

/** Mirrors AccountSection: profile (avatar + name/email) + session (desc + sign-out). */
export function SettingsAccountSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <SettingsSectionFrame>
        <div className="flex max-w-xl items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
      </SettingsSectionFrame>
      <Separator className="my-8" />
      <SettingsSectionFrame>
        <div className="flex max-w-xl flex-col gap-3">
          <Skeleton className="h-3 w-full max-w-md" />
          <Skeleton className="h-8 w-28" />
        </div>
      </SettingsSectionFrame>
    </div>
  );
}

/** Mirrors VoiceCopilotCard: two selects with hints plus Cancel + save footer. */
export function SettingsVoiceSkeleton() {
  return (
    <SettingsSectionFrame>
      <div className="grid max-w-xl gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-full max-w-md" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-full max-w-md" />
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
        <div className="flex flex-col-reverse flex-wrap gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>
    </SettingsSectionFrame>
  );
}

/** Mirrors WorkspaceSection: three stacked fields plus Cancel + save footer. */
export function SettingsWorkspaceSkeleton() {
  return (
    <SettingsSectionFrame>
      <div className="grid max-w-xl gap-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-full max-w-md" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-full max-w-xs" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-8 w-full max-w-xs" />
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
        <div className="flex flex-col-reverse flex-wrap gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
    </SettingsSectionFrame>
  );
}

/**
 * Readiness row count derives from the shared helper (called with an
 * all-off fixture; only the row count is used, never any state or copy —
 * loading placeholders stay bars, never real text).
 */
const READINESS_SKELETON_ROWS = buildServiceReadiness({
  assemblyaiConfigured: false,
  telnyxConfigured: false,
  telnyxConnectionId: null,
  telnyxCallerNumber: null,
  llmConfigured: false,
  cartesiaConfigured: false,
  cartesiaVoiceId: null,
});

/**
 * Mirrors ServicesSection: one provider connection card per catalog entry
 * (header + tool rows + small toggle) plus one readiness row per platform
 * service, split by the same separator as the real section. Card and row
 * counts derive from the production sources, so a new provider or service
 * can never stream the wrong shape.
 */
export function SettingsServicesSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <SettingsSectionFrame>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {PROVIDER_CATALOG.map((provider) => (
              <Card key={provider.id}>
                <CardContent className="flex flex-col gap-4 p-4">
                  <div className="flex items-center gap-4">
                    <Skeleton className="size-10 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-5 w-16" />
                      </div>
                      <Skeleton className="h-3 w-full max-w-xs" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    {provider.tools.map((tool) => (
                      <div key={tool.id} className="flex flex-col gap-2 rounded-lg bg-muted/50 px-3 py-2">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-3 w-full max-w-xs" />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-end">
                    <Skeleton className="h-7 w-24" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </SettingsSectionFrame>
      <Separator className="my-8" />
      <SettingsSectionFrame>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {READINESS_SKELETON_ROWS.map((service) => (
            <Card key={service.id}>
              <CardContent className="flex items-center gap-4 p-4">
                <Skeleton className="size-10 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-5 w-14" />
                  </div>
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

/** Mirrors AppearanceSection: theme toggle + hint, then preview copy. */
export function SettingsAppearanceSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <SettingsSectionFrame>
        <div className="flex max-w-xl flex-col gap-3">
          <Skeleton className="size-8" />
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
      </SettingsSectionFrame>
      <Separator className="my-8" />
      <SettingsSectionFrame>
        <Skeleton className="h-3 w-full max-w-md" />
      </SettingsSectionFrame>
    </div>
  );
}

/**
 * Mirrors the settings landing: heading pair plus one tile frame per
 * registry entry (order + hero spans from the same source as the landing,
 * so a new tile can never stream the wrong grid). Each frame echoes the
 * production card anatomy — icon disc, title, one-line description —
 * without interactivity.
 */
export function SettingsLandingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SETTINGS_TILES.map((tile) => (
          <div key={tile.value} className="flex items-center gap-4 rounded-xl border p-4">
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-full max-w-48" />
            </div>
          </div>
        ))}
      </div>
    </div>
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
      <FlatFormSkeleton sections={2} />
    </div>
  );
}
