"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { DemoCallSkeleton } from "@/components/page-skeletons";
import { ReviewOverlay } from "@/components/review-overlay";
import { fixUnderReview } from "@/lib/demo/fix-gate";
import { reviewOverlayRequested } from "@/lib/demo/review-ratings";

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
  // Ticket 07: the same landing demo hosts the review overlay behind
  // `?review=1`. The overlay starts with no rows: the owner replays the
  // call's marks + delivered capture and rates each agent reply beside the
  // transcript, split and acknowledgement line used.
  // Ticket 08: the gate section marks the fix under review (`?fix=`).
  // A not-fixed mark stays open and blocks the next fix.
  // Derived on mount from the client URL (lazy initializer, not an
  // effect): the overlay flags are owner-only (`?review=1`, `?fix=`) and
  // never present for public visitors, so no hydration impact there.
  const [review] = useState(
    () =>
      typeof window !== "undefined" &&
      reviewOverlayRequested(window.location.search),
  );
  const [fixId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : fixUnderReview(window.location.search),
  );
  return (
    <>
      <VoiceCall mode={{ kind: "demo" }} />
      {review ? <ReviewOverlay callId="review-call" turns={[]} fixId={fixId} /> : null}
    </>
  );
}
