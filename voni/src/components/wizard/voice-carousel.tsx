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
 * Voice picker: swipeable one-voice slides with tiny dots. Sliding to a voice
 * plays its sample (debounced to the settled slide); tapping a card selects
 * it, tapping the playing card stops it. Samples use the browser's voice
 * (AssemblyAI has no standalone preview) — the final voice renders on the
 * call. Nothing auto-plays on mount or language switch.
 */
export function VoiceCarousel({ voices, value, onChange, agentName, id = "voice-carousel" }: VoiceCarouselProps) {
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(() => Math.max(0, voices.findIndex((v) => v.id === value)));
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const interacted = useRef(false);
  const playSeq = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedIndex = Math.max(0, voices.findIndex((v) => v.id === value));

  /** Effect-safe cut: no setState, so jumps/switches can call it. */
  const silence = useCallback(() => {
    playSeq.current += 1;
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const stopSample = useCallback(() => {
    silence();
    setSpeaking(null);
  }, [silence]);

  const playSample = useCallback(
    async (voice: Voice) => {
      // Single-flight: cut anything playing, invalidate superseded requests.
      // Chrome's cancel() races a queued speak(), so the fresh utterance goes
      // out on a short delay after the cut.
      const seq = playSeq.current + 1;
      playSeq.current = seq;
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      setSpeaking(null);
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        setSampleError("Voice samples aren't supported in this browser.");
        return;
      }
      setSampleError(null);
      await new Promise((resolve) => {
        settleTimer.current = setTimeout(resolve, 120);
      });
      if (seq !== playSeq.current) return;
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
    [agentName],
  );

  // Slide changes: track dots immediately, play only the settled slide and
  // only after a user gesture — swiping past voices never plays them.
  useEffect(() => {
    if (!api) return;
    const onSelect = () => {
      const index = api.selectedScrollSnap();
      setCurrent(index);
      if (settleTimer.current) clearTimeout(settleTimer.current);
      const voice = voices[index];
      if (voice && interacted.current) {
        settleTimer.current = setTimeout(() => {
          void playSample(voice);
        }, 400);
      }
    };
    api.on("select", onSelect);
    return () => {
      api.off("select", onSelect);
    };
  }, [api, voices, playSample]);

  // External value changes (language switch, voice proposals): jump silently.
  useEffect(() => {
    silence();
    if (!api) return;
    if (api.selectedScrollSnap() !== selectedIndex) api.scrollTo(selectedIndex, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedIndex, voices]);

  // Never leave speech running after unmount.
  useEffect(() => {
    return () => {
      silence();
    };
  }, [silence]);

  const markInteracted = () => {
    interacted.current = true;
  };

  const toggleCard = (voice: Voice) => {
    markInteracted();
    if (speaking === voice.id) {
      stopSample();
      return;
    }
    onChange(voice.id);
    void playSample(voice);
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
              const playing = speaking === voice.id;
              return (
                <CarouselItem key={voice.id} className="basis-4/5 sm:basis-3/5">
                  <button
                    type="button"
                    onClick={() => toggleCard(voice)}
                    aria-pressed={selected}
                    aria-label={
                      playing
                        ? `Stop ${voiceLabel(voice.id)} sample`
                        : `Select voice ${voiceLabel(voice.id)}, ${ACCENT_LABEL[voice.accent]}`
                    }
                    className="w-full text-left"
                  >
                    <Card className={cn(selected && "border-primary ring-1 ring-primary")}>
                      <CardContent className="flex items-center gap-3 p-4">
                        <span
                          aria-hidden
                          style={avatarStyle(voice.id)}
                          className="flex size-12 shrink-0 items-center justify-center rounded-full text-lg font-semibold text-white"
                        >
                          {voiceLabel(voice.id).charAt(0)}
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-sm font-medium">{voiceLabel(voice.id)}</span>
                          <span className="text-muted-foreground text-xs">
                            {ACCENT_LABEL[voice.accent]}
                            {playing ? " · Playing — tap to stop" : ""}
                          </span>
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
        {speaking ? `Playing ${voiceLabel(speaking)} sample. Tap the card to stop.` : null}
        {sampleError}
      </span>
      {sampleError ? (
        <p className="text-destructive text-xs">{sampleError}</p>
      ) : null}
    </Field>
  );
}
