"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CardContent } from "@/components/ui/card";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  ACCENT_FLAG,
  ACCENT_LABEL,
  INPUT_LANGUAGES,
  voicesByLanguage,
  voiceLabel,
  type Voice,
} from "@/lib/agents/voices";
import {
  voiceForLanguage,
  type ConversationLanguage,
} from "@/lib/agents/wizard";
/**
 * Voice cards in the `@blocks-so/grid-list-02` idiom (reference
 * `src/components/grid-list-02/grid-list-02.tsx`): Card surface
 * (border + shadow-sm, hover:border-muted-foreground + hover:shadow-md),
 * CardContent-equivalent row (flex items-center gap-4 p-4), Avatar size-10.
 * Carousel interaction below is byte-identical to the previous revision: Embla
 * opts align:center containScroll:false loop:false, setApi/scrollSnapList dots,
 * mount-only instant scrollTo, selectVoice the sole scrollTo (reduced-motion
 * aware), previewVoice never scrolls, clips at /voices/<id>.mp3.
 *
 * Leading avatar slot: a local illustrative portrait
 * (`public/voices/avatars/<voice-id>.webp`, ~96px square) with the initial as
 * the loading/error fallback. The portraits are illustrative placeholders, not
 * the real voice talent, and `presents` is an inferred UI field, not a
 * documented voice property. `jean` (unspecified/Neutral) has no portrait —
 * its initials tile is the whole avatar, so nothing mis-cues a gender.
 * While its preview clip plays the fallback washes
 * with a static primary tint (no bespoke gradient, no keyed fill — the
 * selection + indicator carry the playing state).
 */

/** Voice ids with no portrait asset — initials tile is the whole avatar. */
const PORTRAITLESS = new Set(["jean"]);

function VoiceCardAvatar({
  voiceId,
  playing,
}: {
  voiceId: string;
  playing: boolean;
}) {
  const label = voiceLabel(voiceId);
  return (
    <Avatar className="size-10">
      {/* Dev note: illustrative portrait, not the real talent. */}
      {PORTRAITLESS.has(voiceId) ? null : (
        <AvatarImage
          src={`/voices/avatars/${voiceId}.webp`}
          alt=""
          aria-hidden
        />
      )}
      <AvatarFallback
        className={cn(
          "bg-muted text-foreground text-sm font-semibold",
          playing && "bg-primary/10 text-primary",
        )}
      >
        <span aria-hidden>{label.charAt(0)}</span>
      </AvatarFallback>
    </Avatar>
  );
}

export type VoiceFieldProps = {
  language: ConversationLanguage;
  voiceId: string;
  /** Atomic language+voice update — the picker never leaves them mismatched. */
  onChange: (next: { language: ConversationLanguage; voiceId: string }) => void;
  id?: string;
  description?: string;
};

const GROUPS = voicesByLanguage();
const SPEAKABLE = INPUT_LANGUAGES.filter((l) => l.canSpeak);

function flagFor(code: string) {
  return SPEAKABLE.find((l) => l.code === code)?.flag ?? "";
}

function presentsLabel(voice: Voice) {
  return voice.presents === "unspecified" ? "Neutral" : voice.presents;
}

/** One clip at a time; leaving the step stops playback. */
function useVoicePreview() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  // Real clip length for the fill sweep; 3s fallback until metadata loads.
  const [previewDuration, setPreviewDuration] = useState(3);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const stopPreview = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingId(null);
  };

  const togglePreview = (voice: Voice) => {
    if (playingId === voice.id) {
      stopPreview();
      return;
    }
    if (audioRef.current) audioRef.current.pause();
    const audio = new Audio(`/voices/${voice.id}.mp3`);
    audioRef.current = audio;
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) setPreviewDuration(audio.duration);
    };
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
    setPlayingId(voice.id);
    void audio.play().catch(() => setPlayingId(null));
  };

  return { playingId, previewDuration, stopPreview, togglePreview };
}

