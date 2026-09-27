import { cn } from "@/lib/utils";

/**
 * The Voni mark: a single calm V that, once a loop, opens into the
 * resting arc and eases back. Both shapes are the same kind of
 * curve (one quadratic bezier, control point mirrored across y=12), so the
 * browser can animate the `d` property directly between them instead of
 * cross-fading two separate drawings.
 *
 * Kept in sync by hand with `src/app/icon.svg`, which draws the resting V
 * at the same coordinates. The favicon can't import this file or run the
 * loop, so if the geometry changes here, change the resting shape there too.
 */

const SIZES = {
  sm: { chip: "size-7 rounded-md", mark: "size-4", word: "text-sm" },
  md: { chip: "size-9 rounded-lg", mark: "size-5", word: "text-sm" },
  lg: { chip: "size-12 rounded-lg", mark: "size-7", word: "text-lg" },
} as const;

export type VoniLogoSize = keyof typeof SIZES;

const V_PATH = "M5 9Q12 24 19 9";

/**
 * The bare stroke, inheriting `currentColor`. Use when you supply your own
 * container.
 *
 * `animate` loops for as long as the mark stays mounted: the V holds, opens
 * into the arc, and folds back — a second copy of the same path in the brand
 * green (`voni-arc-accent`) tracks the identical shape and only fades in for
 * the V phase, so the color change lands on the moment of recognition rather
 * than fighting it.
 */
export function VoniMark({
  animate = false,
  className,
  viewBox = "0 0 24 24",
}: {
  animate?: boolean;
  className?: string;
  /** Crop into the mark's coordinate space — see the `wordmark` lockup below. */
  viewBox?: string;
}) {
  return (
    <svg viewBox={viewBox} fill="none" aria-hidden="true" className={className}>
      <path
        d={V_PATH}
        strokeWidth={2.75}
        strokeLinecap="round"
        // `stroke` is a real CSS declaration on `.voni-arc` (see globals.css),
        // not a presentation attribute here — Chromium can lose track of a
        // presentation-attribute `currentColor` on a path whose `d` is being
        // animated via CSS, repainting it black regardless of theme.
        className={animate ? "voni-arc" : undefined}
        style={animate ? undefined : { stroke: "currentColor" }}
      />
      {animate ? <path d={V_PATH} strokeWidth={2.75} strokeLinecap="round" className="voni-arc-accent" /> : null}
    </svg>
  );
}

/**
 * The mark, in one of two lockups:
 *
 * - Minimal (`wordmark` off): the mark alone in its fixed light chip — use
 *   this everywhere the mark has to hold its own at small sizes (nav rails,
 *   compact headers, anywhere the full name doesn't fit or isn't needed).
 * - Full (`wordmark` on): no chip — the bare V stands in for the "V" and
 *   sits directly against "oni", so the animated mark itself spells "Voni"
 *   rather than sitting next to a separate repeat of the name. Reserve this
 *   for places that can afford the full lockup's width and where the brand
 *   deserves the fuller treatment (the home page, auth screens) — everywhere
 *   else, use the minimal mark.
 *
 * `animate` is opt-in on both: it belongs on arrival moments, not every
 * instance, so the mark can also sit still in dense UI. Where it's on, it
 * loops for as long as the mark stays mounted.
 */
export function VoniLogo({
  size = "md",
  wordmark = false,
  animate = false,
  className,
}: {
  size?: VoniLogoSize;
  wordmark?: boolean;
  animate?: boolean;
  className?: string;
}) {
  const scale = SIZES[size];

  if (wordmark) {
    return (
      <span
        className={cn(
          "inline-flex items-baseline font-semibold tracking-tight",
          scale.word,
          className,
        )}
      >
        <VoniMark
          animate={animate}
          // The full 0–24 viewBox has a lot of empty padding around the
          // ink (a quadratic curve's peak only reaches the midpoint between
          // its control point and endpoints, so the arc's actual stroke is
          // shallower than the box suggests) — sizing off that box either
          // renders tiny or, scaled up to compensate, swamps "oni" with
          // whitespace. Cropping tightly to where the ink actually lives
          // across both the arc and V phases sizes and aligns it like a
          // real inline glyph instead.
          viewBox="3 7 18 11"
          className="mr-[0.06em] inline-block h-[0.85em] w-[1.39em] shrink-0 translate-y-[0.12em]"
        />
        oni
      </span>
    );
  }

  return (
    <span
      className={cn(
        // Light paper chip with ink mark in light mode — same pair
        // `src/app/icon.svg` hardcodes for the favicon, which can't be
        // theme-reactive. The hairline border is load-bearing there, where
        // the page background is nearly the same shade as the chip itself.
        // In dark mode this inverts to a dark chip with a light mark —
        // without that, the light-mode chip reads as a stray white square
        // against the dark sidebar instead of a brand mark.
        "inline-flex shrink-0 items-center justify-center border bg-card text-card-foreground",
        scale.chip,
        animate && "voni-chip-in",
        className,
      )}
    >
      <VoniMark animate={animate} className={scale.mark} />
    </span>
  );
}
