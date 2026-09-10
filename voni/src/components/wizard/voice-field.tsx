"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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

/**
 * Merged language + voice picker. One decision: the language chips filter the
 * voice cards, and choosing a voice sets its language implicitly. Cards sit
 * in a stock Carousel (3-up on desktop, 2 on tablet, 1 + peek on phones)
 * with side chevrons and snap dots. Each card plays its real AssemblyAI clip
 * (`public/voices`), captured once via the session-greeting path because
 * AssemblyAI publishes no sample clips and no standalone TTS endpoint.
 */
export function VoiceField({
  language,
  voiceId,
  onChange,
  id = "voice-field",
  description,
}: VoiceFieldProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [api, setApi] = useState<CarouselApi>();
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const group = GROUPS.find((g) => g.code === language) ?? GROUPS[0];

  // One clip at a time; leaving the step stops playback.
  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  // Dots track the settled snap. Sync-on-mount follows the stock shadcn
  // Carousel API pattern (setCount/setCurrent in the setApi effect).
  useEffect(() => {
    if (!api) return;
    const sync = () => {
      setPages(api.scrollSnapList().length);
      setPage(api.selectedScrollSnap());
    };
    sync();
    api.on("select", sync);
    api.on("reInit", sync);
    return () => {
      api.off("select", sync);
      api.off("reInit", sync);
    };
  }, [api]);

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
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
    setPlayingId(voice.id);
    void audio.play().catch(() => setPlayingId(null));
  };

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
    // No scrollTo needed: English is the only multi-voice group, so every
    // language switch unmounts the track and the fresh mount starts at 0.
  };

  const selectVoice = (ids: string[]) => {
    const next = ids[ids.length - 1];
    if (!next) return;
    setNotice(null);
    // Choosing a voice sets its language implicitly — the two can never
    // disagree, so there is no separate language state to keep in sync.
    onChange({ language: group.code as ConversationLanguage, voiceId: next });
  };

  return (
    <Field>
      <FieldLabel id={`${id}-label`}>Language &amp; voice</FieldLabel>
      <FieldDescription>
        {description ??
          "The voice renders on the call — play a card to hear the real voice."}
      </FieldDescription>
      <ToggleGroup
        value={[language]}
        onValueChange={selectLanguage}
        aria-label="Spoken language"
        className="flex-wrap justify-start"
      >
        {GROUPS.map((g) => (
          <ToggleGroupItem key={g.code} value={g.code} aria-label={g.language}>
            <span aria-hidden>{flagFor(g.code)}</span> {g.language}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {group.voices.length > 1 ? (
        <ToggleGroup
          value={[voiceId]}
          onValueChange={selectVoice}
          aria-labelledby={`${id}-label`}
          className="block w-full"
        >
          <Carousel
            setApi={setApi}
            opts={{ align: "start", loop: false }}
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
                      <div className="relative">
                        <ToggleGroupItem
                          value={v.id}
                          aria-label={`Select voice ${voiceLabel(v.id)}, ${group.language}`}
                          className="border-border flex h-auto w-full flex-col items-stretch rounded-xl border p-3 text-left data-[state=on]:border-primary"
                        >
                          <span className="flex w-full items-start gap-3">
                            <Avatar className="size-10 shrink-0">
                              <AvatarFallback>
                                {voiceLabel(v.id).charAt(0)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5 pr-10">
                              <span className="text-sm font-medium">
                                {voiceLabel(v.id)}
                              </span>
                              <span className="text-muted-foreground text-xs">
                                {ACCENT_LABEL[v.accent]} · {presentsLabel(v)}
                              </span>
                            </span>
                          </span>
                        </ToggleGroupItem>
                        {/* Sibling, not nested: a button inside the toggle
                        item would be invalid markup and every play-tap would
                        also re-select the voice. */}
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={
                            playing
                              ? `Stop ${voiceLabel(v.id)} preview`
                              : `Play ${voiceLabel(v.id)} preview`
                          }
                          aria-pressed={playing}
                          onClick={() => togglePreview(v)}
                          className="absolute right-2 bottom-2"
                        >
                          {playing ? <Pause /> : <Play />}
                        </Button>
                      </div>
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
      <span aria-live="polite" className="sr-only">
        {notice}
      </span>
      {notice ? (
        <p className="text-muted-foreground mt-2 text-xs">{notice}</p>
      ) : null}
    </Field>
  );
}
