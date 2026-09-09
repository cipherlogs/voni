"use client";

import { useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ACCENT_LABEL,
  INPUT_LANGUAGES,
  VOICES,
  voiceLabel,
} from "@/lib/agents/voices";
import {
  voiceForLanguage,
  type ConversationLanguage,
} from "@/lib/agents/wizard";

export type ConversationPickerProps = {
  language: ConversationLanguage;
  voiceId: string;
  /** Atomic language+voice update — the picker never leaves them mismatched. */
  onChange: (next: { language: ConversationLanguage; voiceId: string }) => void;
  languageId?: string;
  voiceSelectId?: string;
  description?: string;
};

const SPEAKABLE = INPUT_LANGUAGES.filter((l) => l.canSpeak);

function languageMeta(code: string) {
  return SPEAKABLE.find((l) => l.code === code) ?? SPEAKABLE[0];
}

/**
 * Shared conversation language + voice picker. The voice dropdown shows only
 * voices for the selected language (name + documented accent). Changing the
 * language keeps a compatible voice, otherwise falls back to anna for English
 * or the first catalog match — announced via a polite status message.
 */
export function ConversationPicker({
  language,
  voiceId,
  onChange,
  languageId = "conversation-language",
  voiceSelectId = "conversation-voice",
  description,
}: ConversationPickerProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const voices = VOICES.filter((v) => v.languageCode === language);
  const active = languageMeta(language);

  const selectLanguage = (code: string | null) => {
    if (!code) return;
    const next = code as ConversationLanguage;
    const resolved = voiceForLanguage(next, voiceId);
    onChange({ language: next, voiceId: resolved.voiceId });
    setNotice(
      resolved.changed
        ? `Voice switched to ${voiceLabel(resolved.voiceId)} for ${languageMeta(next).label}.`
        : null,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor={languageId}>Conversation language</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        <Select value={language} onValueChange={selectLanguage}>
          <SelectTrigger id={languageId} className="min-h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Languages</SelectLabel>
              {SPEAKABLE.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  <span aria-hidden>{lang.flag}</span>
                  {lang.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={voiceSelectId}>Voice</FieldLabel>
        <Select value={voiceId} onValueChange={(v) => v && onChange({ language, voiceId: v })}>
          <SelectTrigger id={voiceSelectId} className="min-h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{active.label} voices</SelectLabel>
              {voices.map((voice) => (
                <SelectItem key={voice.id} value={voice.id}>
                  {voiceLabel(voice.id)}
                  <span className="opacity-60">{ACCENT_LABEL[voice.accent]}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <span aria-live="polite" className="sr-only">
          {notice}
        </span>
        {notice ? (
          <p aria-hidden className="text-muted-foreground text-xs">
            {notice}
          </p>
        ) : null}
      </Field>
    </div>
  );
}
