import { Suspense } from "react";
import Link from "next/link";
import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { RouteBrief } from "@/components/copilot/route-brief";
import { listCalls } from "@/lib/copilot/detail-data";
import { callDuration, relativeCallTime } from "@/lib/calls/format";

const CALLS_PAGE_SIZE = 20;
const CALL_TABLE_COLUMNS = 4;

/**
 * Calls index: every call in the org, newest first, 20 per page. Rows link
 * to /calls/[id] detail. Mirrors the leads table shape (header, table,
 * suspense leaf, skeleton fallback) per the shared list pattern.
 *
 * Out-of-range pages render an Empty state, not a 404 — a guessed ?page=
 * is a navigation slip, not a missing resource.
 */
async function CallsRows({ page }: { page: number }) {
  const { rows, page: safePage } = await listCalls(page, CALLS_PAGE_SIZE);
  // Whether a next page exists: one extra row would prove it. listCalls
  // caps at pageSize, so a full page means "maybe more".
  const hasNext = rows.length === CALLS_PAGE_SIZE;

  return (
    <>
      <RouteBrief
        route="/calls"
        brief={`Call history: page ${safePage} with lead, direction, start time, and duration. Voice reads here.`}
      />
      {rows.length === 0 ? (
        <div className="p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Phone />
              </EmptyMedia>
              <EmptyTitle>
                {safePage > 1 ? "No calls on this page" : "No calls yet"}
              </EmptyTitle>
              <EmptyDescription>
                {safePage > 1
                  ? "Try an earlier page — calls are newest first."
                  : "Calls appear here after the first inbound or outbound call."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <>
          <TableBody>
            {rows.map((call) => {
              const label = call.name ?? call.phone;
              const directionLabel =
                call.direction === "inbound" ? "Inbound" : "Outbound";
              return (
                <TableRow key={call.id}>
                  <TableCell>
                    <Link
                      href={`/calls/${call.id}`}
                      aria-label={`${directionLabel} call with ${label}`}
                      className="cursor-pointer rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {label}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        call.direction === "inbound" ? "default" : "secondary"
                      }
                    >
                      {directionLabel}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground text-sm"
                    title={call.startedAt?.toISOString() ?? undefined}
                  >
                    {relativeCallTime(call.startedAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
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
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      nativeButton={false}
                      render={
                        <Link
                          href={
                            safePage > 2
                              ? `/calls?page=${safePage - 1}`
                              : "/calls"
                          }
                          aria-disabled={safePage <= 1}
                          tabIndex={safePage <= 1 ? -1 : undefined}
                        />
                      }
                      variant="outline"
                      size="sm"
                      disabled={safePage <= 1}
                    >
                      Previous
                    </Button>
                    <span className="text-muted-foreground text-xs">
                      Page {safePage}
                    </span>
                    <Button
                      nativeButton={false}
                      render={
                        <Link
                          href={`/calls?page=${safePage + 1}`}
                          aria-disabled={!hasNext}
                          tabIndex={!hasNext ? -1 : undefined}
                        />
                      }
                      variant="outline"
                      size="sm"
                      disabled={!hasNext}
                    >
                      Next
                    </Button>
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

export default async function CallsPage({
  searchParams,
}: PageProps<"/calls">) {
  const params = await searchParams;
  const raw = Array.isArray(params.page) ? params.page[0] : params.page;
  const parsed = Number(raw);
  // Clamp here so the shell never renders a nonsense page; listCalls
  // clamps again defensively for direct callers.
  const page = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
  return (
    <div data-testid="calls-shell" className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calls</h1>
          <p className="text-muted-foreground text-sm">
            Every phone call, newest first, with who it was with and how long
            it ran.
          </p>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
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
                <CallsRows page={page} />
              </Suspense>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
