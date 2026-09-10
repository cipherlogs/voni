"use client";

import { useEffect, useState } from "react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCENT_LABEL, voiceLabel, type Voice } from "@/lib/agents/voices";

export type VoiceCarouselProps = {
  voices: Voice[];
  value: string;
  onChange: (voiceId: string) => void;
  id?: string;
};

/** Deterministic per-voice gradient avatar. Decorative by design: the voice
 * initial stays legible in both themes without extra assets. */
function avatarStyle(id: string): React.CSSProperties {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return {
    background: `linear-gradient(135deg, hsl(${hue} 75% 62%), hsl(${(hue + 60) % 360} 75% 48%))`,
  };
}

/**
 * Voice picker: swipeable one-voice slides with tiny dots. Tapping a card
 * selects it — there is deliberately no audio preview. Browser speech
 * synthesis can only approximate by language, so every English slide sounded
 * identical and the preview misrepresented the real voice. The final voice
 * renders on the call; "Test this agent" after saving is the honest check.
 */
export function VoiceCarousel({ voices, value, onChange, id = "voice-carousel" }: VoiceCarouselProps) {
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(() => Math.max(0, voices.findIndex((v) => v.id === value)));
  const selectedIndex = Math.max(0, voices.findIndex((v) => v.id === value));

  // Dots track the settled slide.
  useEffect(() => {
    if (!api) return;
    const onSelect = () => {
      setCurrent(api.selectedScrollSnap());
    };
    api.on("select", onSelect);
    return () => {
      api.off("select", onSelect);
    };
  }, [api]);

  // External value changes (language switch, voice proposals): jump silently.
  useEffect(() => {
    if (!api) return;
    if (api.selectedScrollSnap() !== selectedIndex) api.scrollTo(selectedIndex, true);
  }, [api, selectedIndex, voices]);

  return (
    <Field>
      <FieldLabel id={`${id}-label`}>Voice</FieldLabel>
      <FieldDescription>
        The voice renders on the call — test it with &ldquo;Test this agent&rdquo; after saving.
      </FieldDescription>
      <div className="mx-auto w-full max-w-sm">
        <Carousel setApi={setApi} opts={{ align: "center" }} aria-labelledby={`${id}-label`}>
          <CarouselContent className="ml-0">
            {voices.map((voice) => {
              const selected = voice.id === value;
              return (
                <CarouselItem key={voice.id} className="basis-full pl-0">
                  <button
                    type="button"
                    onClick={() => onChange(voice.id)}
                    aria-pressed={selected}
                    aria-label={`Select voice ${voiceLabel(voice.id)}, ${ACCENT_LABEL[voice.accent]}`}
                    className="w-full text-left"
                  >
                    <Card
                      className={cn(
                        "border-0 shadow-none",
                        selected ? "bg-primary/10 ring-1 ring-primary" : "bg-muted/50",
                      )}
                    >
                      <CardContent className="flex flex-row items-center gap-3 p-3">
                        <span
                          aria-hidden
                          style={avatarStyle(voice.id)}
                          className="flex size-10 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
                        >
                          {voiceLabel(voice.id).charAt(0)}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                          <span className="text-sm font-medium">{voiceLabel(voice.id)}</span>
                          <span className="text-muted-foreground text-xs">
                            {ACCENT_LABEL[voice.accent]}
                          </span>
                        </span>
                        {selected ? (
                          <Check data-icon="inline" aria-hidden className="text-primary shrink-0" />
                        ) : null}
                      </CardContent>
                    </Card>
                  </button>
                </CarouselItem>
              );
            })}
          </CarouselContent>
          <CarouselPrevious className="left-1" />
          <CarouselNext className="right-1" />
          <div className="mt-2 flex items-center justify-center gap-1" role="group" aria-label="Voices">
            {voices.map((voice, i) => (
              <button
                key={voice.id}
                type="button"
                onClick={() => {
                  api?.scrollTo(i);
                }}
                aria-label={`Go to voice ${voiceLabel(voice.id)}`}
                aria-current={i === current ? "true" : undefined}
                className="flex size-6 items-center justify-center"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    i === current ? "bg-primary" : "bg-muted-foreground/30",
                  )}
                />
              </button>
            ))}
          </div>
        </Carousel>
      </div>
    </Field>
  );
}
