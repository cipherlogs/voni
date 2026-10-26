"use client";

import dynamic from "next/dynamic";
import { DemoCallSkeleton } from "@/components/page-skeletons";

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
 *
 * Ticket 05: the Demo call engine (`voice-call`) is a heavy interactive
 * module, so it loads on demand behind this card. The server still
 * prerenders the card; the client hydrates it once the engine chunk
 * arrives, painting DemoCallSkeleton meanwhile. Identical Demo call
 * behavior after load.
 */
const VoiceCall = dynamic(
  () => import("@/components/voice-call").then((mod) => mod.VoiceCall),
  { loading: () => <DemoCallSkeleton /> },
);

export function LandingDemo() {
  return <VoiceCall mode={{ kind: "demo" }} />;
}
