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
 * The demo is cascade-only (demo-cascade ticket 10). The browser sends
 * identity only: the mint (`src/app/api/demo/token/route.ts`) delivers the
 * pipeline URL, the demo subject and the single-use call token, and the client
 * starts the real cascade session on it. No prompt, tool list or pipeline
 * configuration is assembled in the browser.
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
