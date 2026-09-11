"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { voiceLabel } from "@/lib/agents/voices";

/**
 * Per-character avatar for a voice: a deterministic gradient disc (hue from
 * the voice id, so every voice is distinct with zero assets) with two soft
 * "cloud" blobs drifting inside, plus the voice's initial.
 *
 * Motion: the disc floats gently at idle; while its preview clip plays it
 * pulses softly (the card fill carries the actual progress). All motion
 * squashes to a static frame under `prefers-reduced-motion` via the global
 * rule in globals.css — no per-component media query needed.
 */
function hueForVoice(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 360;
  }
  return hash;
}

export function VoiceAvatar({
  voiceId,
  playing = false,
  className,
}: {
  voiceId: string;
  playing?: boolean;
  className?: string;
}) {
  const hue = hueForVoice(voiceId);
  const hue2 = (hue + 48) % 360;
  return (
    <Avatar
      className={cn(
        "size-10 shrink-0 overflow-hidden",
        playing ? "voni-voice-playing" : "voni-voice-idle",
        className,
      )}
    >
      <AvatarFallback
        className="relative overflow-hidden border-0 text-sm font-semibold text-white"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 55% 55%), hsl(${hue2} 60% 45%))`,
        }}
      >
        {/* Cloud blobs: soft white washes drifting across the disc. */}
        <span
          aria-hidden
          className="voni-voice-cloud voni-voice-cloud-a absolute -top-1 -left-2 size-6 rounded-full bg-white/35 blur-[6px]"
        />
        <span
          aria-hidden
          className="voni-voice-cloud voni-voice-cloud-b absolute -right-2 -bottom-1 size-7 rounded-full bg-white/25 blur-[7px]"
        />
        <span aria-hidden className="relative">
          {voiceLabel(voiceId).charAt(0)}
        </span>
      </AvatarFallback>
    </Avatar>
  );
}
