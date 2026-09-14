import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The detail-page backlink, shared by every "/thing/[id]" screen.
 *
 * Metrics come from the approved agent-detail mockup's `.backlink`: 14px/500
 * in the foreground colour, 6px gap, 8px/4px padding, an 8px radius, and an
 * underline on hover rather than a filled ghost-button hover. Kept here rather
 * than inlined on one page so the five callers cannot drift apart.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Button
      nativeButton={false}
      render={<Link href={href} aria-label={`Back to ${label}`} />}
      variant="link"
      className="h-auto w-fit cursor-pointer gap-1.5 rounded-lg px-1 py-2 text-sm font-medium text-foreground no-underline hover:underline [&>svg]:size-4"
    >
      <ChevronLeft data-icon="inline-start" aria-hidden />
      {label}
    </Button>
  );
}
