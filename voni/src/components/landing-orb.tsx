import { VoniMark } from "@/components/voni-logo";

/**
 * The landing orb (DESIGN.md §10c): a CSS-3D wireframe sphere, nine meridians
 * and five latitudes spinning around the animated Voni mark (it rests on the V), with one green signal ring
 * breathing outward. Pure CSS (globals.css `.landing-orb*`), so it renders on
 * the server and stops dead under `prefers-reduced-motion`. Decorative only.
 */
export function LandingOrb({ size = "lg" }: { size?: "sm" | "lg" }) {
  return (
    <div aria-hidden="true" data-size={size} className="landing-orb">
      <span className="landing-orb-ping" />
      <div className="landing-orb-tilt">
        <div className="landing-orb-spin">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className="landing-orb-ring" />
          ))}
        </div>
        <div className="landing-orb-core">
          <VoniMark animate className="size-1/2" />
        </div>
      </div>
    </div>
  );
}
