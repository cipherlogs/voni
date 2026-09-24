import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The detail-page backlink, shared by every "/thing/[id]" screen.
 *
 * Always a direct child of the page's `flex flex-col gap-6` column, rendered
 * in the static shell (outside Suspense) so it paints before the record
 * streams. `-mb-3` pulls the heading up so backlink → h1 is 12px on every
 * page; `-ml-4` (measured) cancels the button's inline-start icon padding
 * plus the 6px side bearing inside Lucide's chevron path, so the glyph's
 * ink — not its box — sits on the title's left edge. Muted, because it is a
 * breadcrumb, not a heading.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Button
      nativeButton={false}
      render={<Link href={href} aria-label={`Back to ${label}`} />}
      variant="link"
      className="text-muted-foreground hover:text-foreground -mb-3 -ml-4 h-auto w-fit gap-1 px-1 py-1 text-sm font-medium no-underline hover:no-underline [&>svg]:size-4"
    >
      <ChevronLeft data-icon="inline-start" aria-hidden />
      {label}
    </Button>
  );
}
