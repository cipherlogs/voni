"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  TriangleAlert,
} from "lucide-react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { LandingOrb } from "@/components/landing-orb";
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
import { buildAgentKeyterms, buildAgentTranscriptionPrompt } from "@/lib/voice/transcription";
import { CallSounds } from "@/lib/voice/call-sounds";
import { compileVoiceTools } from "@/lib/tools/definitions";
import { formatCallStatus } from "@/lib/calls/call-status";
import { ACCENT_FLAG, getVoice, voiceLabel } from "@/lib/agents/voices";
import {
  DEMO_VOICE_IDS,
  MUTE_CHECK_IN_INSTRUCTIONS,
  OPEN_BEAT_GOAL,
  TIME_UP_INSTRUCTIONS,
  rungInstructions,
  voniConfig,
} from "@/lib/demo/voni-agent";
import { TALK_BASE_S, TalkClock } from "@/lib/demo/talk-clock";
import { ReplyQueue, StakesLadder } from "@/lib/demo/stakes-ladder";
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
 *    orb with a ‹ › voice/language switcher and Start call at rest, opening
 *    into the call card with live state, hang-up and a flat live transcript.
 *    Voni always talks as itself; the switcher locks during a call because
 *    the voice genuinely is immutable once a session starts.
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
/** Demo: talk-clock seconds (paused on mute); the server holds the wall cap. */
const DEMO_CAP_SECONDS = TALK_BASE_S;
/** After asking Voni to close, stop the session ourselves if it never does. */
const CLOSE_FALLBACK_MS = 20000;


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




const MOBILE_DEMO_QUERY = "(max-width: 1023px)";

function useIsBelowLg() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(MOBILE_DEMO_QUERY);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(MOBILE_DEMO_QUERY).matches,
    () => false,
  );
}

/**
 * Word-by-word reveal for streaming captions. Deltas arrive cumulative, so
 * React reconciles by index: settled words stay mounted (no re-animation),
 * only newly arrived words mount with the fade. Delays are classes
 * (`.stream-delay-*` in globals.css), never inline styles — the design
 * foundation bans style objects outside listed exceptions. Dead under
 * `prefers-reduced-motion` — then it is plain text.
 */
function StreamingText({ text }: { text: string }) {
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((part, index) =>
        part === "" || /^\s+$/.test(part) ? (
          <span key={index}>{part}</span>
        ) : (
          // Part index (not word ordinal) still staggers monotonically and
          // is cap-safe; spaces merely shift later words a step.
          <span key={index} className={`stream-word stream-delay-${Math.min(index, 12)}`}>
            {part}
          </span>
        ),
      )}
    </>
  );
}

/**
 * Demo transcript in the mockup's flat idiom: a small speaker label over
 * each line and the live caption as the trailing muted line. Scrolling and
 * follow stay on MessageScroller; tool latency remains in the status line.
 */
function DemoTranscript({
  turns,
  agentName,
  liveCaption,
  footer,
}: {
  turns: Transcript[];
  agentName: string;
  liveCaption: { role: "user" | "agent"; text: string; overheard?: boolean } | null;
  footer: React.ReactNode;
}) {
  const lines = liveCaption ? [...turns, { ...liveCaption, live: true }] : turns;
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="Call transcript" aria-live="polite">
          <MessageScrollerContent className="flex flex-col gap-3">
            {lines.map((line, index) => (
              <MessageScrollerItem
                key={`${index}-${line.role}`}
                messageId={`${index}-${line.role}`}
                className="flex flex-col gap-1"
              >
                <span className="text-foreground/60 text-xs leading-[normal]">
                  {line.role === "user" ? "You" : agentName}
                  {"overheard" in line && line.overheard ? " · overheard" : ""}
                </span>
                <span
                  className={cn(
                    "text-sm leading-[1.55]",
                    "live" in line && "text-foreground/70",
                    "overheard" in line && line.overheard && "italic",
                  )}
                >
                  {"live" in line ? <StreamingText text={line.text} /> : line.text}
                </span>
              </MessageScrollerItem>
            ))}
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
  muted: boolean;
};

export type VoiceCallPending = {
  starting: boolean;
  hangingUp: boolean;
};

