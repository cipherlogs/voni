import type { Metadata } from "next";
import { SETTINGS_TILES, type SettingsTile } from "@/lib/settings-tiles";
import { MarqueeMini, MockTile } from "./tiles";

export const metadata: Metadata = {
  title: "Settings bento gallery (throwaway mockups)",
  robots: { index: false, follow: false },
};

const HERO_SPAN = "lg:col-span-2";

type TilePick = { value: string; span?: "hero" | "standard"; miniature?: React.ReactNode };

function VariantSection({
  number,
  name,
  intent,
  picks,
}: {
  number: string;
  name: string;
  intent: string;
  picks: ReadonlyArray<TilePick>;
}) {
  const byValue = new Map<string, SettingsTile>(SETTINGS_TILES.map((tile) => [tile.value, tile]));
  return (
    <section aria-label={`Variant ${number}: ${name}`} className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Variant {number} — {name}
        </h2>
        <p className="text-sm text-muted-foreground">{intent}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {picks.map((pick) => {
          const tile = byValue.get(pick.value);
          if (!tile) return null;
          return (
            <MockTile
              key={`${number}-${pick.value}`}
              tile={tile}
              miniature={pick.miniature}
              spanClassName={pick.span === "hero" ? HERO_SPAN : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

const STANDARD_ORDER: ReadonlyArray<TilePick> = [
  { value: "services" },
  { value: "voice" },
  { value: "account" },
  { value: "workspace" },
  { value: "appearance" },
  { value: "numbers" },
  { value: "operator" },
];

function withHero(value: string): ReadonlyArray<TilePick> {
  return [{ value, span: "hero" }, ...STANDARD_ORDER.filter((pick) => pick.value !== value)];
}

/**
 * Throwaway mockup gallery (ticket 01, deleted in ticket 08). Static mock
 * data, hover transitions only — looping motion arrives with the winning
 * variant in ticket 05. Section tiles point at the live `/settings` page
 * until ticket 02 makes the planned `/settings/<tab>` routes real; numbers
 * and operator link for real. Nothing here prefetches.
 */
export default function SettingsGalleryPage() {
  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings bento gallery</h1>
        <p className="text-sm text-muted-foreground">
          Throwaway mockups for visual review — pick a winner and this whole route is deleted
          (ticket 08). Tiles are keyboard-reachable links with mock badges; looping motion and
          live data arrive with the winning build.
        </p>
      </div>

      <VariantSection
        number="01"
        name="Beam hero"
        intent="Services spans two columns: provider nodes hand work to one agent. Everything else standard."
        picks={withHero("services")}
      />
      <VariantSection
        number="02"
        name="Equalizer hero"
        intent="Voice copilot spans two columns with equalizer bars. Best when voice is the story."
        picks={withHero("voice")}
      />
      <VariantSection
        number="03"
        name="Session handoff hero"
        intent="Account spans two columns: identity hands off to a Voni session with a confirmed check."
        picks={withHero("account")}
      />
      <VariantSection
        number="04"
        name="Theme split hero"
        intent="Appearance spans two columns with a light/dark split preview."
        picks={withHero("appearance")}
      />
      <VariantSection
        number="05"
        name="Defaults stack hero"
        intent="Workspace spans two columns showing stacked customer-facing defaults."
        picks={withHero("workspace")}
      />
      <VariantSection
        number="06"
        name="Wiring hero"
        intent="Phone numbers spans two columns: a number wires to its agent."
        picks={withHero("numbers")}
      />
      <VariantSection
        number="07"
        name="Meters hero"
        intent="Platform operator spans two columns with readiness meters. Admin-gated in the real landing."
        picks={withHero("operator")}
      />
      <VariantSection
        number="08"
        name="Mark wall hero"
        intent="Services hero shows the truthful mark wall: real providers plus readiness only, no vapor integrations."
        picks={[
          { value: "services", span: "hero", miniature: <MarqueeMini /> },
          ...STANDARD_ORDER.filter((pick) => pick.value !== "services"),
        ]}
      />
      <VariantSection
        number="09"
        name="Uniform quiet"
        intent="No heroes: every tile the same span with its live miniature. Calmest baseline, cheapest motion budget."
        picks={STANDARD_ORDER}
      />
      <VariantSection
        number="10"
        name="Editorial asymmetric"
        intent="One hero (voice) with voice-first ordering; services keeps its beam at standard span."
        picks={[
          { value: "voice", span: "hero" },
          { value: "services" },
          { value: "account" },
          { value: "workspace" },
          { value: "appearance" },
          { value: "numbers" },
          { value: "operator" },
        ]}
      />
    </div>
  );
}
