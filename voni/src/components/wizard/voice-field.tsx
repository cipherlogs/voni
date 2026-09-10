"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
 * Merged language + voice picker (mockup A, wired). One decision: the
 * language chips filter the voice rows, and choosing a voice sets its
 * language implicitly. No carousel, no chevrons, no dots, no checkmark —
 * pressed rows are the selection. Each row plays its real AssemblyAI clip
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const group = GROUPS.find((g) => g.code === language) ?? GROUPS[0];

  // One clip at a time; leaving the step stops playback.
  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const togglePreview = (voice: Voice) => {
    const current = audioRef.current;
    if (playingId === voice.id && current) {
      current.pause();
      current.currentTime = 0;
      audioRef.current = null;
      setPlayingId(null);
      return;
    }
    if (current) current.pause();
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
    onChange({ language: next, voiceId: resolved.voiceId });
    const nextLabel =
      GROUPS.find((g) => g.code === next)?.language ?? next;
    setNotice(
      resolved.changed
        ? `Voice switched to ${voiceLabel(resolved.voiceId)} for ${nextLabel}.`
        : null,
    );
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
          "The voice renders on the call — play a row to hear the real voice."}
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
      <ToggleGroup
        value={[voiceId]}
        onValueChange={selectVoice}
        aria-labelledby={`${id}-label`}
        className="flex-col items-stretch gap-0"
      >
        {group.voices.map((v) => {
          const playing = playingId === v.id;
          return (
            <div key={v.id} className="flex items-center gap-1">
              <ToggleGroupItem
                value={v.id}
                aria-label={`Select voice ${voiceLabel(v.id)}, ${group.language}`}
                className="h-auto min-w-0 flex-1 justify-start rounded-lg px-1"
              >
                <span className="flex w-full items-center gap-3 px-1 py-2 text-left">
                  <Avatar className="size-10 shrink-0">
                    <AvatarFallback>
                      {voiceLabel(v.id).charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {voiceLabel(v.id)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {ACCENT_LABEL[v.accent]} · {presentsLabel(v)}
                    </span>
                  </span>
                </span>
              </ToggleGroupItem>
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
                className="shrink-0"
              >
                {playing ? <Pause /> : <Play />}
              </Button>
            </div>
          );
        })}
      </ToggleGroup>
      {group.voices.length === 1 ? (
        <p className="text-muted-foreground text-xs">
          {voiceLabel(group.voices[0].id)} is the only {group.language} voice
          — already selected.
        </p>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {notice}
      </span>
      {notice ? (
        <p className="text-muted-foreground mt-2 text-xs">{notice}</p>
      ) : null}
    </Field>
  );
}
