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
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message } from "@/components/ui/message";
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
import { formatCallStatus } from "@/lib/calls/call-status";
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
 * Call = green, hang up = red. Universal across every phone, softphone and
 * messaging app (Jakob's Law) — call green is also the product's brand
 * accent (`--brand`), so this is now both the expected phone-app convention
 * and the deliberate brand color, not a coincidence of two green shades.
 *
 * Hang-up is spelled out rather than using the `destructive` button variant:
 * this scaffold's `destructive` is a TINT (`bg-destructive/10` with red
 * text), not the solid red fill a hang-up button needs. The solid fill still
 * comes from the `destructive` token (both themes) with white text — no raw
 * red shade and no manual dark: overrides.
 *
 * Contrast note (matches --brand in globals.css): brand green clears 3:1
 * non-text only, never 4.5:1 body text — so these constants stay fill-only
 * (white text on green) and the hover deepens toward green-700 via
 * color-mix for pressed-state headroom.
 */
const CALL_GREEN =
  "bg-brand text-brand-foreground hover:bg-[color-mix(in_oklch,var(--brand),black_18%)]";
const HANGUP_RED = "bg-destructive text-white hover:bg-destructive/90";


/**
 * The error body copy sits a long way darker than `--destructive` itself —
 * red-900 against the red-600 border and the red-50 tint. Mixing toward
 * `--foreground` reaches it in light mode AND inverts correctly in dark, which
 * a literal `#7f1d1d` would not.
 */
const ERROR_BODY =
  "text-[color-mix(in_oklch,var(--destructive),var(--foreground)_45%)]";

/**
 * The portrait's live ring (a soft 1.04 bloom that fades out, NOT
 * `animate-ping`'s scale-2 blast) — a keyframe Tailwind does not ship. The
 * live dot reuses the global `voni-livedot` in globals.css. Hoisted and
 * de-duplicated by React, so both modes rendering the card at once still emit
 * one copy.
 */
