"use client";

import { ChevronDown } from "lucide-react";
import { CardTitle } from "@/components/ui/card";
import { CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * A card title that is also the fold trigger: a real button (the Base UI
 * primitive supplies `aria-expanded` and `aria-controls`), with the chevron
 * rotating from the collapsible root's own open state rather than from a
 * second copy of the boolean.
 *
 * The root must carry `group/card`; the rotation selector is scoped to it so a
 * nested collapsible cannot turn a sibling card's chevron.
 */
export type CollapsibleCardTitleProps = {
  icon: React.ReactNode;
  /** Stable id for the toggle; the card's own `data-testid` names it. */
  testId: string;
  children: React.ReactNode;
};

export function CollapsibleCardTitle({
  icon,
  testId,
  children,
}: CollapsibleCardTitleProps) {
  return (
    <CardTitle as="h3" className="flex min-w-0 items-center gap-2">
      <span className="text-muted-foreground" aria-hidden>
        {icon}
      </span>
      <CollapsibleTrigger
        className="focus-visible:ring-ring inline-flex cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2"
        data-testid={testId}
      >
        {children}
        <ChevronDown
          aria-hidden
          className="size-4 transition-transform group-data-[panel-open]/card:rotate-180"
        />
      </CollapsibleTrigger>
    </CardTitle>
  );
}
