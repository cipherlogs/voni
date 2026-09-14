/**
 * The copilot's mark: four rounded bars in a flat disc, no stock mic glyph.
 * Static in every mood — the `copilot-bars-live` animation loop is culled
 * (DESIGN.md §2 motion cull), so speaking reads via `text-primary` color,
 * never motion. Reduced-motion needs no per-component query: there is
 * nothing to squash.
 */

export type VoiceBarsMood = "idle" | "connecting" | "listening" | "speaking";

const BARS = [
  { x: 3.5, height: 7 },
  { x: 8.5, height: 13 },
  { x: 13.5, height: 13 },
  { x: 18.5, height: 7 },
];

export function VoiceBars({
  mood,
  className,
}: {
  mood: VoiceBarsMood;
  className?: string;
}) {
  const speaking = mood === "speaking";
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={speaking ? `text-primary ${className ?? ""}` : className}
      fill="currentColor"
    >
      {BARS.map((bar) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={(24 - bar.height) / 2}
          width={2.5}
          height={bar.height}
          rx={1.25}
          opacity={mood === "idle" ? 0.85 : 1}
        />
      ))}
    </svg>
  );
}
