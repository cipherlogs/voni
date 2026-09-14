import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type FilterChip = {
  label: string;
  href: string;
  active: boolean;
};

/**
 * Curated filter chips: static Link rows above a list table (All + the
 * dashboard outcomes — a fixed set, not user-persisted presets).
 * Presentational and server-rendered — the caller resolves `active` inside
 * its own Suspense leaf (which already awaits searchParams) so the page
 * shell never reads the URL (E1439). The leaf must render outside the
 * <table> element: this is a <nav>, and a <nav> child of <table> is
 * invalid HTML that logs a hydration error. Active chip carries
 * aria-current plus a Badge dot; inactive chips are ghost. Existing
 * Badge+Clear rows and Empty states are untouched.
 */
export function FilterChips({
  label,
  chips,
}: {
  label: string;
  chips: FilterChip[];
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <li key={chip.href}>
            <Button
              nativeButton={false}
              render={<Link href={chip.href} />}
              variant={chip.active ? "outline" : "ghost"}
              size="sm"
              aria-current={chip.active ? "page" : undefined}
              className="transition-colors duration-[var(--motion-fast)]"
            >
              {/* Always rendered so toggling the active state never shifts
                  chip width mid-read; hidden dot is opacity-0 + aria-hidden. */}
              <Badge
                aria-hidden="true"
                className={chip.active ? "size-1.5 rounded-full p-0" : "size-1.5 rounded-full p-0 opacity-0"}
              />
              {chip.label}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
