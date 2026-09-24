"use client";

import Link from "next/link";
import { Check, ListFilter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type FilterChip = {
  label: string;
  href: string;
  active: boolean;
};

/**
 * List filter (blocks.so dashboard-01): a "Filter" menu of link items plus
 * one removable pill naming the active filter. The first chip is "All" and
 * is what the pill's × returns to. Options are links, so filters stay in the
 * URL; the caller resolves `active` inside its own Suspense leaf so the page
 * shell never reads the URL (E1439).
 */
export function FilterChips({
  label,
  chips,
}: {
  label: string;
  chips: FilterChip[];
}) {
  const all = chips[0];
  const active = chips.find((chip) => chip.active);
  const filtered = active && active !== all;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" aria-label={label} />}
        >
          <ListFilter data-icon="inline-start" />
          Filter
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            {chips.map((chip) => (
              <DropdownMenuItem
                key={chip.href}
                render={<Link href={chip.href} aria-current={chip.active ? "page" : undefined} />}
              >
                {chip.label}
                {chip.active ? <Check className="ml-auto" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {filtered ? (
        <span className="bg-muted inline-flex h-7 items-center gap-1 rounded-md pr-1 pl-2.5 text-sm">
          {active.label}
          <Link
            href={all.href}
            aria-label={`Clear filter: ${active.label}`}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 items-center justify-center rounded-sm outline-none focus-visible:ring-3"
          >
            <X className="size-3.5" />
          </Link>
        </span>
      ) : null}
    </div>
  );
}
