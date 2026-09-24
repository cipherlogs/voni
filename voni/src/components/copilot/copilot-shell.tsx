/**
 * Global copilot dropdown: live call pill + detail panel, anchored to the
 * viewport corner beside the sidebar's Voice row.
 *
 * No portal, no second "Start talking" step — tapping Voice in the rail IS
 * consent, the way a phone call works. The pill carries the timer and true
 * call controls (mic mute, speaker mute, end); the panel only opens for
 * things that need reading: errors, pending proposals, and the privacy
 * disclosure.
 *
 * Non-modal on purpose — mouse and keyboard stay usable beside it. The stack
 * sits above the viewport bottom and keeps navigation reachable at 390px.
 */

"use client";

import { Tip } from "@/components/tip";
import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCallStatus } from "@/lib/calls/call-status";
import { useCopilot, type CopilotStatus } from "./copilot-provider";

const STATUS_TEXT: Record<CopilotStatus, string> = {
  idle: "Voice copilot is off.",
  starting: "Connecting…",
  live: "On the call.",
  reconnecting: "Reconnecting — your conversation is kept for 30 seconds.",
  error: "Voice copilot hit a problem.",
};

function RecoveryHint({ code }: { code?: string }) {
  const tap = "then tap Voice copilot";
  const hint =
    code === "mic"
      ? "Allow the mic in your browser — usually the icon in the " +
        `address bar — ${tap} to try again. Or keep typing.`
      : code === "busy-mic"
        ? `Another voice session holds the mic. Stop it first, ${tap}.`
        : code === "auth"
          ? `Sign in again, ${tap}.`
          : code === "config"
            ? "Add an AssemblyAI key in Settings, or keep using " +
              "mouse and keyboard."
            : code === "expired"
              ? "That call ended. Tap Voice copilot when ready."
              : `Check your connection and ${tap} — or tap what ` +
                "you need instead.";
  return <AlertDescription>{hint}</AlertDescription>;
}

function formatElapsed(totalSeconds: number): string {
  // Shared m:ss rule with call durations and job elapsed times
  // (lib/calls/call-status.ts) so every elapsed time reads the same way.
  // Local wrapper (not a direct import) because negative/NaN inputs here
  // mean "still starting" rather than "clamp to zero".
  return Number.isFinite(totalSeconds) && totalSeconds >= 0
    ? formatCallStatus(totalSeconds)
    : "0:00";
}

export function CopilotShell() {
  const {
    status,
    error,
    micMuted,
    speakerMuted,
    live,
    proposals,
    toolActive,
    sessionId,
    stop,
    toggleMicMute,
    toggleSpeakerMute,
    applyTap,
    dismissTap,
    noteInteraction,
  } = useCopilot();
  const [expanded, setExpanded] = useState(false);
  // Call timer, local to the shell — the provider only learns durations at
  // hang-up. The effect only ticks.
  const [elapsed, setElapsed] = useState(0);

  // The panel is for reading, not for starting: errors and pending proposals
  // force it open by derivation below, so no effect has to sync it.
  const showPanel = expanded || error !== null || proposals.length > 0;

  // Call timer, local to the shell — the provider only learns durations at
  // hang-up. The effect only ticks; the rail button owns the start reset.
  useEffect(() => {
    if (!live) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [live]);

  const showCallControls = live || status === "starting";
  // Nothing to show while idle: the rail button is the entry point.
  if (!showPanel && !showCallControls) return null;

  return (
    <div
      data-copilot-scope="copilot"
      className="fixed right-4 bottom-4 z-50 flex max-h-[calc(100dvh-2rem)] flex-col items-end gap-2 overflow-y-auto"
      onPointerDown={noteInteraction}
      onKeyDown={noteInteraction}
    >
      {showPanel ? (
        <Card className="max-h-[60vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium">Voice copilot</CardTitle>
            {/* Collapse only shows when it can actually hide the panel: while
                an error or proposal forces it open, X would look broken. */}
            {expanded && !error && proposals.length === 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-copilot-effect="view" onClick={() => setExpanded(false)}
                aria-label="Collapse voice panel"
              >
                <X aria-hidden />
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-muted-foreground text-xs" aria-live="polite">
              {STATUS_TEXT[status]}
              {toolActive ? " Looking that up…" : null}
            </p>

            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
                <RecoveryHint code={error.code} />
                {typeof error.retryAfterSeconds === "number" ? (
                  <AlertDescription>
                    Try again in {error.retryAfterSeconds}s.
                  </AlertDescription>
                ) : null}
              </Alert>
            ) : null}

            {proposals.length > 0 ? (
              <p className="text-muted-foreground text-xs" aria-live="polite">
                A change is waiting below — say yes, or tap Apply.
              </p>
            ) : null}

            {proposals.map((proposal) => {
              const armed = proposal.status === "armed";
              return (
                <div
                  key={proposal.id}
                  data-copilot-key={proposal.id}
                  className="border-border rounded-lg border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{proposal.summary}</p>
                    <Badge variant={armed ? "default" : "secondary"}>
                      {armed ? "Ready to confirm" : "Reading back…"}
                    </Badge>
                  </div>
                  {!armed ? (
                    <p className="text-muted-foreground mt-1 text-xs">
                      Let me finish reading that back — then Apply unlocks, or say it.
                    </p>
                  ) : null}
                  <div className="mt-2 flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => dismissTap(proposal.id)}
                    >
                      Dismiss
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!armed}
                      data-copilot-manual="independent-assent" onClick={() => applyTap(proposal.id)}
                    >
                      Apply
                    </Button>
                  </div>
                </div>
              );
            })}

            <p className="text-muted-foreground text-xs">
              Audio is processed by AssemblyAI to run the conversation, and its
              service records sessions. The mic is live only while on a call —
              End stops it immediately, and quiet sessions end on their own.
              {sessionId ? (
                <span className="mt-1 block font-mono">Session {sessionId}</span>
              ) : null}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {showCallControls ? (
        <div
          className="bg-card border-border flex items-center gap-1 rounded-full border py-1 pr-1 pl-3"
          aria-label="Voice call controls"
        >
          <span className="text-muted-foreground font-mono text-xs tabular-nums" aria-live="off">
            {status === "starting" ? "…" : formatElapsed(elapsed)}
          </span>
          <Tip label={micMuted ? "Unmute mic" : "Mute mic"}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              data-copilot-effect="view" onClick={toggleMicMute}
              aria-pressed={micMuted}
              aria-label={micMuted ? "Unmute your mic" : "Mute your mic"}
            >
              {micMuted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
            </Button>
          </Tip>
          <Tip label={speakerMuted ? "Unmute speaker" : "Mute speaker"}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              data-copilot-effect="view" onClick={toggleSpeakerMute}
              aria-pressed={speakerMuted}
              aria-label={speakerMuted ? "Unmute copilot voice" : "Mute copilot voice"}
            >
              {speakerMuted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
            </Button>
          </Tip>
          <Tip label={showPanel ? "Collapse panel" : "Expand panel"}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              data-copilot-effect="view" onClick={() => setExpanded((open) => !open)}
              aria-expanded={showPanel}
              aria-label={showPanel ? "Collapse voice panel" : "Expand voice panel"}
            >
              {showPanel ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
            </Button>
          </Tip>
          <Tip label={"End call"}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-destructive hover:text-destructive rounded-full"
              data-copilot-effect="view" onClick={stop}
              aria-label="End voice call"
            >
              <PhoneOff aria-hidden />
            </Button>
          </Tip>
        </div>
      ) : null}
    </div>
  );
}
