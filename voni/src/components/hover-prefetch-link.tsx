"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * Hover-intent prefetch link (ticket 06).
 *
 * Canonical pattern from the Next.js prefetching guide
 * (`docs/01-app/02-guides/prefetching.md` §"Hover-triggered prefetch"):
 * dead at rest (`prefetch={false}` — viewport entry fetches nothing, so a
 * tile grid never avalanches), default static prefetch once the user shows
 * intent (`prefetch={null}`). `setActive(true)` is idempotent, so repeat
 * hovers never re-fire. Keyboard focus arms exactly like hover (ticket 06
 * checkbox); touch users navigate normally with no prefetch, same as rest.
 * Native `Link` prefetching only — never a hand-rolled fetch island
 * (the guide's "proceed with caution": no self-maintained cache
 * invalidation).
 *
 * `enabled={false}` keeps prefetching off entirely, even on intent — for
 * prefetch-silent venues.
 */
export function HoverPrefetchLink({
  href,
  ariaLabel,
  className,
  enabled = true,
  children,
}: {
  href: string;
  ariaLabel: string;
  className?: string;
  enabled?: boolean;
  children: React.ReactNode;
}) {
  const [active, setActive] = useState(false);

  return (
    <Link
      href={href}
      prefetch={enabled ? (active ? null : false) : false}
      onMouseEnter={() => setActive(true)}
      onFocus={() => setActive(true)}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </Link>
  );
}
