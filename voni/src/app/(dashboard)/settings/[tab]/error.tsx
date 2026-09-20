"use client";

import { RouteError } from "@/components/route-error";

/**
 * Section-scoped error (ticket 03): a failure inside one `/settings/<tab>`
 * data leaf renders here, inside the shared section shell — so the BackLink
 * + registry heading from `[tab]/layout.tsx` persist and the landing (a
 * sibling route) is never disturbed. Retry re-fetches just this section.
 */
export default function Error(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError {...props} />;
}