/** Language chips filter the voices. */
function LanguageChips({
  language,
  onValueChange,
}: {
  language: string;
  onValueChange: (codes: string[]) => void;
}) {
  return (
    <ToggleGroup
      value={[language]}
      onValueChange={onValueChange}
      aria-label="Spoken language"
      className="flex-wrap justify-start"
    >
      {GROUPS.map((g) => (
        <ToggleGroupItem key={g.code} value={g.code} aria-label={g.language}>
          <span aria-hidden>{flagFor(g.code)}</span> {g.language}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * Merged language + voice picker. One decision: the language chips filter the
 * voice cards, and choosing a voice sets its language implicitly. Each card
 * IS the preview control — clicking it selects the voice and plays its real
 * AssemblyAI clip (`public/voices`), with a washed avatar + live indicator
 * tracking playback. Clicking the selected card again stops playback.
 */
export function VoiceField({
  language,
  voiceId,
  onChange,
  id = "voice-field",
  description,
}: VoiceFieldProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const { playingId, stopPreview, togglePreview } = useVoicePreview();
  const [api, setApi] = useState<CarouselApi>();
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(0);
  const group = GROUPS.find((g) => g.code === language) ?? GROUPS[0];

  // Dots track the settled snap. Sync-on-mount follows the stock shadcn
  // Carousel API pattern (setCount/setCurrent in the setApi effect), plus a
  // one-time instant jump so a draft-restored mid-list selection opens
  // centered instead of at snap 0. Instant, never animated: initial paint
  // must not glide.
  useEffect(() => {
    if (!api) return;
    const sync = () => {
      setPages(api.scrollSnapList().length);
      setPage(api.selectedScrollSnap());
    };
    sync();
    const idx = group.voices.findIndex((v) => v.id === voiceId);
    if (idx > 0) api.scrollTo(idx, true);
    api.on("select", sync);
    api.on("reInit", sync);
    return () => {
      api.off("select", sync);
      api.off("reInit", sync);
    };
    // group + voiceId are mount state: the carousel remounts per language
    // (English is the only multi-voice group), so re-running this per api
    // is the whole story — no scroll-on-update needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const selectLanguage = (codes: string[]) => {
    const code = codes[codes.length - 1];
    if (!code) return;
    const next = code as ConversationLanguage;
    const resolved = voiceForLanguage(next, voiceId);
    stopPreview();
    onChange({ language: next, voiceId: resolved.voiceId });
    const nextLabel =
      GROUPS.find((g) => g.code === next)?.language ?? next;
    setNotice(
      resolved.changed
        ? `Voice switched to ${voiceLabel(resolved.voiceId)} for ${nextLabel}.`
        : null,
    );
    // No scrollTo needed: English is the only multi-voice group, and the
    // resolved voice is always its index 0 — which the mount jump leaves at
    // the leading edge — so every language switch unmounts the track and the
    // fresh mount opens in the right place.
  };

  const selectVoice = (ids: string[]) => {
    const next = ids[ids.length - 1];
    if (!next) return;
    setNotice(null);
    // Choosing a voice sets its language implicitly — the two can never
    // disagree, so there is no separate language state to keep in sync.
    onChange({ language: group.code as ConversationLanguage, voiceId: next });
    // Glide the chosen card to center. This fires for mouse AND keyboard
    // activation (it is the toggle's onValueChange), and it is the ONLY
    // scroll call site — previewVoice's onClick fires on the same tap and a
    // second scrollTo would restart the glide mid-flight (jitter).
    const idx = group.voices.findIndex((v) => v.id === next);
    if (idx < 0 || !api) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    api.scrollTo(idx, reduceMotion);
  };

  /** Card click = select + preview. Runs alongside onValueChange (which owns
      selection); the toggle is idempotent so one tap never double-plays. */
  const previewVoice = (voice: Voice) => {
    const willPlay = playingId !== voice.id;
    togglePreview(voice);
    setNotice(
      willPlay
        ? `Playing ${voiceLabel(voice.id)} preview.`
        : `Stopped ${voiceLabel(voice.id)} preview.`,
    );
  };

  return (
    <Field className="gap-4">
      <FieldLabel id={`${id}-label`}>Language &amp; voice</FieldLabel>
      <FieldDescription>
        {description ??
          "The voice renders on the call — select a card to hear the real voice."}
      </FieldDescription>
      <LanguageChips language={language} onValueChange={selectLanguage} />
      {group.voices.length > 1 ? (
        <ToggleGroup
          value={[voiceId]}
          onValueChange={selectVoice}
          aria-labelledby={`${id}-label`}
          className="block w-full pt-1"
        >
          <Carousel
            setApi={setApi}
            // Center-mode selection: every snap — including the first and
            // last — must be able to rest centered. The default
            // containScroll: "trimSnaps" parks the edge snaps at the track
            // edges instead, so it is off; the edge whitespace is the cost
            // of a carousel where selection always lands center.
            opts={{ align: "center", containScroll: false, loop: false }}
            aria-labelledby={`${id}-label`}
            className="w-full"
          >
            <div className="flex items-center gap-2">
              <CarouselPrevious className="static m-0 shrink-0" />
              <CarouselContent className="-ml-2 flex-1">
                {group.voices.map((v) => {
                  const playing = playingId === v.id;
                  return (
                    <CarouselItem
                      key={v.id}
                      className="basis-4/5 pl-2 sm:basis-1/2 lg:basis-1/3"
                    >
                      <ToggleGroupItem
                        value={v.id}
                        aria-label={`Voice ${voiceLabel(v.id)}, ${group.language}, ${presentsLabel(v)}${playing ? ", playing preview" : ""}`}
                        onClick={() => previewVoice(v)}
                        // grid-list-02 surface: Card border + shadow-sm,
                        // hover border + shadow; the pressed state layers the
                        // primary border + ring on top. The toggle itself is
                        // the control — no stretched-link <a>.
                        className="relative h-auto w-full rounded-xl border border-input bg-card p-0 text-left text-card-foreground text-sm shadow-sm transition-[border-color,box-shadow] duration-100 ease-out hover:border-muted-foreground hover:shadow-md data-[state=on]:border-primary data-[state=on]:ring-1 data-[state=on]:ring-primary/30"
                      >
                        <CardContent className="flex w-full items-center gap-4 p-4">
                          <VoiceCardAvatar voiceId={v.id} playing={playing} />
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="text-pretty font-medium text-foreground text-sm">
                              {voiceLabel(v.id)}
                            </span>
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Badge variant="outline">
                                <span aria-hidden>{ACCENT_FLAG[v.accent]}</span>{" "}
                                {ACCENT_LABEL[v.accent]}
                              </Badge>
                            </span>
                          </span>
                          {/* Trailing indicator slot — status only, the card
                              itself is the control. */}
                          <span className="flex shrink-0 items-center">
                            {playing ? (
                              <AudioLines
                                data-icon="inline"
                                aria-hidden
                                className="text-primary"
                              />
                            ) : null}
                          </span>
                        </CardContent>
                      </ToggleGroupItem>
                    </CarouselItem>
                  );
                })}
              </CarouselContent>
              <CarouselNext className="static m-0 shrink-0" />
            </div>
            {pages > 1 ? (
              <div
                className="mt-3 flex items-center justify-center gap-1.5"
                role="group"
                aria-label="Voice pages"
              >
                {Array.from({ length: pages }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => api?.scrollTo(i)}
                    aria-label={`Go to voice page ${i + 1}`}
                    aria-current={i === page}
                    className={cn(
                      "size-2 rounded-full",
                      i === page ? "bg-primary" : "bg-muted",
                    )}
                  />
                ))}
              </div>
            ) : null}
          </Carousel>
        </ToggleGroup>
      ) : (
        <p className="text-muted-foreground text-xs">
          {voiceLabel(group.voices[0].id)} is the only {group.language} voice
          — already selected.
        </p>
      )}
      {/* Announcements only — the selection is visible on the card itself, so
          sighted users get no redundant notice line. */}
      <span aria-live="polite" className="sr-only">
        {notice}
      </span>
    </Field>
  );
}
