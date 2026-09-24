"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Phone,
  PhoneOff,
  TriangleAlert,
} from "lucide-react";
import { LandingOrb } from "@/components/landing-orb";
import { chipSlots, DEMO_CHIPS, type DemoChip } from "@/lib/demo/chips";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { LoadingButton } from "@/components/loading-button";
import { Chat01 } from "@/components/chat-01/chat-01";
import { Progress } from "@/components/ui/progress";
import {
  VoiceSession,
  authedToken,
  demoToken,
  effectiveInlineLanguages,
  type Transcript,
  type VoiceError,
  type VoiceState,
} from "@/lib/voice/session";
import { CallTimings } from "@/lib/voice/call-timings";
import { CascadeSession } from "@/lib/voice/cascade-session";
import {
  FILLER_POOL,
  requestVoiceJudge,
} from "@/lib/voice/jev-judges";
import { compileSystemPrompt } from "@/lib/agents/compile";
import type { AgentConfig } from "@/lib/agents/config";
import { compileVoiceTools } from "@/lib/tools/definitions";
import { formatCallStatus } from "@/lib/calls/call-status";
import { PERSONAS, personaConfig } from "@/lib/agents/personas";
import { cn } from "@/lib/utils";

/**
 * The live call surface.
 *
 * ── Two problems this revision fixes ───────────────────────────────────────
 *
 * 1. **It resized between states and shoved the page around.** The card grew
 *    and shrank as it moved between picking, calling, and showing captions, so
 *    everything below it jumped. Fixed by giving the card ONE fixed height per
 *    mode and letting a single flexing region absorb every variable-length
 *    thing inside it. Nothing outside the card can move now.
 *
 * 2. **Demo mode is its own layout.** The landing call (DESIGN.md §10c): the
 *    orb with a ‹ › scenario switcher and Start call at rest, opening into the
 *    call card with live state, hang-up and a flat live transcript. Each
 *    caller keeps its own default voice; the switcher locks during a call
 *    because the voice genuinely is immutable once a session starts.
 *
 * The rest follows the phone-call model people already have — portrait, name,
 * one pill to call, a timer while connected, a red circle to hang up, captions
 * as subtitles.
 */

type Mode =
  | {
      kind: "inline";
      config: AgentConfig;
      agentId?: string;
      /**
       * Whether the form holds unsaved edits. Gates the "Testing unsaved
       * edits" strip — the mockup's snapshot is the dirty state. Optional
       * until the host page wires it; absent means dirty (today's behaviour).
       */
      isDirty?: boolean;
    }
  | { kind: "demo" };


/**
 * Call = green solid fill, hang up = red solid fill. Universal across every
 * phone, softphone and messaging app (Jakob's Law).
 *
 * The live-call green is scoped (`.voice-call-live-fill` in globals.css —
 * owned by a parallel crew, referenced here, never defined here), never a
 * general token. Fill-only with white text; never body text.
 *
 * Hang-up is spelled out rather than using the `destructive` button variant:
 * this scaffold's `destructive` is a TINT (`bg-destructive/10` with red
 * text), not the solid red fill a hang-up button needs. The solid fill still
 * comes from the `destructive` token (both themes) with white text — no raw
 * red shade and no manual dark-mode overrides.
 */
const CALL_GREEN = "voice-call-live-fill";
export { CALL_GREEN };
const HANGUP_RED = "bg-destructive text-white hover:bg-destructive/90";
export { HANGUP_RED };

/** Session caps, in seconds. The server enforces them; the UI only mirrors. */
export const INLINE_CAP_SECONDS = 180;
const DEMO_CAP_SECONDS = 120;


/**
 * The error body copy sits a long way darker than `--destructive` itself.
 * Mixing toward `--foreground` reaches it in light mode AND inverts
 * correctly in dark, which a literal dark-red hex would not. Token-derived
 * color-mix is the one surviving arbitrary-value use (DESIGN.md §5
 * listed exception — no token expresses "destructive mixed toward
 * foreground", and a new token for one error line would be worse).
 */
const ERROR_BODY =
  "text-[color-mix(in_oklch,var(--destructive),var(--foreground)_45%)]";

/**
 * Liveness is static, not animated: the portrait ring and the state-line dot
 * use the scoped `.voice-call-live-ring` / `.voice-call-live-dot` classes in
 * globals.css (owned by a parallel crew). The bespoke `voni-callring`
 * keyframe bloom is cut; liveness reads from the static scoped-green ring +
 * dot + state text + hang-up affordance.
 */




/** The landing demo's three scenario tabs (mockup B1). */
const DEMO_PERSONAS = PERSONAS.slice(0, 3);

