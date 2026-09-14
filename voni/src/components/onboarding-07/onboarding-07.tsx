/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/onboarding-07` (https://blocks.so/r/onboarding-07.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: progress-meters-on-top + single "Logs
 * overview" accordion-item idiom kept (upstream layout: three side-by-side
 * meters, logs item below); live agent entries arrive via props (no static
 * initialSteps, no demo setInterval animation, no handleRunAgain rerun —
 * retry lives in the page's Alert + LoadingButton); the logs item starts
 * COLLAPSED (upstream defaultValue={['logs']} flipped to closed);
 * deployment errors surface on the always-visible meter row plus an error
 * line, so failures never hide inside the collapsed panel; min-h-dvh
 * centered wrapper NOT adopted (statusline renders inline);
 * @tabler/icons-react REJECTED -> lucide (Check for finished, LoaderCircle
 * spinner for in-progress, TriangleAlert for error, ring dot for queued);
 * space-x/space-y stacks rebuilt as flex+gap.
 * +0 npm deps; cn from @/lib/utils.
 */

"use client";

import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Progress } from "@/components/ui/progress";
import type { TimelineEntry } from "@/components/onboarding-06/onboarding-06";
import { cn } from "@/lib/utils";

export type PipelineState = TimelineEntry["state"];

function MeterIcon({ state }: { state: PipelineState }) {
  if (state === "done") {
    return <Check aria-hidden className="size-4 shrink-0 text-primary" />;
  }
  if (state === "error") {
    return (
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
    );
  }
  if (state === "current") {
    return (
      <LoaderCircle
        aria-hidden
        className="size-4 shrink-0 animate-spin text-primary"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="size-3 shrink-0 rounded-full border border-border bg-background ring-4 ring-background"
    />
  );
}

function PipelineMarker({ state }: { state: PipelineState }) {
  if (state === "done") {
    return <Check aria-hidden className="size-5 text-primary" />;
  }
  if (state === "error") {
    return <TriangleAlert aria-hidden className="size-4 text-destructive" />;
  }
  if (state === "current") {
    return (
      <div
        aria-hidden
        className="size-2.5 rounded-full bg-primary ring-4 ring-background"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="size-3 rounded-full border border-border bg-background ring-4 ring-background"
    />
  );
}

/** Meter fill per entry state. In-progress mirrors the upstream 45% step. */
function meterValue(state: PipelineState): number {
  if (state === "current") return 45;
  if (state === "neutral" || state === "upcoming") return 0;
  return 100;
}

interface Onboarding07Props {
  title?: string;
  description?: string;
  entries: TimelineEntry[];
  /** Logs item starts collapsed — progress and errors stay visible. */
  defaultOpen?: boolean;
  children?: ReactNode;
}

/**
 * Deploy-pipeline statusline: an always-visible header with one progress
 * meter per entry, an always-visible error line when the latest entry
 * failed, and a single collapsed "Logs overview" accordion item holding the
 * full timeline rows.
 */
export default function Onboarding07({
  title = "Agent status",
  description,
  entries,
  defaultOpen = false,
  children,
}: Onboarding07Props) {
  const deploymentEntry = entries.at(-1);
  const latestTitle = deploymentEntry?.title ?? "";

  return (
    <section className="w-full sm:max-w-lg">
      <h3 className="font-medium text-foreground">{title}</h3>
      {description ? (
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="mt-6 flex items-center gap-2">
        {entries.map((entry) => (
          <div className="min-w-0 flex-1" key={entry.id}>
            <Progress
              value={meterValue(entry.state)}
              className={cn(
                "[&_[data-slot=progress-track]]:h-1.5",
                entry.state === "error" &&
                  "[&_[data-slot=progress-indicator]]:bg-destructive",
              )}
            />
            <div className="mt-2 flex min-w-0 items-center gap-1">
              <MeterIcon state={entry.state} />
              <p className="truncate text-xs text-muted-foreground">
                {entry.title}
              </p>
            </div>
          </div>
        ))}
      </div>
      {deploymentEntry?.state === "error" ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-destructive">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{deploymentEntry.description}</span>
        </p>
      ) : null}
      <Accordion
        className="mt-8"
        defaultValue={defaultOpen ? ["logs"] : []}
      >
        <AccordionItem className="rounded-sm border-b-0" value="logs">
          <AccordionTrigger>
            <span className="min-w-0 flex-1 truncate text-left">
              Logs overview ({entries.length})
              {latestTitle ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  &#8729; {latestTitle}
                </span>
              ) : null}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            {children ?? (
              <ul className="mt-2 flex flex-col gap-6 pb-2">
                {entries.map((entry, entryIdx) => (
                  <li className="relative flex gap-x-3" key={entry.id}>
                    <div
                      className={cn(
                        "absolute top-0 left-0 flex w-6 justify-center",
                        entryIdx === entries.length - 1 ? "h-6" : "-bottom-6",
                      )}
                    >
                      <span aria-hidden className="w-px bg-border" />
                    </div>
                    <div className="flex items-start gap-2.5">
                      <div className="relative flex size-6 flex-none items-center justify-center bg-background">
                        <PipelineMarker state={entry.state} />
                      </div>
                      <div>
                        <p className="mt-0.5 font-medium text-foreground text-sm">
                          {entry.title}
                          {entry.time ? (
                            <span className="font-normal text-muted-foreground/60">
                              {" "}
                              &#8729; {entry.time}
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-muted-foreground text-sm leading-6">
                          {entry.description}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
}
