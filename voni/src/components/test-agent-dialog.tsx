"use client";

import { Tip } from "@/components/tip";

/**
 * Adapted from Blocks `@blocks-so/ai-05` ("AI Elements Chat", MIT,
 * Ephraim Duncan — see THIRD-PARTY-NOTICES.md).
 *
 * ai-05's AI-SDK provider logic is NOT adopted (DESIGN.md §3: markup idiom
 * only, no `ai`-SDK addition without amendment). What this keeps is the
 * layout: a fixed-height card (restyled to the standard Dialog surface in
 * the 2026-09-24 audit), the header with the presence line + the "New chat" action, and the transcript
 * scroll region with a scroll button. The transcript itself is Voni's
 * `Chat01` idiom (Base UI
 * MessageScroller + Bubble, no text composer — a voice call has nothing to
 * type), and the composer slot carries the live call control instead:
 * start/hang-up `LoadingButton`s, a `Progress` countdown, and the
 * mic-hint/status line. Tabler icons are swapped to lucide.
 *
 * Session behaviour is owned by `VoiceCall` in chromeless dialog mode:
 * `startingRef` single-flight, `voni:voice-preempt` mutual exclusion,
 * unmount `stop()`, `key={config.voiceId}` remount, the 180s cap, the 429
 * countdown vs mic vs drop vs hang-up error taxonomy, and the fixed-height
 * no-jump card. This dialog owns only the chrome: the fixed-height
 * standard Dialog surface (`h-140 sm:max-w-2xl`), its header
 * (title + dirty/saved version line + live presence), the "New call" reset,
 * the not-ready state inside the conversation region, and the composer-slot
 * call footer. The old DialogHeader badges and standalone Empty are merged
 * into ai-05's own header — the two visual languages are never stacked.
 */

import Link from "next/link";
import { useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Plus, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Progress } from "@/components/ui/progress";
import {
  VoiceCall,
  CALL_GREEN,
  HANGUP_RED,
  INLINE_CAP_SECONDS,
  type VoiceCallHandle,
  type VoiceCallStatus,
} from "@/components/voice-call";
import { formatCallStatus } from "@/lib/calls/call-status";
import type { AgentConfig } from "@/lib/agents/config";
import { cn } from "@/lib/utils";

const IDLE_STATUS: VoiceCallStatus = {
  state: "idle",
  elapsed: 0,
  toolActive: false,
  muted: false,
};

function presenceCopy(status: VoiceCallStatus, canTest: boolean): string {
  if (!canTest) return "Generation not ready";
  if (status.state === "idle") return "Ready to test";
  if (status.state === "connecting") return "Connecting";
  if (status.state === "ended") {
    return `Call ended · ${formatCallStatus(status.elapsed)}`;
  }
  if (status.toolActive) return "Looking that up";
  return `${formatCallStatus(status.elapsed)} · ${status.state}`;
}

