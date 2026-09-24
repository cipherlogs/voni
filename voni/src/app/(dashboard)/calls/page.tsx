import { Fragment, Suspense } from "react";
import { DataTable } from "@/components/data-table";
import { PageHeading } from "@/components/wizard/form-layout";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { RouteBrief } from "@/components/copilot/route-brief";
import { FilterChips } from "@/components/filter-chips";
import { listCalls } from "@/lib/copilot/detail-data";
import {
  callOutcomeLabel,
  normalizeCallOutcome,
} from "@/lib/calls/outcome-filter";
import { callDuration, relativeCallTime } from "@/lib/calls/format";

const CALLS_PAGE_SIZE = 20;
const CALL_TABLE_COLUMNS = 4;

/** Curated filter chips: All + the dashboard outcomes (?outcome=). */
function callsChips(active: string | undefined) {
  return [
    { label: "All", href: "/calls", active: !active },
    {
      // Grain lives in the label: the dashboard's other cards count leads,
      // this one counts calls, so "Connected" alone read as a mismatch.
      label: "Connected calls",
      href: "/calls?outcome=connected",
      active: active === "connected",
    },
    {
      label: "Booked",
      href: "/calls?outcome=booked",
      active: active === "booked",
    },
    {
      label: "Needs handoff",
      href: "/calls?outcome=handoff",
      active: active === "handoff",
    },
  ];
}

type CallsSearchParams = {
  page?: string | string[];
  outcome?: string | string[] | null;
};

