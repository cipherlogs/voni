"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useCardDisclosure } from "@/components/card-disclosure";
import { CollapsibleCardTitle } from "@/components/collapsible-card-title";

/**
 * One source on the `/email` console: a card whose header always states the
 * four facts an operator must not have to open a card to see — the name, the
 * enabled state, the volume it commands and its worst health — and whose body
 * is the controls.
 *
 * The header lives *outside* `CollapsibleContent` on purpose. A collapsed card
 * that hides its volume or its failure is the one thing collapsing must never
 * do (spec: "a collapsed card can never hide volume or failure"), so the
 * summary is a sibling of the panel rather than the first row of it, and no
 * future card can put it back inside by accident.
 *
 * Sources start collapsed and remember the operator's choice per card, keyed
 * by `testId`; `useCardDisclosure` reads storage after mount so the server and
 * the first client render agree.
 *
 * `volume` is a value plus its own unit rather than a clicks-per-day number:
 * Grafana and GitHub command a rate, Burst commands a batch, and the header
 * should say which one it means.
 */

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

export type SourceCardSummary = {
  /** Enabled state, in the card's own words ("Live", "Paused", "On demand"). */
  status: { label: string; variant: BadgeVariant };
  /** The number and its unit, e.g. `{ value: "1,730", label: "clicks/day" }`. */
  volume: { value: string; label: string };
  /** Worst known health for this source. */
  health: { label: string; variant: BadgeVariant };
};

export type SourceCardProps = {
  /** Stable test id for the card and for each header fact. */
  testId: string;
  name: string;
  icon: React.ReactNode;
  description: React.ReactNode;
  summary: SourceCardSummary;
  children: React.ReactNode;
};

export function SourceCard({
  testId,
  name,
  icon,
  description,
  summary,
  children,
}: SourceCardProps) {
  const { open, onOpenChange } = useCardDisclosure(testId);

  return (
    <Card data-testid={testId}>
      <Collapsible
        open={open}
        onOpenChange={onOpenChange}
        className="group/card grid gap-(--card-spacing)"
      >
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <CollapsibleCardTitle
              icon={icon}
              testId={`${testId}-trigger`}
            >
              {name}
            </CollapsibleCardTitle>

            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={summary.status.variant}
                data-testid={`${testId}-status`}
              >
                {summary.status.label}
              </Badge>
              <span
                className="text-muted-foreground font-mono text-xs whitespace-nowrap"
                data-testid={`${testId}-volume`}
              >
                <span className="text-foreground font-medium">
                  {summary.volume.value}
                </span>{" "}
                {summary.volume.label}
              </span>
              <Badge
                variant={summary.health.variant}
                data-testid={`${testId}-health`}
              >
                {summary.health.label}
              </Badge>
            </div>
          </div>
          <CardDescription>{description}</CardDescription>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="border-t pt-(--card-spacing)">
            {children}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
