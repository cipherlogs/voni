"use client";

import { ChevronRight } from "lucide-react";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * The one "show more" trigger for a Collapsible: muted text with a chevron
 * that turns when open (Base UI sets `data-panel-open` on the trigger). Use
 * inside `Collapsible` with a `CollapsibleContent` sibling.
 */
export function DisclosureTrigger({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <CollapsibleTrigger
      className={cn(
        "group/disclosure text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex w-fit cursor-pointer items-center gap-1 rounded-sm text-sm outline-none focus-visible:ring-2",
        className,
      )}
    >
      <ChevronRight
        aria-hidden
        className="size-3.5 transition-transform duration-[var(--motion-fast)] group-data-[panel-open]/disclosure:rotate-90"
      />
      {children}
    </CollapsibleTrigger>
  );
}
