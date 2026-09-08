/**
 * The copilot's mark: four rounded bars in a flat disc, no stock mic glyph.
 * Bars animate while the copilot speaks; listening/idle states stay static.
 * Reduced-motion is handled globally (globals.css squashes all animation).
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
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={mood === "speaking" ? `copilot-bars-live ${className ?? ""}` : className}
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
