import type { Metadata } from "next";
import { SETTINGS_TILES, type SettingsTile, type TileValue } from "@/lib/settings-tiles";
import {
  BentoTile,
  CircuitScene,
  ClusterScene,
  EqScene,
  MarkWallScene,
  StackScene,
  ToggleScene,
  WaveScene,
} from "./tiles";

export const metadata: Metadata = {
  title: "Settings bento gallery (throwaway mockups)",
  robots: { index: false, follow: false },
};

const HERO_SPAN = "lg:col-span-2";

type TilePick = {
  value: TileValue;
  hero?: boolean;
  scene?: React.ReactNode;
  chromeless?: boolean;
};

const SCENE_ALTS: Record<string, React.ReactNode> = {
  markwall: <MarkWallScene />,
  eq: <EqScene />,
  circuit: <CircuitScene />,
  wave: <WaveScene />,
  cluster: <ClusterScene />,
  toggle: <ToggleScene />,
  stack: <StackScene />,
};

function VariantGrid({
  id,
  name,
  what,
  picks,
  chromeless,
}: {
  id: string;
  name: string;
  what: string;
  picks: ReadonlyArray<TilePick>;
  chromeless?: boolean;
}) {
  const byValue = new Map<string, SettingsTile>(SETTINGS_TILES.map((tile) => [tile.value, tile]));
  return (
    <section aria-label={`Variant ${id}: ${name}`} className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Variant {id} — {name}
        </h2>
        <p className="text-sm text-muted-foreground">{what}</p>
      </div>
      <div className="bento-grid-rows grid w-full grid-cols-1 gap-4 lg:grid-cols-3">
        {picks.map((pick) => {
          const tile = byValue.get(pick.value);
          if (!tile) return null;
          return (
            <BentoTile
              key={`${id}-${pick.value}`}
              tile={tile}
              className={pick.hero ? HERO_SPAN : undefined}
              scene={pick.scene}
              chromeless={chromeless}
            />
          );
        })}
      </div>
    </section>
  );
}

/**
 * Throwaway gallery v3 (ticket 01, deleted in ticket 08): ten faithful
 * variants, each a full 7-tile grid with a distinct hero background treatment
 * and layout. Static mock data; nothing prefetches. Section tiles point at
 * the live `/settings` page until ticket 02 makes `/settings/<tab>` real.
 */
const STANDARD: ReadonlyArray<TileValue> = [
  "services",
  "account",
  "voice",
  "workspace",
  "appearance",
  "numbers",
  "operator",
];

/** V01 proves the ticket-02 seam: baseline heroes come from the registry. */
const REGISTRY_HEROES: ReadonlyArray<TileValue> = SETTINGS_TILES.filter((tile) => tile.span === "hero").map(
  (tile) => tile.value,
);

function picks(
  order: ReadonlyArray<TileValue>,
  heroes: ReadonlyArray<TileValue> = [],
  scenes: Partial<Record<TileValue, React.ReactNode>> = {},
): ReadonlyArray<TilePick> {
  return order.map((value) => ({
    value,
    hero: heroes.includes(value) ? true : undefined,
    scene: scenes[value],
  }));
}

export default function SettingsGalleryPage() {
  return (
    <div className="flex flex-col gap-12">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings bento gallery</h1>
        <p className="text-sm text-muted-foreground">
          Ten faithful-composition variants for visual review — pick a winner and this whole
          route is deleted (ticket 08). Mock data throughout: beam, transcript, and mark-wall
          scenes loop live with CSS; the static scenes gain motion with the winning build and
          live badges arrive in ticket 04.
        </p>
      </div>

      <VariantGrid
        id="01"
        name="Baseline"
        what="Beam + transcript heroes from the registry, badges + per-tile verbs. The proven language."
        picks={picks(STANDARD, REGISTRY_HEROES)}
      />
      <VariantGrid
        id="02"
        name="Mark-wall"
        what="Services hero swaps the beam for a truthful mark-wall marquee; Voice standard."
        picks={picks(["services", "voice", "account", "workspace", "appearance", "numbers", "operator"], ["services"], { services: SCENE_ALTS.markwall })}
      />
      <VariantGrid
        id="03"
        name="Equalizer"
        what="Voice hero swaps the transcript for full-bleed EQ bars; Services standard."
        picks={picks(["voice", "services", "account", "workspace", "appearance", "numbers", "operator"], ["voice"], { voice: SCENE_ALTS.eq })}
      />
      <VariantGrid
        id="04"
        name="Circuit"
        what="Services hero with straight angular circuit lines instead of curves."
        picks={picks(["services", "account", "voice", "workspace", "appearance", "numbers", "operator"], ["services"], { services: SCENE_ALTS.circuit })}
      />
      <VariantGrid
        id="05"
        name="Waveform"
        what="Voice hero with a waveform line instead of the transcript list."
        picks={picks(["voice", "account", "services", "workspace", "appearance", "numbers", "operator"], ["voice"], { voice: SCENE_ALTS.wave })}
      />
      <VariantGrid
        id="06"
        name="Cluster"
        what="Account hero with an identity cluster; Services keeps the beam at standard span."
        picks={picks(["account", "services", "voice", "workspace", "appearance", "numbers", "operator"], ["account"], { account: SCENE_ALTS.cluster })}
      />
      <VariantGrid
        id="07"
        name="Toggle"
        what="Appearance hero with a sliding theme toggle; editorial order."
        picks={picks(["appearance", "services", "voice", "account", "workspace", "numbers", "operator"], ["appearance"], { appearance: SCENE_ALTS.toggle })}
      />
      <VariantGrid
        id="08"
        name="Stack"
        what="Numbers hero with a number stack (external tile as hero test)."
        picks={picks(["numbers", "services", "voice", "account", "workspace", "appearance", "operator"], ["numbers"], { numbers: SCENE_ALTS.stack })}
      />
      <VariantGrid
        id="09"
        name="Uniform quiet"
        what="No heroes: every tile standard span with its proven scene. Calmest grid."
        picks={picks(STANDARD)}
      />
      <VariantGrid
        id="10"
        name="Pure demo"
        what="Baseline heroes with badges + per-tile verbs stripped (generic Learn more) — closest to the reference, for judging our two deviations."
        picks={picks(STANDARD, ["services", "voice"])}
        chromeless
      />
    </div>
  );
}
