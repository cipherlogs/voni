"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  Phone,
  PhoneOff,
  ChevronLeft,
  ChevronRight,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageHeader } from "@/components/ui/message";
import { Progress } from "@/components/ui/progress";
import {
  VoiceSession,
  authedToken,
  demoToken,
  type Transcript,
  type VoiceError,
  type VoiceState,
} from "@/lib/voice/session";
import { compileSystemPrompt } from "@/lib/agents/compile";
import type { AgentConfig } from "@/lib/agents/config";
import { compileVoiceTools } from "@/lib/tools/definitions";
import { PERSONAS, personaConfig, type Persona } from "@/lib/agents/personas";
import {
  VOICES,
  getVoice,
  voiceLabel,
  ACCENT_LABEL,
  type Voice,
} from "@/lib/agents/voices";

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
  | { kind: "inline"; config: AgentConfig; agentId?: string }
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
 * Call = green, hang up = red. Universal across every phone, softphone and
 * messaging app (Jakob's Law) — call green is also the product's brand
 * accent (`--brand`), so this is now both the expected phone-app convention
 * and the deliberate brand color, not a coincidence of two green shades.
 *
 * Hang-up is spelled out rather than using the `destructive` button variant:
 * this scaffold's `destructive` is a TINT (`bg-destructive/10` with red
 * text), not the solid red fill a hang-up button needs.
 */
const CALL_GREEN = "bg-brand text-brand-foreground hover:bg-brand/90";
const HANGUP_RED =
  "bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500";

