"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import { ACCENT_LABEL, voiceLabel, type Voice } from "@/lib/agents/voices";
import { buildPreviewText } from "@/lib/voice/preview";

export type VoiceCarouselProps = {
  voices: Voice[];
  value: string;
  onChange: (voiceId: string) => void;
  agentName: string;
  id?: string;
};

/**
 * ChatGPT-style voice picker: swipeable one-voice slides with tiny dots.
 * Sliding to a voice plays its sample; tapping a card selects it. Samples
 * use the browser's voice (AssemblyAI has no standalone preview) — the final
 * voice renders on the call. Nothing auto-plays on mount or language switch.
 */
export function VoiceCarousel({ voices, value, onChange, agentName, id = "voice-carousel" }: VoiceCarouselProps) {
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(() => Math.max(0, voices.findIndex((v) => v.id === value)));
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const interacted = useRef(false);
  const playSeq = useRef(0);
  const selectedIndex = Math.max(0, voices.findIndex((v) => v.id === value));

  const stopSample = useCallback(() => {
    playSeq.current += 1;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(null);
  }, []);

  const playSample = useCallback(
    async (voice: Voice) => {
      stopSample();
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        setSampleError("Voice samples aren't supported in this browser.");
        return;
      }
      setSampleError(null);
      const seq = playSeq.current;
      let text: string;
      try {
        const res = await fetch("/api/voice-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceId: voice.id, text: buildPreviewText(agentName) }),
        });
        if (!res.ok) throw new Error(`preview ${res.status}`);
        text = ((await res.json()) as { text: string }).text;
      } catch {
        if (seq === playSeq.current) setSampleError("Couldn't load the sample. Try again.");
        return;
      }
      if (seq !== playSeq.current) return;
      const utter = new SpeechSynthesisUtterance(text);
      const browserVoices = window.speechSynthesis.getVoices();
      utter.voice =
        browserVoices.find((v) => v.lang === voice.languageCode) ??
        browserVoices.find((v) => v.lang.startsWith(voice.languageCode.slice(0, 2))) ??
        null;
      utter.lang = voice.languageCode;
      utter.onend = () => {
        if (seq === playSeq.current) setSpeaking(null);
      };
      utter.onerror = () => {
        if (seq === playSeq.current) setSpeaking(null);
      };
      setSpeaking(voice.id);
      window.speechSynthesis.speak(utter);
    },
    [agentName, stopSample],
  );

  // Slide changes: track dots always, play only after a user gesture.
  useEffect(() => {
    if (!api) return;
    const onSelect = () => {
      const index = api.selectedScrollSnap();
      setCurrent(index);
      const voice = voices[index];
      if (voice && interacted.current) void playSample(voice);
    };
    onSelect();
    api.on("select", onSelect);
    return () => {
      api.off("select", onSelect);
    };
  }, [api, voices, playSample]);

  // External value changes (language switch, voice proposals): jump silently.
  useEffect(() => {
    if (!api) return;
    if (api.selectedScrollSnap() !== selectedIndex) api.scrollTo(selectedIndex, true);
  }, [api, selectedIndex, voices]);

  // Never leave speech running after unmount.
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const markInteracted = () => {
    interacted.current = true;
  };

  return (
    <Field>
      <FieldLabel id={`${id}-label`}>Voice</FieldLabel>
      <FieldDescription>
        Samples use your browser&apos;s voice — the final voice renders on the call.
      </FieldDescription>
      <div onPointerDown={markInteracted} onKeyDown={markInteracted}>
        <Carousel setApi={setApi} opts={{ align: "center" }} aria-labelledby={`${id}-label`}>
          <CarouselContent>
            {voices.map((voice) => {
              const selected = voice.id === value;
              return (
                <CarouselItem key={voice.id} className="basis-4/5 sm:basis-3/5">
                  <button
                    type="button"
                    onClick={() => {
                      markInteracted();
                      onChange(voice.id);
                      void playSample(voice);
                    }}
                    aria-pressed={selected}
                    aria-label={`Select voice ${voiceLabel(voice.id)}, ${ACCENT_LABEL[voice.accent]}`}
                    className="w-full text-left"
                  >
                    <Card className={cn(selected && "border-primary")}>
                      <CardContent className="flex flex-col gap-1 p-4">
                        <span className="text-sm font-medium">{voiceLabel(voice.id)}</span>
                        <span className="text-muted-foreground text-xs">
                          {ACCENT_LABEL[voice.accent]}
                          {speaking === voice.id ? " · Playing sample…" : ""}
                        </span>
                      </CardContent>
                    </Card>
                  </button>
                </CarouselItem>
              );
            })}
          </CarouselContent>
          <div className="mt-2 flex items-center justify-between gap-2">
            <CarouselPrevious className="static" />
            <div className="flex items-center gap-1" role="group" aria-label="Voices">
              {voices.map((voice, i) => (
                <button
                  key={voice.id}
                  type="button"
                  onClick={() => {
                    markInteracted();
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
            <CarouselNext className="static" />
          </div>
        </Carousel>
      </div>
      <span aria-live="polite" className="sr-only">
        {speaking ? `Playing ${voiceLabel(speaking)} sample.` : null}
        {sampleError}
      </span>
      {sampleError ? (
        <p className="text-destructive text-xs">{sampleError}</p>
      ) : null}
    </Field>
  );
}
