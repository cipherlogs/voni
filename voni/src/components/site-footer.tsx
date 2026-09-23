import type { ReactNode } from "react";
import { VoniLogo } from "@/components/voni-logo";

/* One gutter for the whole public surface, so the landing header, hero,
   feature grid, and auth frames all sit on the same measure. Matches the
   landing CONTAINER. */
const CONTAINER = "mx-auto w-full max-w-6xl px-6";

/**
 * Shared public footer language (ticket 02): the landing document and the
 * auth screens render the same brand mark, tagline, and year slot. The year
 * stays a caller-provided request-time leaf so each page keeps its own
 * prerenderable shell — see LandingPage FooterYear.
 */
export function SiteFooter({ year }: { year: ReactNode }) {
  return (
    <footer className="border-t">
      <div
        className={`${CONTAINER} text-muted-foreground flex flex-col items-center justify-between gap-4 py-8 text-sm sm:flex-row`}
      >
        <span className="flex items-center gap-2">
          <VoniLogo size="sm" />
          <span>It sees the lead. It seals the deal.</span>
        </span>
        {year}
      </div>
    </footer>
  );
}
