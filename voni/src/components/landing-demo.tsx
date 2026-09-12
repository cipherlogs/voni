"use client";

import { VoiceCall } from "@/components/voice-call";

/**
 * The public live-demo widget (plan Section E).
 *
 * Vapi's pattern — pick a scenario, one click to call — rather than
 * Structurely's "leave your number and we'll ring you", which is higher
 * friction and doesn't match our in-browser mechanism.
 *
 * Runs in `demo` mode: the browser sends only a persona id and a voice id, and
 * the prompt lives in a server-owned stored agent. Nothing reachable from here
 * can make the model do anything but the scenario picked — see
 * `src/app/api/demo/token/route.ts` for the four layers behind that.
 */
export function LandingDemo() {
  return (
    <div className="mt-6 flex flex-col items-center gap-3">
      <VoiceCall mode={{ kind: "demo" }} />
      {/* Demo-mode disclosure: one line under the widget, not inside it —
          the card's geometry is fixed and nothing may shift it. States what
          the click does (a live browser call, no phone needed) and its two
          limits (2 minutes, daily per-IP cap) before the mic prompt arrives. */}
      <p className="text-muted-foreground max-w-sm text-center text-xs leading-relaxed">
        A live 2-minute demo call in your browser — no phone number needed.
        Uses your microphone and is rate-limited per visitor per day.
      </p>
    </div>
  );
}
