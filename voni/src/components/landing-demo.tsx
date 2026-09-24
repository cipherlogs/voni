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
 * `src/app/api/demo/token/route.ts` for the four layers behind that. The
 * demo-mode disclosure (live browser call, 2 minutes, microphone, daily
 * per-visitor cap) now sits inside the card's idle state (DESIGN.md §10c).
 */
export function LandingDemo() {
  return <VoiceCall mode={{ kind: "demo" }} />;
}
