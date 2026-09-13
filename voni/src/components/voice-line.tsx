"use client";

import { VoiceBars } from "@/components/copilot/voice-bars";
import { useCopilot } from "@/components/copilot/copilot-provider";
import { cn } from "@/lib/utils";

/** H8 voice signature: hairline rule with the VoiceBars mark riding it. */
export function VoiceLine({
  live = false,
  label,
}: {
  live?: boolean;
  label?: string;
}) {
  const text = label ?? (live ? "Live" : "Voice");
  return (
    <div
      {...(live
        ? { role: "status", "aria-label": `Voice ${text}` }
        : { "aria-hidden": true })}
      className="flex items-center gap-3"
    >
      <span aria-hidden className="border-border flex-1 border-t shadow-none" />
      <span className={cn("flex items-center gap-2", live && "copilot-bars-live")}>
        {live ? (
          <span
            aria-hidden
            className="bg-brand size-2 shrink-0 animate-[voni-livedot_1.6s_ease-in-out_infinite] rounded-full motion-reduce:animate-none"
          />
        ) : null}
        <VoiceBars mood="idle" className="size-3.5" />
        <span className="text-muted-foreground text-xs">{text}</span>
      </span>
      <span aria-hidden className="border-border flex-1 border-t shadow-none" />
    </div>
  );
}

/** Page-shell wiring: live while the copilot session runs, static otherwise. */
export function VoiceLineLive() {
  const { live } = useCopilot();
  return <VoiceLine live={live} />;
}