export type VoiceCallHandle = {
  start: () => void;
  hangUp: () => void;
  setMuted: (muted: boolean) => void;
  toggleMute: () => void;
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
  const isBelowLg = useIsBelowLg();
  const mobileTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [voiceId, setVoiceId] = useState<string>(
    mode.kind === "inline" ? mode.config.voiceId : DEMO_VOICE_IDS[0],
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
  const [liveCaption, setLiveCaption] = useState<
    { role: "user" | "agent"; text: string; overheard?: boolean } | null
  >(null);
  /** Whether the agent currently holds the floor (drives overheard display). */
  const speakingRef = useRef(false);
  /** Whether the live caption is an overheard partial (read in stale closures). */
  const overheardRef = useRef(false);
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
  const [muted, setMutedState] = useState(false);
  /** Demo: Close folds a finished call back to the lone orb. */
  const [closed, setClosed] = useState(false);
  /** Mobile call screen: full transcript hides behind a Captions toggle. */
  const [captionsOpen, setCaptionsOpen] = useState(false);

  const sessionRef = useRef<VoiceSession | CascadeSession | null>(null);
  const startingRef = useRef(false);
  /** Per-call sound player (lazy: Audio only exists in the browser). */
  const soundsRef = useRef<CallSounds | null>(null);
  const sounds = () => (soundsRef.current ??= new CallSounds());
  /** Connected chime fires once per call; reset every time we dial. */
  const connectedChimeRef = useRef(false);
  /** Last live caption's speaker + word count: new words strike the tick. */
  const captionWordsRef = useRef<{ role: string; words: number } | null>(null);
  /**
   * Demo call pacing (per call): the talk clock, the stakes ladder, the
   * queue that speaks their instructions between replies, and the call
   * token that scopes the judge. `closing` latches once Voni is asked to
   * end the call; the fallback timer stops it if Voni never does.
   */
  const clockRef = useRef<TalkClock | null>(null);
  const ladderRef = useRef<StakesLadder | null>(null);
  const replyQueueRef = useRef<ReplyQueue | null>(null);
  const callTokenRef = useRef<string | null>(null);
  const lastAgentLineRef = useRef("");
  const closingRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  /** Orb tint follows the call (reconnecting reads as connecting: alive). */
  const orbState = state === "reconnecting" ? "connecting" : state;
  const active = connected || state === "connecting";
  const demoOpen = isDemo && (starting || state !== "idle" || error !== null) && !closed;
  const mobileOpen = isBelowLg && demoOpen;

  // In inline mode the edit form below owns the config, voice included; the
  // card only mirrors it. In demo mode the card owns both choices.
  const config: AgentConfig = useMemo(
    () => (mode.kind === "inline" ? mode.config : voniConfig(voiceId)),
    [mode, voiceId],
  );
  const voice = getVoice(voiceId);
  const voiceLine = voice
    ? `${ACCENT_FLAG[voice.accent]} ${voice.language} · ${voiceLabel(voiceId)}`
    : voiceLabel(voiceId);


  const displayName = config.identity.name;
  const remaining = Math.max(0, capSeconds - elapsed);
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

  /**
   * Latch the call as closing, once: no rung, check-in, or time-up line may
   * follow a goodbye. Stops the session ourselves if it never ends.
   */
  const markClosing = useCallback((): boolean => {
    if (closingRef.current) return false;
    closingRef.current = true;
    replyQueueRef.current?.clear();
    closeTimerRef.current = setTimeout(() => void sessionRef.current?.stop(), CLOSE_FALLBACK_MS);
    return true;
  }, []);

  /** Ask Voni to close the call, once. */
  const closeCall = useCallback(
    (instructions: string) => {
      if (markClosing()) replyQueueRef.current?.enqueue(instructions);
    },
    [markClosing],
  );

  useEffect(() => {
    if (!connected) return;
    if (isDemo) {
      // The demo shows talk time: it freezes while muted (talk-clock.ts).
      const clock = (clockRef.current ??= new TalkClock(Date.now()));
      const id = setInterval(() => {
        const now = Date.now();
        setElapsed(clock.talkSeconds(now));
        // Never let a check-in replace a pending goodbye (the queue is latest-wins).
        if (clock.takeCheckIn(now) && !closingRef.current) {
          replyQueueRef.current?.enqueue(MUTE_CHECK_IN_INSTRUCTIONS);
        }
        if (clock.isOver(now)) closeCall(TIME_UP_INSTRUCTIONS);
      }, 500);
      return () => clearInterval(id);
    }
    const startedAt = Date.now() - elapsed * 1000;
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // A finished call drops its pending pacing work.
  useEffect(() => {
    if (state !== "ended") return;
    replyQueueRef.current?.clear();
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, [state]);

  useEffect(() => {
    onStatusChange?.({ state, elapsed, toolActive, muted });
  }, [elapsed, muted, onStatusChange, state, toolActive]);

  // Call earcons, driven by call state (see public/sounds/README.md — a
  // missing file is silence, never an error). Ringback loops from
  // connecting; the connected chime fires once per call on the first live
  // state; ended plays hangup unless an error already played its tone.
  useEffect(() => {
    if (state === "connecting") {
      connectedChimeRef.current = false;
      sounds().startRingback();
    } else if (state === "listening" || state === "speaking") {
      if (!connectedChimeRef.current) {
        connectedChimeRef.current = true;
        sounds().stopRingback();
        sounds().play("connected");
      }
    } else if (state === "ended") {
      sounds().stopRingback();
      if (!error) sounds().play("hangup");
    }
  }, [state, error]);

  // Failure tone, independent of the state effect above (an error mid-call
  // must sound even though the call has not ended).
  useEffect(() => {
    if (error) {
      sounds().stopRingback();
      sounds().play("error");
    }
  }, [error]);

  // Caption tick: each word landing in the live caption (either speaker,
  // managed or cascade — both write liveCaption) strikes the humanized tick.
  useEffect(() => {
    if (!liveCaption) {
      captionWordsRef.current = null;
      return;
    }
    const words = liveCaption.text.split(/\s+/).filter(Boolean).length;
    const prev = captionWordsRef.current;
    const grown = prev?.role === liveCaption.role ? words - prev.words : words;
    captionWordsRef.current = { role: liveCaption.role, words };
    if (grown > 0) sounds().tick(grown);
  }, [liveCaption]);

  const setCallState = useCallback((next: VoiceState) => {
    setState(next);
    if (next === "idle" || next === "ended") setMutedState(false);
  }, []);

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
      soundsRef.current?.stopAll();
      replyQueueRef.current?.clear();
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
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
    setMutedState(false);
    setFiller(null);
    setLiveCaption(null);
    setClosed(false);
    // Captions default open on phones (the toggle only exists below lg —
    // desktop always shows the transcript panel). The user can still close
    // them mid-call; this only sets the opening state.
    setCaptionsOpen(true);
    interruptionsRef.current = 0;
    clockRef.current = null;
    ladderRef.current = new StakesLadder();
    callTokenRef.current = null;
    lastAgentLineRef.current = "";
    closingRef.current = false;
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
              speakingRef.current = false;
              setFiller(null);
              setCallState("listening");
            }
            // A final that resolves an overheard partial keeps its mark in
            // history: speech the agent talked over still registered. The
            // mark clears only on the user final it belongs to, so an
            // agent final mid-overlap never eats it.
            setTurns((prev) => {
              const overheard =
                caption.role === "user" && overheardRef.current;
              if (overheard) overheardRef.current = false;
              return [...prev, { role: caption.role, text: caption.text, ...(overheard ? { overheard: true } : {}) }];
            });
            setLiveCaption(null);
          } else {
            // Live user caption (the heard-indicator): the running partial
            // renders in the transient subtitle line, marked overheard
            // while the agent holds the floor. Agent partials are
            // LLM-authored so they stream instantly at zero STT cost.
            if (caption.role === "user") {
              timingsRef.current?.mark("firstPartial");
              if (caption.text) {
                const overheard = speakingRef.current;
                overheardRef.current = overheard;
                setLiveCaption({ role: "user", text: caption.text, ...(overheard ? { overheard: true } : {}) });
              }
            } else setLiveCaption({ role: caption.role, text: caption.text });
          }
        },
        onAudio: () => {
          speakingRef.current = true;
          setCallState("speaking");
        },
        onInterrupted: () => {
          speakingRef.current = false;
          overheardRef.current = false;
          setFiller(null);
          setCallState("listening");
        },
        onMetrics: (metrics, turns) => {
          console.debug("[voice-call] cascade metrics", { turns, metrics });
        },
        onError: (message) => {
          setError({ message });
        },
        onEnd: () => {
          speakingRef.current = false;
          overheardRef.current = false;
          setCallState("ended");
        },
      });
      sessionRef.current = cascade;
      setCallState("connecting");
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
              transcription_prompt: buildAgentTranscriptionPrompt(agentConfig),
              keyterms_prompt: buildAgentKeyterms(agentConfig),
              // Seed the STT with the opening line so the first caller
              // reply transcribes against the right question.
              agent_context: agentConfig.greeting,
            },
            systemPrompt: compileSystemPrompt(agentConfig),
            tools: [],
          },
          "voice-call",
        );
        setCallState("listening");
      } catch (e) {
        setError({
          message: e instanceof Error ? e.message : "Could not start the call.",
        });
        setCallState("ended");
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
        speakingRef.current = next === "speaking";
        if (next === "connecting" || next === "listening" || next === "speaking" || next === "ended")
          timingsRef.current?.mark(next);
        if (next === "listening") setFiller(null);
        setCallState(next);
      },
      onTranscript: (turn) => {
        if (turn.role === "user") timingsRef.current?.mark("firstUserTurn");
        else timingsRef.current?.mark("firstAgentTurn");
        if (turn.role === "agent") setFiller(null);
        // Consumed only by the user final it belongs to: an agent final
        // mid-overlap must not clear the mark before the user final lands.
        if (turn.role === "user" && overheardRef.current) {
          turn = { ...turn, overheard: true };
          overheardRef.current = false;
        }
        setLiveCaption(null);
        setTurns((prev) => [...prev, turn]);
      },
      onUserPartial: (partial) => {
        // Live user caption: the running partial renders in the transient
        // subtitle line the moment it arrives (the heard-indicator), marked
        // overheard while the agent holds the floor. History still waits
        // for the settled final, so early guesses never flicker as speech.
        if (partial.text) {
          timingsRef.current?.mark("firstPartial");
          const overheard = speakingRef.current;
          overheardRef.current = overheard;
          setLiveCaption({ role: "user", text: partial.text, ...(overheard ? { overheard: true } : {}) });
        }
        if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
        const text = partial.text;
        partialTimerRef.current = setTimeout(() => {
          void requestVoiceJudge("barge-in", {
            partialText: text,
            agentSpeakingMs: Date.now() - agentSpeechStartRef.current,
          }).then((r) => {
            if (r.decision !== "yield") return;
            setFiller(null);
            sounds().tick(1, 0.9);
            // The gate committed: route the overlap to the LLM in context
            // so IT steers (transition-vs-continue) instead of resuming a
            // cut-off sentence over words it never addressed.
            sessionRef.current?.sendContext?.(
              `The caller said over your reply: "${text.slice(0, 200)}". Acknowledge it briefly first, then follow their direction. Do not resume the cut-off sentence.`,
            );
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
        // Native interruption telemetry: with the 500ms interruption delay
        // these should be rare real barges, not backchannels.
        if (event.kind === "barge-in" || event.kind === "reply-cut") {
          interruptionsRef.current += 1;
          console.debug("[voice-call] interruption", event.kind, interruptionsRef.current);
        }
      },
      onReplyStarted: () => replyQueueRef.current?.onReplyStarted(),
      // Demo: Voni is saying goodbye on its own (caller asked, or it
      // decided). Test calls keep their plain session-level hangup.
      onEndCall: () => {
        if (mode.kind === "demo") markClosing();
      },
      onInputSpeechStarted: () => replyQueueRef.current?.onCallerSpeech(),
      onReplyDone: () => replyQueueRef.current?.onReplyDone(),
      onAgentTurn: (turn) => {
        lastAgentLineRef.current = turn.text;
      },
      // Demo stakes ladder: Jev scores every visitor turn against the beat's
      // goal (heuristic fallback when Jev is down); each off-track verdict
      // climbs nudge → warning → polite end.
      onUserTurn: (turn) => {
        if (mode.kind !== "demo" || closingRef.current || !turn.text.trim()) return;
        const token = callTokenRef.current;
        void requestVoiceJudge(
          "off-track",
          { goal: OPEN_BEAT_GOAL, agentLine: lastAgentLineRef.current, userText: turn.text },
          { timeoutMs: 2500, headers: token ? { Authorization: `Bearer ${token}` } : undefined },
        ).then((verdict) => {
          if (sessionRef.current !== session || closingRef.current) return;
          const rung = ladderRef.current?.onVerdict(verdict.decision === "off-track");
          if (!rung) return;
          console.debug("[voice-call] off-track", rung, verdict.source);
          if (rung === "end") closeCall(rungInstructions(rung, OPEN_BEAT_GOAL));
          else replyQueueRef.current?.enqueue(rungInstructions(rung, OPEN_BEAT_GOAL));
        });
      },
    });
    sessionRef.current = session;
    replyQueueRef.current = new ReplyQueue((instructions) => session.requestReply(instructions));

    // Straight from the click handler: getUserMedia and AudioContext startup
    // are gated behind a user gesture in every major browser.
    try {
      if (mode.kind === "demo") {
        await session.start(
          // Placeholder id — the token endpoint returns the real one and `start`
          // prefers it, so the browser cannot choose which agent it reaches.
          { mode: "agent", agentId: "" },
          async () => {
            const minted = await demoToken(voiceId)();
            callTokenRef.current = minted.callToken ?? null;
            return minted;
          },
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
            // First-utterance STT tuning: scene + vocabulary for the opening
            // turn, which would otherwise run on generic recognition.
            transcriptionPrompt: buildAgentTranscriptionPrompt(config),
            keyterms: buildAgentKeyterms(config),
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
  }, [mode, notifyPending, voiceId, config, engine, cascadeUrl, setCallState, closeCall, markClosing]);

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

  const setMuted = useCallback(
    (nextMuted: boolean) => {
      if (!connected) return;
      setMutedState(nextMuted);
      clockRef.current?.setMuted(nextMuted, Date.now());
      sessionRef.current?.setInputMuted(nextMuted);
    },
    [connected],
  );

  const toggleMute = useCallback(() => {
    setMuted(!muted);
  }, [muted, setMuted]);

  // ai-05 dialog host drives start/hang-up from its own header buttons.
  useImperativeHandle(ref, () => ({ start, hangUp, setMuted, toggleMute }), [
    hangUp,
    setMuted,
    start,
    toggleMute,
  ]);



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
      <StreamingText text={liveCaption.text} />
      {liveCaption.overheard ? " · overheard" : ""}
    </p>
  ) : null;

  // ── Demo layout ────────────────────────────────────────────────────────
  // The landing call (DESIGN.md §10c, round 3 "orb first"): at rest only the
  // orb, a voice switcher and Start call show. Starting opens the card
  // around them: from lg it unfolds sideways into the portrait + transcript
  // card (A · Unfold); below lg the orb rises into a compact header and the
  // transcript drops open beneath it (B · Rise). Both layouts are rendered and
  // one is display:none per breakpoint, so neither ever measures the window.
  if (isDemo) {
    const open = demoOpen;
    const reveal = "duration-(--motion-reveal) ease-(--ease-out-soft)";
    const voiceIndex = Math.max(0, DEMO_VOICE_IDS.indexOf(voiceId as (typeof DEMO_VOICE_IDS)[number]));
    const cycle = (step: number) => {
      setVoiceId(DEMO_VOICE_IDS[(voiceIndex + step + DEMO_VOICE_IDS.length) % DEMO_VOICE_IDS.length]);
    };
    const demoStatus = error
      ? "Call didn't connect"
      : connected && !toolActive && !filler
        ? `${state === "speaking" ? "Speaking" : "Listening"} · ${formatCallStatus(elapsed)}`
        : statusText;

    const arrow = (step: number) => (
      <button
        type="button"
        aria-label={step < 0 ? "Previous voice" : "Next voice"}
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
          <p className="text-foreground/70 text-ui leading-tight">{voiceLine}</p>
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
      <div className="flex gap-2">
        {connected ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 gap-2 rounded-full px-3.5 text-sm font-medium"
            aria-pressed={muted}
            onClick={toggleMute}
          >
            {muted ? <MicOff className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
            {muted ? "Unmute" : "Mute"}
          </Button>
        ) : null}
        <LoadingButton
          pending={hangingUp}
          className={`h-11 rounded-full px-4.5 text-sm font-medium ${HANGUP_RED}`}
          onClick={hangUp}
        >
          Hang up
        </LoadingButton>
      </div>
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
            footer={countdown}
          />
        ) : state === "ended" ? (
          <p className="text-base leading-snug text-balance">
            {quotaExceeded
              ? "That's the demo time for this call."
              : "Call again, or close to try another voice."}
          </p>
        ) : starting || state === "connecting" ? (
          <p className="text-muted-foreground text-ui">Connecting…</p>
        ) : null);
    const shell = cn(
      "mx-auto overflow-hidden rounded-[1rem] border transition-[width,border-color,background-color,box-shadow]",
      reveal,
      open ? "bg-card shadow-landing" : "border-transparent shadow-none",
    );
    const mobileTrigger = (
      <BaseDialog.Trigger
        onClick={start}
        render={
          <Button
            ref={mobileTriggerRef}
            type="button"
            data-testid="landing-demo-start"
            className={`h-11 gap-2 rounded-full px-4.5 text-sm font-medium ${CALL_GREEN}`}
          />
        }
      >
        <Phone className="size-4" aria-hidden />
        Start call
      </BaseDialog.Trigger>
    );
    // WhatsApp idiom: circular icon controls docked at the bottom, the red
    // hang-up prominent at center. Mute stays connected-only with the same
    // hidden-context wiring; icon-only buttons keep accessible names so the
    // verifier and screen readers query them unchanged.
    const mobileDock = active || starting ? (
      <div
        data-testid="landing-demo-mobile-dock"
        className="flex items-center justify-center gap-5"
      >
        {connected ? (
          <Button
            type="button"
            variant="outline"
            aria-label={muted ? "Unmute" : "Mute"}
            aria-pressed={muted}
            onClick={toggleMute}
            className="size-14 rounded-full p-0"
          >
            {muted ? <MicOff className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
          </Button>
        ) : null}
        <LoadingButton
          pending={hangingUp}
          aria-label="Hang up"
          icon={<PhoneOff className="size-6" aria-hidden />}
          className={`size-16 rounded-full p-0 ${HANGUP_RED}`}
          onClick={hangUp}
        >
          {null}
        </LoadingButton>
      </div>
    ) : (
      <div
        data-testid="landing-demo-mobile-dock"
        className="flex items-center justify-center gap-2"
      >
        {startButton}
        {open ? (
          <BaseDialog.Close
            render={
              <Button
                variant="outline"
                className="h-11 rounded-full px-4 text-sm font-medium"
              />
            }
          >
            Close
          </BaseDialog.Close>
        ) : null}
      </div>
    );
    const captionsToggle =
      turns.length > 0 || connected ? (
        <div className="flex w-full flex-col items-center">
          <Button
            type="button"
            variant="ghost"
            aria-expanded={captionsOpen}
            onClick={() => setCaptionsOpen((v) => !v)}
            className="h-8 gap-1 rounded-full px-3 text-xs font-medium text-foreground/70"
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform", captionsOpen && "rotate-180")}
              aria-hidden
            />
            Captions
          </Button>
          {captionsOpen ? (
            <div
              data-testid="landing-demo-mobile-transcript"
              className="max-h-[36dvh] w-full overflow-y-auto overscroll-contain px-1 pt-1"
            >
              <DemoTranscript
                turns={turns}
                agentName={displayName}
                liveCaption={null}
                footer={countdown}
              />
            </div>
          ) : null}
        </div>
      ) : null;

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
                LIVE DEMO · {(voice?.language ?? "English").toUpperCase()}
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
                <LandingOrb state={orbState} />
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

        {/* B · Rise (below lg): the idle orb stays the controlled dialog
            trigger. Once a call starts, Base UI owns a full-viewport modal
            with the orb docked into its header and the transcript taking the
            remaining height. The root is explicitly modal so focus is trapped
            and page scrolling is locked; only the finished-call Close action
            is allowed to dismiss it. */}
        <BaseDialog.Root
          open={mobileOpen}
          modal
          disablePointerDismissal
          onOpenChange={(nextOpen, details) => {
            if (nextOpen) return;
            if (details.reason === "close-press" && !active) {
              setClosed(true);
              return;
            }
            details.cancel();
          }}
        >
          <div
            inert={open}
            aria-hidden={open}
            className={cn(
              shell,
              "@container max-w-160 lg:hidden",
              open && "pointer-events-none opacity-0",
            )}
          >
            <div className="relative h-105 overflow-hidden">
              <div className="absolute top-0 left-0 translate-x-(--landing-orb-center) translate-y-5.5">
                <LandingOrb />
              </div>
              <div className="absolute inset-x-0 top-47 flex flex-col items-center gap-3.5 md:top-54">
                {switcher}
                {mobileTrigger}
                {disclosure}
              </div>
            </div>
          </div>

          <BaseDialog.Portal>
            <BaseDialog.Backdrop
              data-testid="landing-demo-mobile-backdrop"
              className="fixed inset-0 z-50 m-0 h-[100dvh] w-[100dvw] bg-background/80 [transform:none] duration-[var(--motion-standard)] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
            />
            <BaseDialog.Popup
              data-testid="landing-demo-mobile-dialog"
              finalFocus={mobileTriggerRef}
              className="fixed inset-0 z-50 m-0 flex h-[100dvh] max-h-[100dvh] w-[100dvw] max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden overscroll-contain rounded-none border-0 bg-background p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] [transform:none] duration-[var(--motion-standard)] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 lg:hidden"
            >
              <BaseDialog.Title className="sr-only">Call {displayName}</BaseDialog.Title>
              <BaseDialog.Description className="sr-only">
              Live demo call with {displayName}.
              </BaseDialog.Description>
              {/* WhatsApp call screen: slim name + state header, orb hero,
                  one-line subtitle caption, Captions toggle, bottom dock.
                  The transcript never takes the screen — history lives
                  behind the toggle, bounded to 36dvh. */}
              <div className="flex min-h-0 flex-1 flex-col">
                <header className="flex shrink-0 flex-col items-center gap-1 px-6 pt-6 text-center">
                  <p className="text-lg leading-tight font-semibold">{displayName}</p>
                  <p className="text-foreground/70 text-ui leading-tight">{voiceLine}</p>
                  <p
                    role="status"
                    className="text-foreground/70 text-ui flex items-center gap-1.5 leading-[normal] tabular-nums"
                  >
                    {statusLine}
                  </p>
                </header>
                <div
                  data-testid="landing-demo-mobile-hero"
                  className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6"
                >
                  {/* The transcript caps at 36dvh; when captions open the
                      orb shrinks instead of being squeezed out, staying
                      visible at every height. */}
                  <div
                    className={cn(
                      "relative transition-transform duration-[var(--motion-standard)]",
                      captionsOpen && "scale-75",
                    )}
                  >
                    {active ? (
                      <span
                        aria-hidden
                        className="voice-call-live-ring absolute -inset-2 rounded-full border-2"
                      />
                    ) : null}
                    <LandingOrb state={orbState} />
                  </div>
                  <div
                    data-testid="landing-demo-mobile-caption"
                    aria-live="polite"
                    className="flex h-10 w-full max-w-75 items-center justify-center"
                  >
                    {liveCaption ? (
                      // Partial: an early guess, dimmed until the final lands.
                      <p className="line-clamp-2 text-center text-sm text-foreground/60">
                        {liveCaption.role === "user" ? "You: " : `${displayName}: `}
                        <StreamingText text={liveCaption.text} />
                        {liveCaption.overheard ? " · overheard" : ""}
                      </p>
                    ) : connected && turns.length > 0 ? (
                      // The settled final stays up, so the corrected words are
                      // what the caller reads — not the partial that preceded them.
                      <p className="line-clamp-2 text-center text-sm text-foreground/80">
                        {turns[turns.length - 1].role === "user" ? "You: " : `${displayName}: `}
                        {turns[turns.length - 1].text}
                      </p>
                    ) : state === "ended" && turns.length === 0 && !error ? (
                      <p className="text-center text-sm text-balance text-foreground/70">
                        {quotaExceeded
                          ? "That's the demo time for this call."
                          : "Call again, or close to try another voice."}
                      </p>
                    ) : countdown ? (
                      <span className="flex flex-col items-center gap-1">{countdown}</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-center gap-2 px-6">
                  {errorAlert ?? captionsToggle}
                </div>
                <div className="shrink-0 px-6 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                  {mobileDock}
                </div>
              </div>
            </BaseDialog.Popup>
          </BaseDialog.Portal>
        </BaseDialog.Root>
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
        <div className="mt-3.5 flex justify-center gap-2">
          {active ? (
            <>
              {connected ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 gap-2 rounded-full px-3.5 text-sm font-medium"
                  aria-pressed={muted}
                  onClick={toggleMute}
                >
                  {muted ? <MicOff className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
                  {muted ? "Unmute" : "Mute"}
                </Button>
              ) : null}
              <LoadingButton
                pending={hangingUp}
                icon={<PhoneOff className="size-5.5" />}
                className={`size-13 rounded-full p-0 ${HANGUP_RED}`}
                onClick={hangUp}
                aria-label="End test call"
              >
                {null}
              </LoadingButton>
            </>
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