export function TestAgentDialog({
  agentId,
  name,
  config,
  isDirty,
  canTest,
}: {
  agentId: string;
  name: string;
  config: AgentConfig;
  isDirty: boolean;
  canTest: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<VoiceCallStatus>(IDLE_STATUS);
  // Voice engine for the test call. Managed is the AssemblyAI session;
  // cascade drives the Python pipeline service (dev slice). Switching
  // remounts VoiceCall below, so no stale managed state can leak across.
  const [engine, setEngine] = useState<"managed" | "cascade">("managed");
  // Call-control state mirrored up from VoiceCall's chromeless presentation
  // so the ai-05 header owns the start/hang-up buttons and the footer owns
  // the countdown. Single-flight still lives in VoiceCall's startingRef;
  // these are only the pending paint (visual feedback protocol).
  const [callStarting, setCallStarting] = useState(false);
  const [callHangingUp, setCallHangingUp] = useState(false);
  // Hang-up failure is dialog-owned: VoiceCall's stop() path never surfaces
  // it, so a rejected hangUp() must land in-card (role=alert) rather than
  // silently clearing the pending flag (visual feedback protocol).
  const [hangUpError, setHangUpError] = useState<string | null>(null);
  const callRef = useRef<VoiceCallHandle | null>(null);

  const live = status.state === "listening" || status.state === "speaking";
  const callActive =
    status.state === "connecting" || status.state === "listening" || status.state === "speaking";
  const presence = presenceCopy(status, canTest);
  const remaining = INLINE_CAP_SECONDS - status.elapsed;

  const resetCall = () => {
    setStatus(IDLE_STATUS);
    setCallStarting(false);
    setCallHangingUp(false);
    setHangUpError(null);
  };

  const handleStart = () => {
    setHangUpError(null);
    callRef.current?.start();
  };

  const handleHangUp = () => {
    setHangUpError(null);
    try {
      // VoiceCallHandle types hangUp() as void, but the implementation is
      // async over session.stop(); if that rejects, the call is still live
      // — roll back with the in-card error instead of dropping to the idle
      // recap silently.
      const result: unknown = callRef.current?.hangUp();
      if (result instanceof Promise) {
        result.catch(() => {
          setHangUpError("Couldn't end the call. Try again.");
        });
      }
    } catch {
      setHangUpError("Couldn't end the call. Try again.");
    }
  };

  const handleToggleMute = () => {
    callRef.current?.toggleMute();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) resetCall();
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" variant="outline" />
        }
      >
        <Mic aria-hidden="true" />
        Test agent
      </DialogTrigger>
      {/* Standard Dialog surface (audit 2026-09-24): same radius, ring, and
          fill as every other dialog. Fixed 35rem height keeps the
          transcript from jumping as turns arrive; the max-h guard binds only
          on short viewports and the flex-1 transcript absorbs it. */}
      <DialogContent
        data-testid="test-agent-dialog"
        className="flex h-140 max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <header className="flex items-center justify-between gap-4 py-4 pr-12 pl-5">
          <div className="flex min-w-0 flex-col">
            {/* DialogTitle keeps the modal labelled for AT; visually it
                is ai-05's name line, not a stacked dialog header. */}
            <DialogTitle className="truncate text-sm leading-tight font-semibold">
              Test {name}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {config.identity.role || "Voice agent"}
            </DialogDescription>
            <span className="text-muted-foreground truncate text-xs">
              {isDirty ? "Testing unsaved edits" : "Testing saved version"}
            </span>
            <span
              className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
              aria-live="polite"
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  live ? "voice-call-live-dot" : "bg-muted-foreground/40",
                )}
              />
              {presence}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tip
              label={
                engine === "managed"
                  ? "Test call runs on the managed voice session. Switch to the cascade pipeline."
                  : "Test call runs on the cascade pipeline. Switch back to managed."
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => {
                  if (callActive) return;
                  setEngine((prev) => (prev === "managed" ? "cascade" : "managed"));
                  setStatus(IDLE_STATUS);
                  setHangUpError(null);
                }}
                disabled={!canTest || callActive}
              >
                {engine === "managed" ? "Managed" : "Cascade"}
              </Button>
            </Tip>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              onClick={resetCall}
              disabled={!canTest}
            >
              <Plus className="size-4" aria-hidden />
              New call
            </Button>
          </div>
        </header>

        <div className="border-border/60 flex min-h-0 flex-1 flex-col border-t">
          {canTest && open ? (
            <>
              <div className="min-h-0 flex-1">
                <VoiceCall
                  key={`${config.voiceId}-${engine}`}
                  ref={callRef}
                  mode={{ kind: "inline", config, agentId, isDirty }}
                  engine={engine}
                  presentation="dialog"
                  chromeless
                  // The dialog is the surface; the embedded card drops its
                  // own border so the edges never double.
                  className="rounded-none border-0"
                  onStatusChange={setStatus}
                  onPendingChange={(next) => {
                    setCallStarting(next.starting);
                    setCallHangingUp(next.hangingUp);
                  }}
                />
              </div>
              {/* Typing indicator <- toolActive: upstream ai-05's dot
                  markup as a pinned row under the transcript (VoiceCall
                  owns its internal scroller, so the slot can't live
                  inside it). Stagger via arbitrary properties — no inline style prop per DESIGN.md §5. */}
              {status.toolActive && live ? (
                <div className="px-5 pt-1">
                  <output
                    aria-label="Agent is looking something up"
                    className="flex h-7 items-center gap-1"
                  >
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className={cn(
                          "size-1.5 animate-bounce rounded-full bg-muted-foreground/60",
                          dot === 1 && "[animation-delay:150ms]",
                          dot === 2 && "[animation-delay:300ms]",
                        )}
                      />
                    ))}
                  </output>
                </div>
              ) : null}
            </>
          ) : (
            /* ai-05's conversation region with the not-ready state inside
               it (not a second Empty visual language): transcript area
               carries the message, footer carries the Jobs link. */
            <div className="flex h-full min-h-0 flex-col">
              <MessageScrollerProvider autoScroll defaultScrollPosition="end">
                <MessageScroller className="min-h-0 flex-1">
                  <MessageScrollerViewport aria-label="Call transcript">
                    <MessageScrollerContent className="gap-5 px-5 py-5">
                      <div className="flex flex-col items-center gap-1.5 px-2 py-8 text-center">
                        <Mic
                          className="text-muted-foreground size-5"
                          aria-hidden
                        />
                        <p className="text-sm font-semibold">
                          Test call not ready
                        </p>
                        <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
                          The generated voice and language are still
                          placeholders. Start a call after generation
                          finishes.
                        </p>
                      </div>
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton />
                </MessageScroller>
              </MessageScrollerProvider>
              <div className="flex flex-col gap-3 p-3">
                <div className="flex justify-center px-1">
                  <Button
                    nativeButton={false}
                    size="sm"
                    variant="outline"
                    render={<Link href="/jobs" />}
                  >
                    View progress in Jobs
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ai-05's composer slot, rebuilt as the call control: status +
            countdown / mic-hint, then start/hang-up LoadingButtons. */}
        {canTest && open ? (
          <div className="flex flex-col gap-3 p-3">
            <div className="flex flex-col items-center gap-1.5 px-2 text-center">
              {live && remaining <= 30 ? (
                <>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    {`${remaining}s left on this call`}
                  </p>
                  <Progress
                    value={Math.max(0, (remaining / 30) * 100)}
                    aria-label="Time left on this call"
                    className="w-32"
                  />
                </>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Uses your microphone · {INLINE_CAP_SECONDS / 60} min max
                  · Just talk — it speaks first.
                </p>
              )}
            </div>
            <div className="flex justify-center px-1">
              {callActive ? (
                <div className="flex gap-2">
                  {live ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 gap-2 rounded-full px-3.5 text-sm font-semibold"
                      aria-pressed={status.muted}
                      onClick={handleToggleMute}
                    >
                      {status.muted ? (
                        <MicOff className="size-4.5" aria-hidden />
                      ) : (
                        <Mic className="size-4.5" aria-hidden />
                      )}
                      {status.muted ? "Unmute" : "Mute"}
                    </Button>
                  ) : null}
                  <LoadingButton
                    pending={callHangingUp}
                    pendingText="Hanging up…"
                    icon={<PhoneOff className="size-4.5" aria-hidden />}
                    className={`h-11 gap-2 rounded-full px-7 text-sm font-semibold ${HANGUP_RED}`}
                    onClick={handleHangUp}
                    aria-label="End test call"
                  >
                    End call
                  </LoadingButton>
                </div>
              ) : (
                <LoadingButton
                  pending={callStarting}
                  pendingText="Calling…"
                  icon={<Phone className="size-4.5" aria-hidden />}
                  className={`h-11 gap-2 rounded-full px-7 text-sm font-semibold ${CALL_GREEN}`}
                  onClick={handleStart}
                  aria-label={`Call ${name}`}
                >
                  {status.state === "ended" ? "Call again" : `Call ${name}`}
                </LoadingButton>
              )}
            </div>
            {hangUpError && callActive ? (
              <Alert variant="destructive" className="mx-1">
                <TriangleAlert />
                <AlertDescription>{hangUpError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
