"use client";

import { useMemo, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import { INPUT_LANGUAGES, VOICES, voiceLabel } from "@/lib/agents/voices";
import {
  voiceForLanguage,
  type ConversationLanguage,
} from "@/lib/agents/wizard";
import { VoiceCarousel } from "./voice-carousel";

export type ConversationPickerProps = {
  language: ConversationLanguage;
  voiceId: string;
  /** Atomic language+voice update — the picker never leaves them mismatched. */
  onChange: (next: { language: ConversationLanguage; voiceId: string }) => void;
  agentName: string;
  languageId?: string;
  description?: string;
};

const SPEAKABLE = INPUT_LANGUAGES.filter((l) => l.canSpeak);

function languageMeta(code: string) {
  return SPEAKABLE.find((l) => l.code === code) ?? SPEAKABLE[0];
}

/**
 * Shared conversation language + voice picker. Language is a dropdown (flag
 * plus text, never flag alone); voices are a swipeable carousel filtered to
 * the selected language. Changing the language keeps a compatible voice,
 * otherwise falls back to anna for English or the first catalog match —
 * announced via a polite status message.
 */
export function ConversationPicker({
  language,
  voiceId,
  onChange,
  agentName,
  languageId = "conversation-language",
  description,
}: ConversationPickerProps) {
  const [notice, setNotice] = useState<string | null>(null);
  // Stable identity: the carousel's silent-jump effect keys on this array,
  // so a fresh filter per render would snap back every swipe.
  const voices = useMemo(() => VOICES.filter((v) => v.languageCode === language), [language]);

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
          <SelectTrigger id={languageId} className="w-full">
            <span className="flex items-center gap-1.5">
              <span aria-hidden>{languageMeta(language).flag}</span>
              {languageMeta(language).label}
            </span>
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
      <div>
        <VoiceCarousel
          voices={voices}
          value={voiceId}
          agentName={agentName}
          onChange={(nextVoiceId) => {
            setNotice(null);
            onChange({ language, voiceId: nextVoiceId });
          }}
        />
        <span aria-live="polite" className="sr-only">
          {notice}
        </span>
        {notice ? (
          <p className="text-muted-foreground mt-2 text-xs">{notice}</p>
        ) : null}
      </div>
    </div>
  );
}
