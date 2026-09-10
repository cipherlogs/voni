"use client";

import type { ConversationLanguage } from "@/lib/agents/wizard";
import { VoiceField } from "./voice-field";

export type ConversationPickerProps = {
  language: ConversationLanguage;
  voiceId: string;
  /** Atomic language+voice update — the picker never leaves them mismatched. */
  onChange: (next: { language: ConversationLanguage; voiceId: string }) => void;
  languageId?: string;
  description?: string;
};

/**
 * Shared conversation language + voice picker: one merged "Language & voice"
 * section (chips filter the voice rows; picking a voice sets its language).
 * The separate language dropdown and voice carousel are gone — two controls
 * for one decision confused the choice.
 */
export function ConversationPicker({
  language,
  voiceId,
  onChange,
  languageId = "conversation-language",
  description,
}: ConversationPickerProps) {
  return (
    <div className="flex flex-col gap-4">
      <VoiceField
        id={languageId}
        language={language}
        voiceId={voiceId}
        onChange={onChange}
        description={description}
      />
    </div>
  );
}
