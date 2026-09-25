/**
 * The landing orb (DESIGN.md §10c): a CSS-3D wireframe sphere — nine
 * meridians and five latitudes, nothing at the center — with one signal
 * ring breathing outward. Pure CSS (globals.css `.landing-orb*`), so it
 * renders on the server and stops dead under `prefers-reduced-motion`.
 * Decorative only.
 *
 * `state` tints the wireframe by call state (idle monochrome, live states
 * green): the call surfaces pass their voice state, everything else stays
 * idle. Color lives in `--orb-tint` so no component ever names a shade.
 */
export type OrbState = "idle" | "connecting" | "listening" | "speaking" | "ended";

export function LandingOrb({
  size = "lg",
  state = "idle",
}: {
  size?: "sm" | "lg";
  state?: OrbState;
}) {
  return (
    <div aria-hidden="true" data-size={size} data-state={state} className="landing-orb">
      <span className="landing-orb-ping" />
      <div className="landing-orb-tilt">
        <div className="landing-orb-spin">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className="landing-orb-ring" />
          ))}
        </div>
      </div>
    </div>
  );
}