/** A tool chip: dashed while "running", then settles to a checked result. */
function DemoChipRow({ chip }: { chip: DemoChip }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setDone(true), 1500);
    return () => clearTimeout(id);
  }, []);
  return (
    <div
      className={cn(
        "flex h-9 items-center justify-between gap-3 rounded-lg border px-3 text-xs",
        done ? "bg-muted/50" : "border-foreground/20 text-foreground/70 border-dashed",
      )}
    >
      <span>{chip.pending.replace("…", "")}</span>
      {done ? (
        <span className="flex items-center gap-1.5 font-medium">
          <Check aria-hidden className="size-3.5 text-green-600" />
          {chip.done}
        </span>
      ) : (
        <span className="text-muted-foreground">Working…</span>
      )}
    </div>
  );
}

/**
 * Demo transcript in the mockup's flat idiom: a small speaker label over
 * each line, the live caption as the trailing muted line, a dashed row while
 * a tool runs. Scrolling and follow stay on MessageScroller.
 */
function DemoTranscript({
  turns,
  agentName,
  liveCaption,
  toolActive,
  chips,
  footer,
}: {
  turns: Transcript[];
  agentName: string;
  liveCaption: { role: "user" | "agent"; text: string } | null;
  toolActive: boolean;
  chips: DemoChip[];
  footer: React.ReactNode;
}) {
  const lines = liveCaption ? [...turns, { ...liveCaption, live: true }] : turns;
  const slots = chipSlots(lines, chips);
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="Call transcript" aria-live="polite">
          <MessageScrollerContent className="flex flex-col gap-3">
            {lines.flatMap((line, index) => {
              // A chip follows the finalized agent reply that triggers it.
              const chip = slots[index];
              const row = (
                <MessageScrollerItem
                  key={`${index}-${line.role}`}
                  messageId={`${index}-${line.role}`}
                  className="flex flex-col gap-1"
                >
                  <span className="text-foreground/60 text-xs leading-[normal]">
                    {line.role === "user" ? "You" : agentName}
                  </span>
                  <span
                    className={cn(
                      "text-sm leading-[1.55]",
                      "live" in line && "text-foreground/70",
                    )}
                  >
                    {line.text}
                  </span>
                </MessageScrollerItem>
              );
              return chip
                ? [
                    row,
                    <MessageScrollerItem key={`chip-${index}`} messageId={`chip-${index}`}>
                      <DemoChipRow chip={chip} />
                    </MessageScrollerItem>,
                  ]
                : [row];
            })}
            {toolActive ? (
              <MessageScrollerItem
                messageId="tool"
                className="border-foreground/20 text-foreground/70 flex h-9 items-center justify-between rounded-md border border-dashed px-3 font-mono text-xs"
              >
                <span>Using a tool</span>
                <span className="text-muted-foreground">running</span>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
      {footer ? <div className="flex flex-col items-center gap-1.5 pt-2">{footer}</div> : null}
    </MessageScrollerProvider>
  );
}

export type VoiceCallStatus = {
  state: VoiceState;
  elapsed: number;
  toolActive: boolean;
};

export type VoiceCallPending = {
  starting: boolean;
  hangingUp: boolean;
};

export type VoiceCallHandle = {
  start: () => void;
  hangUp: () => void;
};

export function VoiceCall({
  mode,
  className,
  onStatusChange,
  onPendingChange,
  presentation = "card",
  chromeless = false,
  engine = "managed",
  cascadeUrl,
  ref,
}: {
  mode: Mode;
  className?: string;
  onStatusChange?: (status: VoiceCallStatus) => void;
  onPendingChange?: (pending: VoiceCallPending) => void;
  presentation?: "card" | "dialog";
  /** ai-05 dialog host: the host header owns the call buttons and the host
      footer owns status, so the card renders identity + transcript only. */
  chromeless?: boolean;
  /**
   * Voice engine. "managed" is the AssemblyAI session; "cascade" drives the
   * Python pipeline service (dev slice over WebSocket). Demo mode always
   * uses managed; all UI states are shared so indicators work unchanged.
   */
  engine?: "managed" | "cascade";
  cascadeUrl?: string;
  ref?: React.Ref<VoiceCallHandle>;
}) {
  const isDemo = mode.kind === "demo";

  const [personaId, setPersonaId] = useState(PERSONAS[0].id);
  const persona = PERSONAS.find((p) => p.id === personaId) ?? PERSONAS[0];

  const [voiceId, setVoiceId] = useState(
    mode.kind === "inline" ? mode.config.voiceId : persona.voiceId,
  );

  const [state, setState] = useState<VoiceState>("idle");
  const [turns, setTurns] = useState<Transcript[]>([]);
  const [error, setError] = useState<VoiceError | null>(null);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const [toolActive, setToolActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  /** Jev-gated filler line shown while the reply is being prepared. */
  const [filler, setFiller] = useState<string | null>(null);
  /** Live caption from server partials — cleared when the final turn lands. */
  const [liveCaption, setLiveCaption] = useState<{ role: "user" | "agent"; text: string } | null>(
    null,
  );
  const timingsRef = useRef<CallTimings | null>(null);
  const agentSpeechStartRef = useRef(0);
  const fillerIdxRef = useRef(0);
  const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Native barge-in/reply-cut count this call (dev-visible via console). */
  const interruptionsRef = useRef(0);
  // Pending flags mirror the startingRef single-flight (start) and the async
  // stop() (hang-up) so both buttons show disabled + spinner + pending text
  // instead of silently dropping clicks (visual feedback protocol).
  const [starting, setStarting] = useState(false);
  const [hangingUp, setHangingUp] = useState(false);
  /** Demo: Close folds a finished call back to the lone orb. */
  const [closed, setClosed] = useState(false);

  const sessionRef = useRef<VoiceSession | CascadeSession | null>(null);
  const startingRef = useRef(false);

  // Synchronous pending mirror for the host footer: the onPendingChange
  // effect below only runs after paint, so the click handler also notifies
  // directly — the footer's Calling… lands in the same commit as the press,
  // before the token/mic/audio awaits resolve. The effect stays as the
  // steady-state mirror (same values → React bails out, no extra render).
  const onPendingChangeRef = useRef(onPendingChange);
  useEffect(() => {
    onPendingChangeRef.current = onPendingChange;
  }, [onPendingChange]);
  const pendingRef = useRef<VoiceCallPending>({ starting: false, hangingUp: false });
  const notifyPending = useCallback((next: VoiceCallPending) => {
    pendingRef.current = next;
    onPendingChangeRef.current?.(next);
  }, []);

  const capSeconds = isDemo ? DEMO_CAP_SECONDS : INLINE_CAP_SECONDS;
  const connected = state === "listening" || state === "speaking";
  const active = connected || state === "connecting";

  // In inline mode the edit form below owns the config, voice included; the
  // card only mirrors it. In demo mode the card owns both choices.
  const config: AgentConfig = useMemo(
    () => (mode.kind === "inline" ? mode.config : personaConfig(persona, voiceId)),
    [mode, persona, voiceId],
  );


  const displayName = config.identity.name;
  const remaining = capSeconds - elapsed;
  // The server enforces the session cap; this is only a client-side guess
  // used to tell "your free time ran out" apart from a voluntary hang-up,
  // since both otherwise land in the identical "ended" state.
  const quotaExceeded = isDemo && state === "ended" && elapsed >= capSeconds - 1;

  // Each tick schedules the next rather than running a setInterval off
  // Date.now(): decrementing by one avoids calling an impure clock during
  // render entirely, which the countdown only needs to feel accurate to
  // the second anyway.
  useEffect(() => {
    if (retryIn === null || retryIn <= 0) return;
    const id = setTimeout(() => setRetryIn((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(id);
  }, [retryIn]);

  useEffect(() => {
    if (!connected) return;
    const startedAt = Date.now() - elapsed * 1000;
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    onStatusChange?.({ state, elapsed, toolActive });
  }, [elapsed, onStatusChange, state, toolActive]);

  useEffect(() => {
    notifyPending({ starting, hangingUp });
  }, [hangingUp, notifyPending, starting]);

  // Scrolling, follow behavior, and jump-to-latest are owned by
  // MessageScroller below — no manual scroll-to-bottom effect.
  // A live session holds the microphone; unmounting without ending it leaves
  // the recording indicator on and burns the billable 30s resume window.
  useEffect(
    () => () => {
      void sessionRef.current?.stop();
      sessionRef.current = null;
    },
    [],
  );

  // Mutual exclusion with the global copilot: whoever starts ends the other
  // first, so two sessions never hold the mic (and the bill) at once.
  useEffect(() => {
    const onPreempt = (event: Event) => {
      const owner = (event as CustomEvent<{ owner?: string }>).detail?.owner;
      if (owner && owner !== "voice-call" && sessionRef.current) {
        void sessionRef.current.stop();
        sessionRef.current = null;
      }
    };
    window.addEventListener("voni:voice-preempt", onPreempt);
    return () => window.removeEventListener("voni:voice-preempt", onPreempt);
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    // Paint first, await after: state + the host-footter notification both
    // land synchronously here, so a slow token fetch or mic grant never
    // reads as a stuck click. Cleanup in `finally` restores both.
    setStarting(true);
    notifyPending({ ...pendingRef.current, starting: true });
    setError(null);
    setRetryIn(null);
    setTurns([]);
    setElapsed(0);
    setToolActive(false);
    setFiller(null);
    setLiveCaption(null);
    setClosed(false);
    interruptionsRef.current = 0;
    timingsRef.current = new CallTimings();
    timingsRef.current.mark("startRequested");
    window.dispatchEvent(
      new CustomEvent("voni:voice-preempt", { detail: { owner: "voice-call" } }),
    );

    if (engine === "cascade" && mode.kind === "inline") {
      // Cascade slice: Python pipeline service over WebSocket. Same UI
      // states as managed (connecting/listening/speaking/ended) so every
      // indicator, timer, caption, and the countdown below works unchanged.
      // Tools are not executed on the cascade path yet — the agent answers
      // from knowledge, so tool-heavy agents should stay on managed.
      const agentConfig = mode.config;
      const cascade = new CascadeSession({
        onCaption: (caption) => {
          if (caption.final) {
            timingsRef.current?.mark(
              caption.role === "user" ? "firstUserTurn" : "firstAgentTurn",
            );
            if (caption.role === "agent") {
              setFiller(null);
              setState("listening");
            }
            setLiveCaption(null);
            setTurns((prev) => [...prev, { role: caption.role, text: caption.text }]);
          } else {
            if (caption.role === "user") timingsRef.current?.mark("firstPartial");
            setLiveCaption({ role: caption.role, text: caption.text });
          }
        },
        onAudio: () => {
          setState("speaking");
        },
        onInterrupted: () => {
          setFiller(null);
          setState("listening");
        },
        onMetrics: (metrics, turns) => {
          console.debug("[voice-call] cascade metrics", { turns, metrics });
        },
        onError: (message) => {
          setError({ message });
        },
        onEnd: () => {
          setState("ended");
        },
      });
      sessionRef.current = cascade;
      setState("connecting");
      try {
        await cascade.start(
          {
            serviceUrl:
              cascadeUrl ??
              process.env.NEXT_PUBLIC_VOICE_PIPELINE_URL ??
              "ws://127.0.0.1:8766/v1/browser-call",
            pipeline: {
              llm_model:
                process.env.NEXT_PUBLIC_CASCADE_LLM_MODEL ?? "alibaba/qwen3.5-flash",
              tts_voice: process.env.NEXT_PUBLIC_CASCADE_TTS_VOICE ?? "",
              tts_model: process.env.NEXT_PUBLIC_CASCADE_TTS_MODEL ?? "sonic-2",
              fallback_mode: "cascade",
              language_codes: effectiveInlineLanguages(agentConfig.languageCodes),
            },
            systemPrompt: compileSystemPrompt(agentConfig),
            tools: [],
          },
          "voice-call",
        );
        setState("listening");
      } catch (e) {
        setError({
          message: e instanceof Error ? e.message : "Could not start the call.",
        });
        setState("ended");
      } finally {
        startingRef.current = false;
        setStarting(false);
        notifyPending({ ...pendingRef.current, starting: false });
      }
      return;
    }

    const session = new VoiceSession({
      onStateChange: (next) => {
        if (next === "speaking") agentSpeechStartRef.current = Date.now();
        if (next === "connecting" || next === "listening" || next === "speaking" || next === "ended")
          timingsRef.current?.mark(next);
        if (next === "listening") setFiller(null);
        setState(next);
      },
      onTranscript: (turn) => {
        if (turn.role === "user") timingsRef.current?.mark("firstUserTurn");
        else timingsRef.current?.mark("firstAgentTurn");
        if (turn.role === "agent") setFiller(null);
        setLiveCaption(null);
        setTurns((prev) => [...prev, turn]);
      },
      onUserPartial: (partial) => {
        // Live caption first: the screen shows words while they are spoken.
        // The judge debounce below stays untouched (fail-closed barge-in).
        if (partial.text) {
          setLiveCaption({ role: "user", text: partial.text });
          timingsRef.current?.mark("firstPartial");
        }
        if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
        const text = partial.text;
        partialTimerRef.current = setTimeout(() => {
          void requestVoiceJudge("barge-in", {
            partialText: text,
            agentSpeakingMs: Date.now() - agentSpeechStartRef.current,
          }).then((r) => {
            if (r.decision === "yield") setFiller(null);
          });
        }, 150);
      },
      onAgentPartial: (partial) => {
        // Agent captions stream word-by-word while it speaks — same live
        // caption line, cleared when the final agent turn lands.
        if (partial.text) {
          setLiveCaption({ role: "agent", text: partial.text });
          timingsRef.current?.mark("firstPartial");
        }
      },
      onError: (e) => {
        setError(e);
        setRetryIn(e.retryAfterSeconds ?? null);
      },
      onToolActivity: (active) => {
        setToolActive(active);
        if (active) {
          // Cover the tool-latency pause with a Jev-gated filler line.
          const line = FILLER_POOL[fillerIdxRef.current % FILLER_POOL.length];
          fillerIdxRef.current += 1;
          setFiller(line);
          timingsRef.current?.mark("fillerShown");
        } else {
          setFiller(null);
        }
      },
      onAudioProbe: (event) => {
        // Native interruption telemetry: with the 350ms interruption delay
        // these should be rare real barges, not backchannels.
        if (event.kind === "barge-in" || event.kind === "reply-cut") {
          interruptionsRef.current += 1;
          console.debug("[voice-call] interruption", event.kind, interruptionsRef.current);
        }
      },
    });
    sessionRef.current = session;

    // Straight from the click handler: getUserMedia and AudioContext startup
    // are gated behind a user gesture in every major browser.
    try {
      if (mode.kind === "demo") {
        await session.start(
          // Placeholder id — the token endpoint returns the real one and `start`
          // prefers it, so the browser cannot choose which agent it reaches.
          { mode: "agent", agentId: "" },
          demoToken(persona.id, voiceId),
        );
      } else {
        await session.start(
          {
            mode: "inline",
            systemPrompt: compileSystemPrompt(config),
            greeting: config.greeting,
            voiceId: config.voiceId,
            // The agent's own language picker stays authoritative; Automatic
            // (empty) locks to English so the test call skips 18-language
            // auto-detection every turn.
            languageCodes: effectiveInlineLanguages(config.languageCodes),
            tools: compileVoiceTools(config),
            testAgentId: mode.agentId,
          },
          authedToken,
        );
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
      notifyPending({ ...pendingRef.current, starting: false });
    }
  }, [mode, notifyPending, persona.id, voiceId, config, engine, cascadeUrl]);

  const hangUp = useCallback(async () => {
    if (hangingUp) return;
    setHangingUp(true);
    notifyPending({ ...pendingRef.current, hangingUp: true });
    try {
      await sessionRef.current?.stop();
      sessionRef.current = null;
    } finally {
      setHangingUp(false);
      notifyPending({ ...pendingRef.current, hangingUp: false });
    }
  }, [hangingUp, notifyPending]);

  // ai-05 dialog host drives start/hang-up from its own header buttons.
  useImperativeHandle(ref, () => ({ start, hangUp }), [start, hangUp]);



  // The heading the rail's aside is labelled by: in inline mode the host
  // page provides it via aria-label, but a bare card still needs its own
  // accessible name — and the visible title matches the mockup's callcard
  // in both modes.
  const callTitle = isDemo ? `Call ${displayName}` : "Test this agent";

  // The strip answers "which version am I about to talk to" in every inline
  // state, not just the dirty one — a pill that appears and disappears reads
  // as a warning, where the point is a permanent, checkable fact. Two claims
  // only, both of which the component can actually verify.
  const versionStrip =
    mode.kind === "inline"
      ? (mode.isDirty ?? true)
        ? "Testing unsaved edits · Save to deploy"
        : "Testing the saved version"
      : null;

  // Mockup mic-hint: the speaks-first instruction, not a repeat of the lede
  // above it. Shared by the empty-state block and the transcript footer below
  // so the hint survives once captions appear mid-call.
  const micHint = `Uses your microphone · ${capSeconds / 60} min max · Just talk — it speaks first.`;

  // "What is happening right now" — shared by both layouts; only rendered
  // off-idle.
  const statusText =
    state === "connecting"
      ? "Calling…"
      : connected
        ? toolActive
          ? (filler ?? "Looking that up…")
          : (filler ??
            `${formatCallStatus(elapsed)} · ${state === "speaking" ? "speaking" : "listening"}`)
        : quotaExceeded
          ? "Free demo time is up"
          : `Call ended · ${formatCallStatus(elapsed)}`;

  const errorAlert = error ? (
    <div
      role="alert"
      className="border-destructive/25 bg-destructive/5 flex w-full gap-2.5 rounded-xl border px-3 py-2.5 text-left"
    >
      <TriangleAlert className="text-destructive mt-px size-4 shrink-0" />
      <div>
        {retryIn !== null ? (
          <>
            <strong className="block text-sm font-semibold">
              Too many calls right now
            </strong>
            <p className={`mt-0.5 text-xs leading-snug ${ERROR_BODY}`}>
              {retryIn > 0
                ? `Try again in ${retryIn}s. The ${isDemo ? "demo" : "test call"} limit resets automatically.`
                : "You can try again now."}
            </p>
          </>
        ) : (
          <p className={`text-xs leading-snug ${ERROR_BODY}`}>{error.message}</p>
        )}
      </div>
    </div>
  ) : null;

  const countdown =
    connected && remaining <= 30 ? (
      <>
        <p className="text-muted-foreground text-xs">{`${remaining}s left on this call`}</p>
        <Progress
          value={Math.max(0, (remaining / 30) * 100)}
          aria-label="Time left on this call"
          className="w-32"
        />
      </>
    ) : null;

  const liveCaptionLine = liveCaption ? (
    <p className="text-xs italic" aria-live="polite">
      {liveCaption.role === "user" ? "You: " : `${displayName}: `}
      {liveCaption.text}
    </p>
  ) : null;

  // ── Demo layout ────────────────────────────────────────────────────────
  // The landing call (DESIGN.md §10c, round 3 "orb first"): at rest only the
  // orb, a scenario switcher and Start call show. Starting opens the card
  // around them: from lg it unfolds sideways into the portrait + transcript
  // card (A · Unfold); below lg the orb rises into a compact header and the
  // transcript drops open beneath it (B · Rise). Both layouts are rendered and
  // one is display:none per breakpoint, so neither ever measures the window.
  if (isDemo) {
    const open = (starting || state !== "idle" || error !== null) && !closed;
    const reveal = "duration-(--motion-reveal) ease-(--ease-out-soft)";
    const personaIndex = DEMO_PERSONAS.findIndex((p) => p.id === persona.id);
    const cycle = (step: number) => {
      const next = DEMO_PERSONAS[(personaIndex + step + DEMO_PERSONAS.length) % DEMO_PERSONAS.length];
      setPersonaId(next.id);
      setVoiceId(next.voiceId);
    };
    const demoStatus = error
      ? "Call didn't connect"
      : connected && !toolActive && !filler
        ? `${state === "speaking" ? "Speaking" : "Listening"} · ${formatCallStatus(elapsed)}`
        : statusText;

    const arrow = (step: number) => (
      <button
        type="button"
        aria-label={step < 0 ? "Previous scenario" : "Next scenario"}
        disabled={open}
        onClick={() => cycle(step)}
        className={cn(
          "text-foreground/70 hover:bg-muted hover:text-foreground flex size-11 cursor-pointer items-center justify-center rounded-full outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
          open && "invisible opacity-0",
        )}
      >
        {step < 0 ? <ChevronLeft className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
      </button>
    );
    const switcher = (
      <div className="flex items-center gap-0.5">
        {arrow(-1)}
        <div aria-live="polite" className="flex min-w-49 flex-col items-center gap-0.75">
          <p className="text-base leading-tight font-semibold">{displayName}</p>
          <p className="text-foreground/70 text-ui leading-tight">
            {config.identity.role} · {persona.vertical}
          </p>
        </div>
        {arrow(1)}
      </div>
    );
    const statusLine = (
      <>
        {connected ? (
          <span aria-hidden className="relative size-1.5 shrink-0">
            <span className="landing-ping voice-call-live-dot absolute inset-0 rounded-full" />
            <span className="voice-call-live-dot absolute inset-0 rounded-full" />
          </span>
        ) : null}
        <span className="truncate">{demoStatus}</span>
      </>
    );
    const startButton = (
      <LoadingButton
        pending={starting}
        pendingText="Calling…"
        icon={<Phone className="size-4" aria-hidden />}
        className={`h-11 gap-2 rounded-full px-4.5 text-sm font-medium ${CALL_GREEN}`}
        onClick={start}
      >
        {open && state === "ended" ? "Call again" : "Start call"}
      </LoadingButton>
    );
    const callButtons = active ? (
        <LoadingButton
          pending={hangingUp}
          className={`h-11 rounded-full px-4.5 text-sm font-medium ${HANGUP_RED}`}
          onClick={hangUp}
        >
          Hang up
        </LoadingButton>
      ) : (
        <>
          {startButton}
          {open ? (
            <Button
              variant="outline"
              className="h-11 rounded-full px-4 text-sm font-medium"
              onClick={() => setClosed(true)}
            >
              Close
            </Button>
          ) : null}
        </>
      );
    const disclosure = (
      <p
        aria-hidden={open}
        className={cn(
          "text-muted-foreground text-ui max-w-75 overflow-hidden text-center leading-relaxed transition-[max-height,opacity]",
          reveal,
          open ? "max-h-0 opacity-0" : "max-h-12",
        )}
      >
        {displayName} speaks first. A {capSeconds / 60}-minute call on your
        microphone, no sign-up, limited per day.
      </p>
    );
    // Kept rendered after Close so the card folds shut over its content
    // instead of cutting to empty; the hidden panels are inert at rest.
    const transcript =
      errorAlert ??
        (turns.length > 0 || connected ? (
          <DemoTranscript
            turns={turns}
            agentName={displayName}
            liveCaption={liveCaption}
            toolActive={toolActive}
            chips={DEMO_CHIPS[persona.id] ?? []}
            footer={countdown}
          />
        ) : state === "ended" ? (
          <p className="text-base leading-snug text-balance">
            {quotaExceeded
              ? "That's the free demo time for today."
              : "Call again, or close to try another scenario."}
          </p>
        ) : starting || state === "connecting" ? (
          <p className="text-muted-foreground text-ui">Connecting…</p>
        ) : null);
    const shell = cn(
      "mx-auto overflow-hidden rounded-[1rem] border transition-[width,border-color,background-color,box-shadow]",
      reveal,
      open ? "bg-card shadow-landing" : "border-transparent shadow-none",
    );

    return (
      <div
        role="region"
        aria-label={callTitle}
        data-voice-state={state}
        data-open={open}
        className={cn("w-full text-left", className)}
      >
        {/* A · Unfold (lg and up): the 360px portrait column widens into
            the 880px card; the transcript panel was there all along,
            clipped, and fades in once there is room. */}
        <div className={cn(shell, "hidden lg:block", open ? "w-220" : "w-90")}>
          <div
            inert={!open}
            className={cn(
              "bg-muted/50 grid border-b transition-[grid-template-rows,opacity,border-color]",
              reveal,
              open ? "grid-rows-[1fr]" : "grid-rows-[0fr] border-transparent opacity-0",
            )}
          >
            <div className="flex min-h-0 items-center justify-between overflow-hidden px-4">
              <span className="text-foreground/60 flex h-11 items-center font-mono text-xs">
                LIVE DEMO · {persona.vertical.toUpperCase()}
              </span>
              <span className="text-foreground/60 font-mono text-xs">BROWSER CALL · NO SIGN-UP</span>
            </div>
          </div>
          <div className="flex w-220">
            <div
              className={cn(
                "flex w-90 shrink-0 flex-col items-center justify-center gap-3.5 border-r px-6 transition-[padding,border-color]",
                reveal,
                open ? "py-7" : "border-transparent py-2",
              )}
            >
              <div className={cn("transition-[scale]", reveal, open ? "scale-100" : "scale-110")}>
                <LandingOrb />
              </div>
              {switcher}
              <p
                role="status"
                aria-hidden={!open}
                className={cn(
                  "text-foreground/70 text-ui flex items-center gap-1.5 overflow-hidden leading-[normal] tabular-nums transition-[height,opacity]",
                  reveal,
                  open ? "h-4.5" : "h-0 opacity-0",
                )}
              >
                {statusLine}
              </p>
              <div className="flex gap-2">{callButtons}</div>
              {disclosure}
            </div>
            <div
              inert={!open}
              className={cn(
                "flex h-110 w-130 min-w-0 flex-col gap-3 p-6 transition-opacity",
                open ? "delay-300" : "opacity-0",
              )}
            >
              <span className="text-foreground/60 font-mono text-xs tracking-[0.08em]">
                LIVE TRANSCRIPT
              </span>
              {transcript}
            </div>
          </div>
        </div>

        {/* B · Rise (below lg): the orb flies into the header's corner (a
            container-query offset keeps it centred at any width), the rest
            controls fade out, the call bar fades in, and the transcript
            drops open underneath. Orb size, dock scale and centring offset
            all come from --landing-orb* in globals.css. */}
        <div className={cn(shell, "@container max-w-160 lg:hidden")}>
          <div
            className={cn(
              "relative overflow-hidden border-b transition-[height,border-color]",
              reveal,
              open ? "h-19" : "h-105 border-transparent",
            )}
          >
            <div
              className={cn(
                "absolute top-0 left-0 origin-top-left transition-[translate,scale]",
                reveal,
                open
                  ? "translate-x-3.5 translate-y-3.5 scale-(--landing-orb-docked)"
                  : "translate-x-(--landing-orb-center) translate-y-5.5",
              )}
            >
              <LandingOrb />
            </div>
            <div
              inert={open}
              className={cn(
                "absolute inset-x-0 top-47 flex flex-col items-center gap-3.5 transition-[opacity,translate] md:top-54",
                reveal,
                open && "-translate-y-6 opacity-0",
              )}
            >
              {switcher}
              {startButton}
              {disclosure}
            </div>
            <div
              inert={!open}
              className={cn(
                "absolute top-3.5 right-3.5 left-18.5 flex h-12 items-center justify-between gap-3 transition-opacity",
                open ? "delay-400" : "opacity-0",
              )}
            >
              <div className="flex min-w-0 flex-col gap-0.75">
                <p className="text-md truncate leading-tight font-semibold">
                  {displayName} <span className="text-muted-foreground font-normal">· {persona.vertical}</span>
                </p>
                <p role="status" className="text-foreground/70 text-ui flex items-center gap-1.5 leading-[normal] tabular-nums">
                  {statusLine}
                </p>
              </div>
              {active ? <div className="shrink-0">{callButtons}</div> : null}
            </div>
          </div>
          <div
            inert={!open}
            className={cn(
              "flex flex-col overflow-hidden px-4.5 transition-[height,opacity] md:px-6",
              reveal,
              open ? "h-100" : "h-0 opacity-0",
            )}
          >
            <div className="flex min-h-0 flex-1 flex-col py-4.5">{transcript}</div>
            {/* Phones: after the call its buttons sit under the transcript so
                the header keeps room for the caller's name. */}
            {!active && (state === "ended" || error) ? (
              <div className="flex gap-2 pb-4.5">{callButtons}</div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    // Fills its host rail; the flexing region near the bottom absorbs every
    // state change internally.
    <div
      role="region"
      aria-label={callTitle}
      data-voice-state={state}
      className={cn(
        "bg-card flex h-full min-h-0 w-full flex-col items-center rounded-2xl border p-4 text-center md:p-5",
        className,
      )}
    >
      {/* Callcard header: inline mirrors the on-screen config including
          unsaved edits — say so, or users leave believing the test covered
          the deployed version. */}
      {presentation === "card" ? (
        <>
          <h2 className="text-base font-semibold">{callTitle}</h2>
          <p className="text-muted-foreground mt-1 text-sm leading-normal">
            Talks to the version on screen, including unsaved edits. No phone number involved.
          </p>
          {versionStrip ? (
            <p className="text-foreground/75 bg-muted/50 mt-2.5 inline-flex items-center rounded-full border px-3 py-1.25 text-xs">
              {versionStrip}
            </p>
          ) : null}
        </>
      ) : null}

      {/* Identity. Static scoped-green ring while the call is live: identical
          in every live sub-state, so the geometry never shifts. */}
      <div className="relative mt-4">
        {active ? (
          <span
            aria-hidden
            className="voice-call-live-ring absolute -inset-1.5 rounded-full border-2"
          />
        ) : null}
        <div
          aria-hidden
          className="bg-primary text-primary-foreground relative flex size-21 items-center justify-center rounded-full text-3xl font-semibold"
        >
          {displayName.charAt(0)}
        </div>
      </div>

      <div className="mt-2.5 text-lg font-semibold tracking-tight">
        {displayName}
      </div>
      <div className="text-muted-foreground mt-0.5 text-sm tabular-nums">
        {config.identity.role}
      </div>
      {state !== "idle" ? (
        <p
          className="mt-2 inline-flex items-center gap-2 text-sm font-semibold tabular-nums"
          role="status"
        >
          {connected ? (
            <span
              aria-hidden
              className="voice-call-live-dot inline-block size-2 shrink-0 rounded-full"
            />
          ) : null}
          {statusText}
        </p>
      ) : null}

      {/* Primary action. Chromeless ai-05 hosts render these in their own
          header/footer instead. */}
      {chromeless ? null : (
        <div className="mt-3.5 flex justify-center">
          {active ? (
            <LoadingButton
              pending={hangingUp}
              icon={<PhoneOff className="size-5.5" />}
              className={`size-13 rounded-full p-0 ${HANGUP_RED}`}
              onClick={hangUp}
              aria-label="End test call"
            >
              {null}
            </LoadingButton>
          ) : (
            <LoadingButton
              pending={starting}
              pendingText="Calling…"
              icon={<Phone className="size-4.5" aria-hidden />}
              className={cn(
                "h-11 gap-2 rounded-full px-7 text-sm font-semibold",
                presentation === "card" && CALL_GREEN,
              )}
              onClick={start}
              aria-label={`Call ${displayName}`}
            >
              {state === "ended" ? "Call again" : `Call ${displayName}`}
            </LoadingButton>
          )}
        </div>
      )}

      {/* The one flexing region: countdown, errors, captions. */}
      <div
        className={cn(
          "mt-3 min-h-0 w-full flex-1 overflow-hidden",
          turns.length === 0 && !error && "flex items-center-safe justify-center",
        )}
      >
        {errorAlert ??
          (turns.length > 0 ? (
            <div className="mt-0.5 flex size-full min-h-0 flex-col text-left">
              <Chat01 turns={turns} agentName={displayName} />
              {connected ? (
                <div className="flex flex-col items-center gap-1.5 px-2 pt-2 text-center">
                  {countdown ??
                    liveCaptionLine ?? (
                      <p className="text-muted-foreground text-xs">{micHint}</p>
                    )}
                </div>
              ) : null}
            </div>
          ) : state === "ended" ? (
            <div className="w-full rounded-xl border px-3 py-2.5 text-left text-sm">
              {quotaExceeded
                ? "The test call limit was reached — it resets automatically, so you can try again in a bit."
                : "Call again anytime within the test call limit."}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1.5 px-2 text-center">
              {connected
                ? (countdown ??
                  liveCaptionLine ?? (
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      Just talk — it speaks first.
                    </p>
                  ))
                : null}
              {!connected && !chromeless ? (
                <p className="text-muted-foreground text-xs">{micHint}</p>
              ) : null}
            </div>
          ))}
      </div>
    </div>
  );
}
