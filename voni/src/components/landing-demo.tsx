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
    <div className="mt-6 flex justify-center">
      <VoiceCall mode={{ kind: "demo" }} />
    </div>
  );
}
