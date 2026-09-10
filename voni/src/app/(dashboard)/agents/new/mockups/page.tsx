"use client";

import { useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  INPUT_LANGUAGES,
  voicesByLanguage,
  voiceLabel,
  ACCENT_LABEL,
  type Voice,
} from "@/lib/agents/voices";

/**
 * TEMPORARY mockups for the Language & Voice redesign (not shipped).
 * Three directions, mock data, local-only state — pick one, it gets wired
 * to real wizard state and this route gets deleted.
 */
const GROUPS = voicesByLanguage();
const flagFor = (code: string) =>
  INPUT_LANGUAGES.find((l) => l.code === code)?.flag ?? "";

function VoiceRow({ voice }: { voice: Voice }) {
  return (
    <span className="flex w-full items-center gap-3 px-1 py-2 text-left">
      <Avatar className="size-10">
        <AvatarFallback>{voiceLabel(voice.id).charAt(0)}</AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{voiceLabel(voice.id)}</span>
        <span className="text-muted-foreground text-xs">
          {ACCENT_LABEL[voice.accent]} ·{" "}
          {voice.presents === "unspecified" ? "Neutral" : voice.presents}
        </span>
      </span>
    </span>
  );
}

function MockA() {
  const [lang, setLang] = useState("en");
  const [voice, setVoice] = useState("anna");
  const group = GROUPS.find((g) => g.code === lang) ?? GROUPS[0];
  return (
    <Field>
      <FieldLabel>A · Language chips + voice rows</FieldLabel>
      <FieldDescription>
        Pick the language the agent speaks — the voices below follow. One
        decision instead of two controls.
      </FieldDescription>
      <ToggleGroup
        value={[lang]}
        onValueChange={(v) => {
          const next = v[v.length - 1];
          if (!next) return;
          setLang(next);
          const first = GROUPS.find((g) => g.code === next)?.voices[0];
          if (first) setVoice(first.id);
        }}
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
        value={[voice]}
        onValueChange={(v) => {
          const next = v[v.length - 1];
          if (next) setVoice(next);
        }}
        aria-label={`Voices in ${group.language}`}
        className="flex-col items-stretch gap-0"
      >
        {group.voices.map((v) => (
          <ToggleGroupItem
            key={v.id}
            value={v.id}
            aria-label={`Select voice ${voiceLabel(v.id)}`}
            className="h-auto w-full justify-start rounded-lg px-1 data-[state=on]:bg-transparent"
          >
            <VoiceRow voice={v} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {group.voices.length === 1 ? (
        <p className="text-muted-foreground text-xs">
          {voiceLabel(group.voices[0].id)} is the only {group.language} voice —
          already selected.
        </p>
      ) : null}
    </Field>
  );
}

function MockB() {
  const [voice, setVoice] = useState("anna");
  return (
    <Field>
      <FieldLabel>B · Single grouped list</FieldLabel>
      <FieldDescription>
        No language control at all — choosing a voice sets the language
        implicitly. Everything visible in one scroll.
      </FieldDescription>
      <ToggleGroup
        value={[voice]}
        onValueChange={(v) => {
          const next = v[v.length - 1];
          if (next) setVoice(next);
        }}
        aria-label="Voices by language"
        className="flex-col items-stretch gap-0"
      >
        {GROUPS.map((g) => (
          <div key={g.code}>
            <p className="text-muted-foreground px-1 pt-3 pb-1 text-xs font-medium">
              <span aria-hidden>{flagFor(g.code)}</span> {g.language}
              <span className="ml-2 font-normal">
                {g.voices.length === 1
                  ? "· only voice"
                  : `· ${g.voices.length} voices`}
              </span>
            </p>
            {g.voices.map((v) => (
              <ToggleGroupItem
                key={v.id}
                value={v.id}
                aria-label={`Select voice ${voiceLabel(v.id)}, ${g.language}`}
                className="h-auto w-full justify-start rounded-lg px-1 data-[state=on]:bg-transparent"
              >
                <VoiceRow voice={v} />
              </ToggleGroupItem>
            ))}
          </div>
        ))}
      </ToggleGroup>
    </Field>
  );
}

function MockC() {
  const [voice, setVoice] = useState("anna");
  const [open, setOpen] = useState(false);
  const current = GROUPS.flatMap((g) => g.voices).find((v) => v.id === voice);
  return (
    <Field>
      <FieldLabel>C · Compact trigger + panel</FieldLabel>
      <FieldDescription>
        Smallest footprint: the current voice shows in one row, the full
        grouped list opens on tap.
      </FieldDescription>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-lg border border-input bg-transparent px-3 py-2 text-left"
      >
        {current ? <VoiceRow voice={current} /> : null}
        <Badge variant="secondary" className="ml-auto shrink-0">
          {open ? "Close" : "Change"}
        </Badge>
      </button>
      {open ? (
        <ToggleGroup
          value={[voice]}
          onValueChange={(v) => {
            const next = v[v.length - 1];
            if (next) {
              setVoice(next);
              setOpen(false);
            }
          }}
          aria-label="Voices by language"
          className="flex-col items-stretch gap-0"
        >
          {GROUPS.map((g) => (
            <div key={g.code}>
              <p className="text-muted-foreground px-1 pt-2 pb-1 text-xs font-medium">
                <span aria-hidden>{flagFor(g.code)}</span> {g.language}
              </p>
              {g.voices.map((v) => (
                <ToggleGroupItem
                  key={v.id}
                  value={v.id}
                  aria-label={`Select voice ${voiceLabel(v.id)}, ${g.language}`}
                  className="h-auto w-full justify-start rounded-lg px-1 data-[state=on]:bg-transparent"
                >
                  <VoiceRow voice={v} />
                </ToggleGroupItem>
              ))}
            </div>
          ))}
        </ToggleGroup>
      ) : null}
    </Field>
  );
}

export default function VoiceMockupsPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-10 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Voice mockups</h1>
        <p className="text-muted-foreground text-sm">
          Temporary — no persistence. A play button per row lands with the real
          AssemblyAI clips once the preview spike reports back.
        </p>
      </div>
      <MockA />
      <Separator />
      <MockB />
      <Separator />
      <MockC />
    </div>
  );
}
