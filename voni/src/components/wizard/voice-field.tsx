"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
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
import { VoiceAvatar } from "./voice-avatar";

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
 * AssemblyAI clip (`public/voices`), with a fill sweep tracking the clip.
 * Clicking the selected card again stops playback.
 */
export function VoiceField({
  language,
  voiceId,
  onChange,
  id = "voice-field",
  description,
}: VoiceFieldProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const { playingId, previewDuration, stopPreview, togglePreview } =
    useVoicePreview();
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
                        aria-label={`Voice ${voiceLabel(v.id)}, ${group.language}${playing ? ", playing preview" : ""}`}
                        onClick={() => previewVoice(v)}
                        className="border-border bg-card relative flex h-auto w-full flex-col items-stretch overflow-hidden rounded-xl border p-3 text-left data-[state=on]:border-primary data-[state=on]:ring-1 data-[state=on]:ring-primary/30"
                      >
                        {/* Fill sweep tracking the clip. Keyed by playingId so
                            every replay restarts the sweep from zero. */}
                        {playing ? (
                          <span
                            key={playingId}
                            aria-hidden
                            className="voni-voice-fill pointer-events-none absolute inset-0 bg-primary/10"
                            style={
                              {
                                "--preview-duration": `${previewDuration}s`,
                              } as CSSProperties
                            }
                          />
                        ) : null}
                        <span className="relative flex w-full items-center gap-3">
                          <VoiceAvatar voiceId={v.id} playing={playing} />
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="text-sm font-medium">
                              {voiceLabel(v.id)}
                            </span>
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Badge variant="outline">
                                <span aria-hidden>{ACCENT_FLAG[v.accent]}</span>{" "}
                                {ACCENT_LABEL[v.accent]}
                              </Badge>
                              <span className="text-muted-foreground text-xs">
                                {presentsLabel(v)}
                              </span>
                            </span>
                          </span>
                          {/* Non-interactive playing indicator — the card
                              itself is the control, so this is status only. */}
                          {playing ? (
                            <svg
                              aria-hidden
                              className="copilot-bars-live h-3.5 w-3.5 shrink-0 text-primary"
                              viewBox="0 0 12 12"
                              fill="currentColor"
                            >
                              <rect x="1" y="4" width="2" height="4" rx="1" />
                              <rect x="5" y="2" width="2" height="8" rx="1" />
                              <rect x="9" y="4" width="2" height="4" rx="1" />
                            </svg>
                          ) : null}
                        </span>
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
