"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { voiceLabel } from "@/lib/agents/voices";

/**
 * Per-voice avatar: a deterministic pick from token surfaces (hash of the
 * voice id mod the surface list), so every voice is distinct with zero
 * assets. No hsl(), no gradient, no cloud blobs. `playing` is a static
 * status hook (primary wash) — never motion.
 */
const SURFACES = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-primary",
  "bg-secondary",
  "bg-accent",
  "bg-muted",
] as const;

function surfaceForVoice(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % SURFACES.length;
  }
  return SURFACES[hash];
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
  return (
    <Avatar className={cn("size-10 shrink-0", className)}>
      <AvatarFallback
        className={cn(
          "text-sm font-bold text-white",
          playing ? "bg-primary/10 text-primary" : surfaceForVoice(voiceId),
        )}
      >
        <span aria-hidden>{voiceLabel(voiceId).charAt(0)}</span>
      </AvatarFallback>
    </Avatar>
  );
}
