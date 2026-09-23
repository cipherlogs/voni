"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  Phone,
  PhoneOff,
  ChevronLeft,
  ChevronRight,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/loading-button";
import { Chat01 } from "@/components/chat-01/chat-01";
import { Progress } from "@/components/ui/progress";
import {
  VoiceSession,
  authedToken,
  demoToken,
  NATURAL_TURN_DETECTION,
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
import { PERSONAS, personaConfig, type Persona } from "@/lib/agents/personas";
import {
  VOICES,
  getVoice,
  voiceLabel,
  ACCENT_LABEL,
  type Voice,
} from "@/lib/agents/voices";
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
 * 2. **"Pick an agent" / "pick a voice" were separate screens of long lists.**
 *    Two failures in one: navigating away from the call to configure it broke
 *    the model people came in with, and sixteen voice names is a lot of reading
 *    for a choice nobody has an opinion about yet.
 *
 *    Replaced with direct manipulation, all on the one card:
 *      - a row of faces. Tap a face and that person calls you. Nothing to read
 *        and no screen to return from — the selection IS the portrait you are
 *        already looking at.
 *      - a language row, because "what language does it speak" is the thing a
 *        visitor does have an opinion about. Which of eleven English voices is
 *        not, so that collapses to a small ‹ name › cycler.
 *
 *    Both are disabled, not hidden, during a call: the geometry stays put, and
 *    the voice genuinely is immutable once a session starts, so disabling it
 *    prevents an error rather than merely discouraging one.
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

/** Output languages, in the order the row shows them. */
const LANGUAGE_TABS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
];

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

function voicesFor(code: string): Voice[] {
  return VOICES.filter((v) => v.languageCode === code);
}