/** Pagination href that carries the active outcome filter, if any. */
function callsPageHref(
  page: number,
  outcome: string | undefined,
): string {
  const params = new URLSearchParams();
  if (outcome) params.set("outcome", outcome);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/calls?${query}` : "/calls";
}

/**
 * Absolute start time for the Started column's second line. Local to this
 * server component (not in lib/calls/format.ts): that module must stay
 * arithmetic-only so SSR and client render agree — an Intl string rendered
 * here comes from the server payload, never recomputed on the client.
 */
function absoluteCallTime(value: Date | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

/**
 * RouteBrief renders nothing but must not sit inside a <table>: React
 * hydrates a component boundary as a DOM node, and a node between <table>
 * and <tbody> reads as a nested <div> — invalid table HTML that logs a
 * hydration error on every list visit.
 */
function CallsBrief({ page }: { page: number }) {
  return (
    <RouteBrief
      route="/calls"
      brief={`Call history: page ${page} with lead, direction, start time, and duration. Voice reads here.`}
    />
  );
}

/**
 * Calls index: every call in the org, newest first, 20 per page. Rows link
 * to /calls/[id] detail. Mirrors the leads table shape (header, table,
 * suspense leaf, skeleton fallback) per the shared list pattern.
 *
 * Out-of-range pages render an Empty state, not a 404 — a guessed ?page=
 * is a navigation slip, not a missing resource.
 */
async function CallsRows({
  searchParams,
}: {
  searchParams: Promise<CallsSearchParams>;
}) {
  // URL data is read here, inside the Suspense boundary below — not in the
  // page shell above it. Awaiting searchParams in the shell would tie the
  // App Shell to one URL and break instant navigation (E1439); the shell
  // (h1, table frame, header) stays static and only these rows stream.
  const params = await searchParams;
  const raw = Array.isArray(params.page) ? params.page[0] : params.page;
  const parsed = Number(raw);
  // Clamp here so the shell never renders a nonsense page; listCalls
  // clamps again defensively for direct callers.
  const page = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
  const {
    rows,
    page: safePage,
    total,
    outcome,
  } = await listCalls(page, CALLS_PAGE_SIZE, { outcome: params.outcome });
  const totalPages = Math.max(1, Math.ceil(total / CALLS_PAGE_SIZE));
  const hasNext = safePage < totalPages;
  // Numbered pages stay bounded: first, last, and the current
  // neighborhood — a long history would otherwise render one button
  // per page. Gaps between windows read as an ellipsis below.
  const pageWindow = Array.from(
    new Set([1, safePage - 1, safePage, safePage + 1, totalPages]),
  )
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);
  // The footer only renders across pages; the count lives here instead so
  // a filtered single page still states its total — never an unchecked
  // number.
  const countLabel = outcome
    ? `${total} ${total === 1 ? "call" : "calls"} · outcome ${callOutcomeLabel(outcome)}`
    : `${total} ${total === 1 ? "call" : "calls"}`;

  return (
    <>
      <CallsBrief page={safePage} />
      {rows.length > 0 ? (
        <TableBody>
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={CALL_TABLE_COLUMNS} className="py-2">
              <span
                role="status"
                aria-label={
                  outcome
                    ? `Filtered results: ${countLabel}`
                    : `Results: ${countLabel}`
                }
                className="text-muted-foreground text-xs"
              >
                {countLabel}
              </span>
            </TableCell>
          </TableRow>
        </TableBody>
      ) : null}
      {rows.length === 0 ? (
        <TableBody>
          <TableRow>
            <TableCell
              colSpan={CALL_TABLE_COLUMNS}
              className="h-40 text-center"
            >
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Phone />
                  </EmptyMedia>
                  <EmptyTitle>
                    {outcome
                      ? "No calls match this filter"
                      : safePage > 1
                        ? "No calls on this page"
                        : "No calls yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {outcome
                      ? "Try a different outcome."
                      : safePage > 1
                        ? "Try an earlier page — calls are newest first."
                        : "Calls appear here after the first inbound or outbound call."}
                  </EmptyDescription>
                </EmptyHeader>
                {outcome ? (
                  <EmptyContent>
                    <Button
                      nativeButton={false}
                      render={<Link href="/calls" />}
                      variant="outline"
                      size="sm"
                    >
                      Clear the filter
                    </Button>
                  </EmptyContent>
                ) : null}
              </Empty>
            </TableCell>
          </TableRow>
        </TableBody>
      ) : (
        <>
          <TableBody>
            {rows.map((call) => {
              const label = call.name ?? call.phone;
              const directionLabel =
                call.direction === "inbound" ? "Inbound" : "Outbound";
              const absolute = absoluteCallTime(call.startedAt);
              return (
                <TableRow key={call.id}>
                  <TableCell>
                    <div className="flex min-w-0 flex-col gap-1">
                      <Link
                        href={`/calls/${call.id}`}
                        aria-label={`${directionLabel} call with ${label}, started ${absolute}`}
                        className="w-fit rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {label}
                      </Link>
                      {/* Phones: direction and time fold under the lead so
                          the table never scrolls sideways. */}
                      <span className="text-muted-foreground text-xs sm:hidden">
                        {directionLabel} · {relativeCallTime(call.startedAt)} ·{" "}
                        {callDuration(call.startedAt, call.endedAt)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
                    {directionLabel}
                  </TableCell>
                  {/* Relative first, absolute beneath: the full timestamp
                      reads without hover, and the link text carries it for
                      screen readers — no title-tooltip-only time. */}
                  <TableCell className="hidden text-sm sm:table-cell">
                    <span className="block">{relativeCallTime(call.startedAt)}</span>
                    <span className="text-muted-foreground block text-xs">
                      {absolute}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden font-mono text-xs tabular-nums sm:table-cell">
                    {callDuration(call.startedAt, call.endedAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          {safePage > 1 || hasNext ? (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={CALL_TABLE_COLUMNS}>
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-muted-foreground text-xs">
                      Page {safePage} of {totalPages}
                    </span>
                    {/* Table-05 pagination idiom (icon + numbered
                        buttons), kept on URL-param hrefs so the outcome
                        filter carries across pages. Touch target: min-h-11
                        toward the 44px floor (WCAG 2.5.8) — same size-11
                        precedent as the voice-card steppers. */}
                    <div className="flex items-center gap-1">
                      <Button
                        aria-label="Previous page"
                        nativeButton={false}
                        render={
                          <Link
                            href={callsPageHref(safePage - 1, outcome)}
                            aria-disabled={safePage <= 1}
                            tabIndex={safePage <= 1 ? -1 : undefined}
                          />
                        }
                        variant="outline"
                        size="icon"
                        className="min-h-11 min-w-11"
                        disabled={safePage <= 1}
                      >
                        <ChevronLeft className="size-4" />
                        <span className="sr-only">Previous page</span>
                      </Button>
                      {pageWindow.map((page, index) => (
                        <Fragment key={page}>
                          {index > 0 &&
                          page - pageWindow[index - 1] > 1 ? (
                            <span
                              aria-hidden="true"
                              className="text-muted-foreground px-1 text-xs"
                            >
                              …
                            </span>
                          ) : null}
                          <Button
                            aria-label={`Go to page ${page}`}
                            nativeButton={false}
                            render={
                              <Link
                                href={callsPageHref(page, outcome)}
                              />
                            }
                            variant={
                              safePage === page ? "default" : "outline"
                            }
                            size="icon"
                            className="min-h-11 min-w-11"
                          >
                            {page}
                          </Button>
                        </Fragment>
                      ))}
                      <Button
                        aria-label="Next page"
                        nativeButton={false}
                        render={
                          <Link
                            href={callsPageHref(safePage + 1, outcome)}
                            aria-disabled={!hasNext}
                            tabIndex={!hasNext ? -1 : undefined}
                          />
                        }
                        variant="outline"
                        size="icon"
                        className="min-h-11 min-w-11"
                        disabled={!hasNext}
                      >
                        <ChevronRight className="size-4" />
                        <span className="sr-only">Next page</span>
                      </Button>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            </TableFooter>
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * Curated filter chips resolve here — this leaf awaits searchParams, so the
 * shell stays URL-free (E1439). It renders above the table, never inside the
 * <table>: a <nav> child of <table> is invalid HTML and logs a hydration
 * error on every visit.
 */
async function CallsChips({
  searchParams,
}: {
  searchParams: Promise<CallsSearchParams>;
}) {
  const params = await searchParams;
  const active = normalizeCallOutcome(params.outcome);
  return <FilterChips label="Call filters" chips={callsChips(active)} />;
}

export default function CallsPage({ searchParams }: PageProps<"/calls">) {
  return (
    <div data-testid="calls-shell" className="flex flex-col gap-6">
      <PageHeading
        title="Calls"
        description="Every phone call, newest first, with who it was with and how long it ran."
      />
      <DataTable
        toolbar={
          <Suspense fallback={null}>
            <CallsChips searchParams={searchParams} />
          </Suspense>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead className="hidden sm:table-cell">Direction</TableHead>
              <TableHead className="hidden sm:table-cell">Started</TableHead>
              <TableHead className="hidden sm:table-cell">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <Suspense
            fallback={
              <TableBody>
                <TableRow>
                  <TableCell
                    colSpan={CALL_TABLE_COLUMNS}
                    className="h-40 text-center"
                  >
                    <span
                      role="status"
                      aria-label="Loading calls"
                      className="text-muted-foreground text-sm"
                    >
                      Loading calls…
                    </span>
                  </TableCell>
                </TableRow>
              </TableBody>
            }
          >
            <CallsRows searchParams={searchParams} />
          </Suspense>
        </Table>
      </DataTable>
    </div>
  );
}