function voicesFor(code: string): Voice[] {
  return VOICES.filter((v) => v.languageCode === code);
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
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

  if (!persona.portrait || failed) {
    return (
      <div
        className={`bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-full font-medium ${className}`}
        style={{ width: size, height: size, fontSize: size / 2.6 }}
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
      className={`shrink-0 rounded-full object-cover ${className}`}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
      priority
    />
  );
}

export function VoiceCall({ mode }: { mode: Mode }) {
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

  const sessionRef = useRef<VoiceSession | null>(null);

  const capSeconds = isDemo ? 120 : 180;
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
    setError(null);
    setRetryIn(null);
    setTurns([]);
    setElapsed(0);
    setToolActive(false);
    window.dispatchEvent(
      new CustomEvent("voni:voice-preempt", { detail: { owner: "voice-call" } }),
    );

    const session = new VoiceSession({
      onStateChange: setState,
      onTranscript: (turn) => setTurns((prev) => [...prev, turn]),
      onError: (e) => {
        setError(e);
        setRetryIn(e.retryAfterSeconds ?? null);
      },
      onToolActivity: setToolActive,
    });
    sessionRef.current = session;

    // Straight from the click handler: getUserMedia and AudioContext startup
    // are gated behind a user gesture in every major browser.
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
          languageCodes: config.languageCodes,
          tools: compileVoiceTools(config),
          testAgentId: mode.agentId,
        },
        authedToken,
      );
    }
  }, [mode, persona.id, voiceId, config]);

  const hangUp = async () => {
    await sessionRef.current?.stop();
    sessionRef.current = null;
  };

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

  return (
    // Fixed height — the single reason this component can never move the page.
    // The flexing region near the bottom absorbs every state change internally.
    <div
      className={`bg-card flex w-full max-w-sm flex-col rounded-2xl border p-5 shadow-sm ${
        isDemo ? "h-[30rem]" : "h-[22rem]"
      }`}
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

      {/* Identity. The single line under the name always answers
          "what is happening right now". */}
      <div className={`flex flex-col items-center gap-2 ${isDemo ? "mt-4" : ""}`}>
        <div className="relative">
          {state === "speaking" || state === "connecting" ? (
            <div
              className={`bg-primary/25 absolute -inset-1 rounded-full ${
                state === "speaking" ? "animate-ping" : "animate-pulse"
              }`}
              aria-hidden
            />
          ) : null}
          <Portrait persona={persona} size={84} className="relative" />
        </div>

        <div className="flex flex-col items-center gap-0.5 text-center">
          <span className="text-lg leading-tight font-semibold tracking-tight">
            {displayName}
          </span>
          <span className="text-muted-foreground text-sm tabular-nums">
            {state === "connecting"
              ? "Calling…"
              : connected
                ? toolActive
                  ? "Looking that up…"
                  : `${mmss(elapsed)} · ${state === "speaking" ? "speaking" : "listening"}`
                : state === "ended"
                  ? quotaExceeded
                    ? "Free demo time is up"
                    : `Call ended · ${mmss(elapsed)}`
                  : isDemo
                    ? persona.vertical
                    : config.identity.role}
          </span>
        </div>
      </div>

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
                className={`cursor-pointer rounded-full px-2 py-1 text-[11px] whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${
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
              className="h-6 w-6"
              disabled={active || siblings.length < 2}
              aria-label="Previous voice"
              onClick={() => cycleVoice(-1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="w-36 text-center">
              {voiceLabel(effectiveVoiceId)}
              {voice ? ` · ${ACCENT_LABEL[voice.accent]}` : ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={active || siblings.length < 2}
              aria-label="Next voice"
              onClick={() => cycleVoice(1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : null}

      {/* Primary action, shaped like the button on every phone ever made. */}
      <div className="mt-4 flex justify-center">
        {active ? (
          <Button
            className={`h-12 w-12 rounded-full p-0 ${HANGUP_RED}`}
            onClick={hangUp}
            aria-label="End call"
          >
            <PhoneOff className="h-5 w-5" />
          </Button>
        ) : (
          <Button
            className={`h-12 rounded-full px-7 ${CALL_GREEN}`}
            onClick={start}
            aria-label={`Call ${displayName}`}
          >
            <Phone aria-hidden />
            {state === "ended" ? "Call again" : `Call ${displayName}`}
          </Button>
        )}
      </div>

      {/* The one flexing region. Every variable-length thing lives here — the
          scenario hint, the countdown, errors, captions — so the card's outer
          height never changes and nothing on the page below it moves. */}
      <div
        className={`mt-3 min-h-0 flex-1 overflow-y-auto ${
          turns.length === 0 && !error ? "flex items-center justify-center" : ""
        }`}
      >
        {error ? (
          <div className="flex items-start gap-2 rounded-xl border p-2.5">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <p className="text-muted-foreground text-xs leading-snug">
                {retryIn !== null
                  ? retryIn > 0
                    ? `Too many calls right now — try again in ${retryIn}s.`
                    : "You can try again now."
                  : error.message}
              </p>
            </div>
          </div>
        ) : turns.length > 0 ? (
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport aria-label="Call transcript">
              <MessageScrollerContent className="gap-2">
                {turns.map((turn, i) => {
                  const speaker = turn.role === "user" ? "You" : displayName;
                  return (
                    <MessageScrollerItem key={`${i}-${turn.role}`}>
                      <Message align={turn.role === "user" ? "end" : "start"}>
                        <MessageHeader>{speaker}</MessageHeader>
                        <Bubble>
                          <BubbleContent>{turn.text}</BubbleContent>
                        </Bubble>
                      </Message>
                    </MessageScrollerItem>
                  );
                })}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        ) : (
          <div className="flex flex-col items-center gap-1.5 px-2 text-center">
            <p className="text-muted-foreground text-xs leading-relaxed">
              {connected
                ? remaining <= 30
                  ? `${remaining}s left on this call`
                  : "Just talk — it speaks first."
                : state === "ended"
                  ? quotaExceeded
                    ? isDemo
                      ? "Sign up to keep talking past the free demo limit."
                      : "The test call limit was reached."
                    : "Call again anytime."
                  : isDemo
                    ? persona.yourRole
                    : "Calls the version on screen, including unsaved edits."}
            </p>
            {connected && remaining <= 30 ? (
              <Progress
                value={Math.max(0, (remaining / 30) * 100)}
                aria-label="Time left on this call"
                className="w-32"
              />
            ) : null}
            {!connected && state !== "ended" && isDemo ? (
              <p className="text-muted-foreground/70 text-[11px]">
                Uses your microphone · {capSeconds / 60} min max
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
