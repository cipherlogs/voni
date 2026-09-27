import type { ReactNode } from "react";
import { connection } from "next/server";
import { VoniLogo } from "@/components/voni-logo";

import { PUBLIC_CONTAINER } from "@/lib/public-container";

export { PUBLIC_CONTAINER };

/**
 * Request-time footer leaf: isolates the current-year read so each
 * public-page frame prerenders without awaiting request data. Shared by
 * the landing document and the auth screens behind their own Suspense
 * boundaries — see LandingPage.
 */
export async function FooterYear() {
  // Request-time leaf: runs per request behind its boundary, never in the
  // static shell.
  await connection();
  return <>© {new Date().getFullYear()} Voni</>;
}

/**
 * Shared public footer language (ticket 02): the landing document and the
 * auth screens render the same brand mark, slogan, and year slot. The year
 * stays a caller-provided request-time leaf so each page keeps its own
 * prerenderable shell — see LandingPage FooterYear.
 */
export function SiteFooter({ year }: { year: ReactNode }) {
  return (
    <footer className="border-t">
      <div
        className={`${PUBLIC_CONTAINER} text-muted-foreground flex flex-col items-center justify-between gap-4 py-8 text-sm sm:flex-row`}
      >
        <span className="flex items-center gap-2">
          <VoniLogo size="sm" />
          <span>Every call ends with the work already done.</span>
        </span>
        {year}
      </div>
    </footer>
  );
}