function Portrait({
  persona,
  size,
  className = "",
}: {
  persona: Persona;
  size: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  // Portrait sizes are known branches only (36 picker, 84 card, 84 inline)
  // so geometry stays on the scale — never a computed px style.
  const sizeClass = size <= 36 ? "size-9 text-sm" : "size-21 text-3xl";
  if (!persona.portrait || failed) {
    return (
      <div
        className={`bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-full font-medium ${sizeClass} ${className}`}
        aria-hidden
      >
        {persona.name.charAt(0)}
      </div>
    );
  }

  return (
    <Image
      src={persona.portrait}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 rounded-full object-cover ${sizeClass} ${className}`}
      onError={() => setFailed(true)}
      priority
    />
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

  const effectiveVoiceId = mode.kind === "inline" ? config.voiceId : voiceId;
  const voice = getVoice(effectiveVoiceId);
  const langCode = voice?.languageCode ?? "en";
  const siblings = voicesFor(langCode);
  const voiceIndex = siblings.findIndex((v) => v.id === effectiveVoiceId);

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
            // Natural turn-taking: 350ms barge-in delay waits out
            // backchannels/echo; tighter VAD shortens the reply gap.
            turnDetection: { ...NATURAL_TURN_DETECTION },
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

  const pickLanguage = (code: string) => {
    const next = voicesFor(code)[0];
    if (next) setVoiceId(next.id);
  };

  const cycleVoice = (delta: number) => {
    const next =
      siblings[(voiceIndex + delta + siblings.length) % siblings.length];
    if (next) setVoiceId(next.id);
  };

  const frozen = active ? "pointer-events-none opacity-35" : "";

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
  const micHint = isDemo
    ? `Uses your microphone · ${capSeconds / 60} min max · Just talk — it speaks first.`
    : `Uses your microphone · ${capSeconds / 60} min max · Just talk — it speaks first.`;

  return (
    // Fixed height — the single reason this component can never move the page.
    // The flexing region near the bottom absorbs every state change internally.
    <div
      role="region"
      aria-label={callTitle}
      data-voice-state={state}
      className={cn(
        "bg-card flex w-full flex-col items-center rounded-2xl border p-4 text-center md:p-5",
        isDemo ? "h-120 max-w-sm" : "h-full min-h-0",
        className,
      )}
    >

      {/* The agent picker: a row of faces. Tap one and that person calls you.
          The selection is the portrait directly below, so there is nothing to
          read, nothing to learn, and no screen to come back from. */}
      {isDemo ? (
        <div
          className={`flex items-center justify-center gap-2 transition-opacity ${frozen}`}
        >
          {PERSONAS.map((p) => {
            const selected = p.id === persona.id;
            return (
              <button
                key={p.id}
                type="button"
                disabled={active}
                title={`${p.name} · ${p.vertical}`}
                aria-label={`${p.name}, ${p.vertical}`}
                aria-pressed={selected}
                onClick={() => {
                  setPersonaId(p.id);
                  // Keep the caller's chosen language across a switch; only
                  // adopt the new persona's default voice if they haven't
                  // expressed a preference this language can honour.
                  if (!voicesFor(langCode).some((v) => v.id === voiceId)) {
                    setVoiceId(p.voiceId);
                  }
                }}
                className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-card)] disabled:pointer-events-none disabled:opacity-50"
              >
                <Portrait
                  persona={p}
                  size={36}
                  className={
                    selected
                      ? "ring-primary ring-2 ring-offset-2 ring-offset-[var(--color-card)]"
                      : "opacity-50 transition-opacity hover:opacity-100"
                  }
                />
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Callcard header: title, then the lede answering "what is this".
          Inline mirrors the on-screen config including unsaved edits — say
          so, or users leave believing the test covered the deployed version.
          Demo keeps its vertical; each mode says what IT does. */}
      {presentation === "card" ? (
        <>
          <h2 className="text-base font-semibold">{callTitle}</h2>
          <p className="text-muted-foreground mt-1 text-sm leading-[1.5]">
            {isDemo
              ? persona.vertical
              : "Talks to the version on screen, including unsaved edits. No phone number involved."}
          </p>
          {versionStrip ? (
            <p className="text-foreground/75 bg-muted/50 mt-2.5 inline-flex items-center rounded-full border px-3 py-[5px] text-xs">
              {versionStrip}
            </p>
          ) : null}
        </>
      ) : null}

      {/* Identity. The role stays put under the name in every state; while
          the call is live a second line answers "what is happening right
          now" — timer plus a brand-green live dot, matching the mockup's
          stacked role + `0:42 · listening` lines. */}
      <div className="relative mt-4">
        {/* Static scoped-green ring while the call is live: identical in every
            live sub-state, so the card's geometry never shifts between
            connecting, listening and speaking. */}
        {active ? (
          <span
            aria-hidden
            className="voice-call-live-ring absolute -inset-1.5 rounded-full border-2"
          />
        ) : null}
        {isDemo ? (
          <Portrait persona={persona} size={84} className="relative" />
        ) : (
          <div
            aria-hidden
            className="bg-primary text-primary-foreground relative flex size-21 items-center justify-center rounded-full text-3xl font-semibold"
          >
            {displayName.charAt(0)}
          </div>
        )}
      </div>

      <div className="mt-2.5 text-lg font-semibold tracking-[-0.01em]">
        {displayName}
      </div>
      {/* Role line: always present, matching the mockup even mid-call. */}
      <div className="text-muted-foreground mt-0.5 text-sm tabular-nums">
        {config.identity.role}
      </div>
      {/* State line: only off-idle, answering "what is happening right now".
          text-sm semibold tabular in every state, live dot only while connected —
          the ended recap line is the same treatment minus the dot. */}
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
          {state === "connecting"
            ? "Calling…"
            : connected
              ? toolActive
                ? (filler ?? "Looking that up…")
                : (filler ??
                  `${formatCallStatus(elapsed)} · ${state === "speaking" ? "speaking" : "listening"}`)
              : quotaExceeded
                ? "Free demo time is up"
                : `Call ended · ${formatCallStatus(elapsed)}`}
        </p>
      ) : null}

      {/* Language first, then voice. Language is the choice a visitor actually
          has an opinion about; which of eleven English voices is not, so it
          collapses to a cycler that shows one name and hides the rest. */}
      {isDemo ? (
        <div
          className={`mt-3 flex flex-col items-center gap-1.5 transition-opacity ${frozen}`}
        >
          {/* One row, never wrapping: a second line would both look broken and
              change the card's height, which is what this revision exists to
              prevent. Sized so all six fit the 384px card. */}
          <div className="flex items-center justify-center gap-0.5">
            {LANGUAGE_TABS.map((lang) => (
              <button
                key={lang.code}
                type="button"
                disabled={active}
                aria-pressed={lang.code === langCode}
                onClick={() => pickLanguage(lang.code)}
                className={`cursor-pointer rounded-full px-2 py-1 text-xs whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${
                  lang.code === langCode
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                }`}
              >
                {lang.label}
              </button>
            ))}
          </div>

          <div className="text-muted-foreground flex items-center gap-0.5 text-xs">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11"
              disabled={active || siblings.length < 2}
              aria-label="Previous voice"
              onClick={() => cycleVoice(-1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="w-36 text-center">
              {voiceLabel(effectiveVoiceId)}
              {voice ? ` · ${ACCENT_LABEL[voice.accent]}` : ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11"
              disabled={active || siblings.length < 2}
              aria-label="Next voice"
              onClick={() => cycleVoice(1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {/* Primary action, shaped like the button on every phone ever made.
          LoadingButton: the pending call/hang-up shows disabled + spinner +
          pending text (call) or spinner (icon-only hang-up) rather than
          silently dropping the click. Chromeless ai-05 hosts render these in
          their own header/footer instead. */}
      {chromeless ? null : (
        <div className="mt-3.5 flex justify-center">
          {active ? (
            <LoadingButton
              pending={hangingUp}
              icon={<PhoneOff className="size-[22px]" />}
              className={`size-[52px] rounded-full p-0 ${HANGUP_RED}`}
              onClick={hangUp}
              aria-label="End test call"
            >
              {null}
            </LoadingButton>
          ) : (
            <LoadingButton
              pending={starting}
              pendingText="Calling…"
              icon={<Phone className="size-[18px]" aria-hidden />}
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

      {/* The one flexing region. Every variable-length thing lives here — the
          scenario hint, the countdown, errors, captions — so the card's outer
          height never changes and nothing on the page below it moves. On
          small screens the inline (unstuck) card grows taller so a live
          transcript shows more than ~2 bubbles; on desktop the sticky rail
          scrolls internally instead (`lg:max-h` on the aside above). */}
      <div
        className={cn(
          "mt-3 min-h-0 w-full flex-1",
          turns.length === 0 && !error && "flex items-center justify-center",
          isDemo ? "overflow-y-auto" : "overflow-hidden",
        )}
      >
        {error ? (
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
                      ? `Try again in ${retryIn}s. The test call limit resets automatically.`
                      : "You can try again now."}
                  </p>
                </>
              ) : (
                <p className={`text-xs leading-snug ${ERROR_BODY}`}>
                  {error.message}
                </p>
              )}
            </div>
          </div>
        ) : turns.length > 0 ? (
          <div className="mt-0.5 flex size-full min-h-0 flex-col text-left">
            <Chat01 turns={turns} agentName={displayName} />
            {/* Live footer under the transcript: the countdown (+ progress)
                inside the last 30s, else the speaks-first hint — the same
                content the empty state shows while connected. */}
            {connected ? (
              <div className="flex flex-col items-center gap-1.5 px-2 pt-2 text-center">
                {remaining <= 30 ? (
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
                ) : liveCaption ? (
                  <p className="text-xs italic" aria-live="polite">
                    {liveCaption.role === "user" ? "You: " : `${displayName}: `}
                    {liveCaption.text}
                  </p>
                ) : (
                  <p className="text-muted-foreground text-xs">{micHint}</p>
                )}
              </div>
            ) : null}
          </div>
        ) : state === "ended" ? (
          /* The mockup's `.recap`: a full-width, left-aligned bordered box
             sitting under the "Call ended · m:ss" line. Nothing in the session
             produces a call summary, so it carries the one thing the component
             can truthfully say about the call that just finished rather than a
             fabricated outcome. */
          <div className="w-full rounded-xl border px-3 py-2.5 text-left text-sm">
            {quotaExceeded
              ? isDemo
                ? "Sign up to keep talking past the free demo limit."
                : "The test call limit was reached — it resets automatically, so you can try again in a bit."
              : "Call again anytime within the test call limit."}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 px-2 text-center">
            {/* Idle inline shows only the mic-hint below: the lede, the
                version strip, and the hint already say "unsaved edits" three
                ways, so a fourth "Just talk" paragraph is pure repetition.
                Connected keeps it (the speaks-first transient); demo idle
                keeps its scenario line. Chromeless ai-05 hosts own the
                footer hint, so the card stays identity + transcript only. */}
            {connected ? (
              liveCaption ? (
                <p className="text-xs italic" aria-live="polite">
                  {liveCaption.role === "user" ? "You: " : `${displayName}: `}
                  {liveCaption.text}
                </p>
              ) : (
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {remaining <= 30
                    ? `${remaining}s left on this call`
                    : "Just talk — it speaks first."}
                </p>
              )
            ) : isDemo && state === "idle" ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                {persona.yourRole}
              </p>
            ) : null}
            {connected && remaining <= 30 ? (
              <Progress
                value={Math.max(0, (remaining / 30) * 100)}
                aria-label="Time left on this call"
                className="w-32"
              />
            ) : null}
            {!connected && !chromeless ? (
              <p className="text-muted-foreground text-xs">{micHint}</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
