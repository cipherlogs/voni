import { VoniMark } from "@/components/voni-logo";

import { cn } from "@/lib/utils";

/**
 * Animated brand for the sidebar-03 header slot — Classic motion (the
 * homepage loop verbatim).
 *
 * - Expanded: the wordmark lockup loops for as long as it stays mounted
 *   (tight construction: cropped mark against "oni", mirroring the inline
 *   wordmark): the resting arc folds into the V and back, the green accent
 *   landing on the moment of recognition.
 * - Collapsed: the rail stays calm — resting arc in the chip, one-shot
 *   `voni-chip-in` on mount, no loop.
 *
 * Theme comes from `currentColor` + tokens, so there are no theme-specific
 * assets and no theme-conditional utilities. Decorative: callers pair it with an
 * sr-only label.
 */
export function BrandLogo({
  density,
  size = "header",
  className,
}: {
  density: "expanded" | "collapsed";
  /** `header` fills the sidebar-03 brand slot; `mark` fits small slots (team switcher). */
  size?: "header" | "mark";
  className?: string;
}) {
  const compact = size === "mark";

  if (density === "collapsed") {
    return (
      <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center", className)}>
        <span
          className={cn(
            "voni-chip-in inline-flex items-center justify-center rounded-md border bg-card text-card-foreground",
            compact ? "size-4" : "size-8",
          )}
        >
          <VoniMark className={compact ? "size-2.5" : "size-4"} />
        </span>
      </span>
    );
  }

  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center", compact ? "h-4" : "h-8", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-0.5 font-semibold tracking-tight text-sidebar-foreground",
          compact ? "text-xs" : "text-sm",
        )}
      >
        <VoniMark animate viewBox="3 7 18 11" className={compact ? "size-4" : "size-5"} />
        oni
      </span>
    </span>
  );
}