const CALL_KEYFRAMES = `
@keyframes voni-callring {
  0% { transform: scale(.96); opacity: .5; }
  70% { transform: scale(1.04); opacity: .15; }
  100% { transform: scale(1.04); opacity: 0; }
}
`;

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
      className={`bg-card flex w-full flex-col items-center rounded-[16px] border p-5 text-center ${
        isDemo ? "h-[30rem] max-w-sm" : ""
      }`}
    >
      <style href="voni-call-keyframes" precedence="medium">
        {CALL_KEYFRAMES}
      </style>

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
      <h2 className="text-base font-semibold">{callTitle}</h2>
      <p className="text-muted-foreground mt-1 text-[13px] leading-[1.5]">
        {isDemo
          ? persona.vertical
          : "Talks to the version on screen, including unsaved edits. No phone number involved."}
      </p>
      {versionStrip ? (
        <p className="text-foreground/75 bg-muted/50 mt-2.5 inline-flex items-center rounded-full border px-3 py-[5px] text-xs">
          {versionStrip}
        </p>
      ) : null}

      {/* Identity. The role stays put under the name in every state; while
          the call is live a second line answers "what is happening right
          now" — timer plus a brand-green live dot, matching the mockup's
          stacked role + `0:42 · listening` lines. */}
      <div className="relative mt-4">
        {/* 2px brand-green ring while the call is live: one bloom that fades
            out and restarts, identical in every live sub-state, so the card's
            geometry never shifts between connecting, listening and speaking. */}
        {active ? (
          <span
            aria-hidden
            className="border-brand absolute -inset-1.5 animate-[voni-callring_1.8s_ease-out_infinite] rounded-full border-2 opacity-45 motion-reduce:animate-none"
          />
        ) : null}
        {isDemo ? (
          <Portrait persona={persona} size={84} className="relative" />
        ) : (
          <div
            aria-hidden
            className="bg-primary text-primary-foreground relative flex items-center justify-center rounded-full font-semibold"
            style={{ width: 84, height: 84, fontSize: 34 }}
          >
            {displayName.charAt(0)}
          </div>
        )}
      </div>

      <div className="mt-2.5 text-lg font-semibold tracking-[-0.01em]">
        {displayName}
      </div>
      {/* Role line: always present, matching the mockup even mid-call. */}
      <div className="text-muted-foreground mt-0.5 text-[13px] tabular-nums">
        {config.identity.role}
      </div>
      {/* State line: only off-idle, answering "what is happening right now".
          13px semibold tabular in every state, live dot only while connected —
          the ended recap line is the same treatment minus the dot. */}
      {state !== "idle" ? (
        <p
          className="mt-2 inline-flex items-center gap-2 text-[13px] font-semibold tabular-nums"
          role="status"
        >
          {connected ? (
            <span
              aria-hidden
              className="bg-brand inline-block size-2 shrink-0 animate-[voni-livedot_1.6s_ease-in-out_infinite] rounded-full motion-reduce:animate-none"
            />
          ) : null}
          {state === "connecting"
            ? "Calling…"
            : connected
              ? toolActive
                ? "Looking that up…"
                : `${formatCallStatus(elapsed)} · ${state === "speaking" ? "speaking" : "listening"}`
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

      {/* Primary action, shaped like the button on every phone ever made. */}
      <div className="mt-3.5 flex justify-center">
        {active ? (
          <Button
            className={`size-[52px] rounded-full p-0 ${HANGUP_RED}`}
            onClick={hangUp}
            aria-label="End test call"
          >
            <PhoneOff className="size-[22px]" />
          </Button>
        ) : (
          <Button
            className={`h-11 gap-2 rounded-full px-7 text-sm font-semibold ${CALL_GREEN}`}
            onClick={start}
            aria-label={`Call ${displayName}`}
          >
            <Phone className="size-[18px]" aria-hidden />
            {state === "ended" ? "Call again" : `Call ${displayName}`}
          </Button>
        )}
      </div>

      {/* The one flexing region. Every variable-length thing lives here — the
          scenario hint, the countdown, errors, captions — so the card's outer
          height never changes and nothing on the page below it moves. On
          small screens the inline (unstuck) card grows taller so a live
          transcript shows more than ~2 bubbles; on desktop the sticky rail
          scrolls internally instead (`lg:max-h` on the aside above). */}
      <div
        className={`mt-3 min-h-0 w-full flex-1 overflow-y-auto ${
          turns.length === 0 && !error ? "flex items-center justify-center" : ""
        } ${!isDemo ? "min-h-[16rem] lg:min-h-0" : ""}`}
      >
        {error ? (
          <div
            role="alert"
            className="border-destructive/25 bg-destructive/5 flex w-full gap-2.5 rounded-[12px] border px-3 py-2.5 text-left"
          >
            <TriangleAlert className="text-destructive mt-px size-4 shrink-0" />
            <div>
              {retryIn !== null ? (
                <>
                  <strong className="block text-[13px] font-semibold">
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
          <div className="mt-0.5 flex w-full flex-col text-left">
            {/* Transcript AND the live footer together — the mockup shows
                bubbles with the mic hint beneath them mid-call, so the footer
                no longer hides once captions appear. */}
            <MessageScrollerProvider autoScroll defaultScrollPosition="end">
              <MessageScroller className="min-h-0 flex-1">
                <MessageScrollerViewport
                  aria-label="Call transcript"
                  aria-live="polite"
                >
                  <MessageScrollerContent className="gap-2">
                    {turns.map((turn, i) => {
                      const speaker = turn.role === "user" ? "You" : displayName;
                      const isUser = turn.role === "user";
                      return (
                        <MessageScrollerItem key={`${i}-${turn.role}`}>
                          <Message align={isUser ? "end" : "start"}>
                            {/* Mockup bubbles are full-bleed rows inset from
                                one side, not shrink-to-fit chat balloons: the
                                agent sits on the muted surface offset 24px
                                right, you on the card surface offset 24px
                                left, and the speaker label lives INSIDE the
                                bubble. Variants stay tokens only. */}
                            <Bubble
                              align={isUser ? "end" : "start"}
                              variant={isUser ? "outline" : "muted"}
                              className={`w-full max-w-none ${isUser ? "ml-6" : "mr-6"}`}
                            >
                              <BubbleContent className="border-border w-full max-w-full rounded-[12px] py-2 text-[13px] leading-[1.5]">
                                <span className="text-muted-foreground mb-0.5 block text-[11px] font-bold">
                                  {speaker}
                                </span>
                                {turn.text}
                              </BubbleContent>
                            </Bubble>
                          </Message>
                        </MessageScrollerItem>
                      );
                    })}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
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
          <div className="w-full rounded-[12px] border px-3 py-2.5 text-left text-[13px]">
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
                keeps its scenario line. */}
            {connected ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                {remaining <= 30
                  ? `${remaining}s left on this call`
                  : "Just talk — it speaks first."}
              </p>
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
            {!connected ? (
              <p className="text-muted-foreground text-xs">{micHint}</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
