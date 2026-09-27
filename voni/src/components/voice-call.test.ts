import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tickAllowed } from "../lib/voice/call-sounds";

const here = dirname(fileURLToPath(import.meta.url));

function readRepo(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

function readPackage(): string {
  return readFileSync(join(here, "..", "..", "package.json"), "utf8");
}

test("the public demo transcript has no scripted tool rows or chip model", () => {
  const call = readRepo("components/voice-call.tsx");
  const packageJson = readPackage();
  const transcriptStart = call.indexOf("function DemoTranscript");
  const transcriptEnd = call.indexOf("export type VoiceCallStatus");
  const transcript = call.slice(transcriptStart, transcriptEnd);

  assert.doesNotMatch(call, /@\/lib\/demo\/chips|DEMO_CHIPS|DemoChipRow|chipSlots|DemoChip/);
  assert.doesNotMatch(transcript, /Using a tool|toolActive|Working…/);
  assert.doesNotMatch(packageJson, /src\/lib\/demo\/chips\.test\.ts/);
  assert.match(call, /onToolActivity:/, "tool activity still reaches the call state");
  assert.match(call, /toolActive/, "tool latency state remains available to status feedback");
  assert.match(call, /Looking that up…/, "the existing filler/status feedback remains");
  assert.match(call, /tools: compileVoiceTools\(config\)/, "signed-in calls keep backend tools");
  assert.match(call, /testAgentId: mode\.agentId/, "signed-in calls keep the test agent binding");
});

test("the below-lg demo call is a controlled full-viewport modal", () => {
  const call = readRepo("components/voice-call.tsx");

  assert.match(call, /<BaseDialog\.Root\s[\s\S]*open=\{mobileOpen\}/);
  assert.match(call, /<BaseDialog\.Backdrop/);
  assert.match(call, /data-testid="landing-demo-mobile-backdrop"/);
  assert.match(call, /data-testid="landing-demo-mobile-dialog"/);
  assert.match(call, /modal\s+disablePointerDismissal/);
  assert.match(call, /details\.cancel\(\)/, "implicit dismissal is blocked");
  assert.doesNotMatch(call, /DialogContent/, "the mobile shell does not inherit shared dialog geometry");
  assert.match(call, /Backdrop[\s\S]*h-\[100dvh\][\s\S]*w-\[100dvw\]/);
  assert.match(call, /Popup[\s\S]*h-\[100dvh\][\s\S]*w-\[100dvw\]/);
  assert.match(call, /safe-area-inset-top/);
  assert.match(call, /safe-area-inset-bottom/);
  assert.match(call, /finalFocus=\{mobileTriggerRef\}/, "focus returns to Start call");
  assert.match(call, /<BaseDialog\.Title/, "the modal remains labelled");
  assert.match(call, /lg:hidden/, "the takeover is scoped below lg");
  assert.match(call, /<BaseDialog\.Close[\s\S]*>\s*Close\s*<\/BaseDialog\.Close>/);
  assert.match(call, /data-testid="landing-demo-mobile-hero"/, "the call screen has an orb hero");
  assert.match(call, /data-testid="landing-demo-mobile-caption"/, "live captions are a bounded subtitle line");
  assert.match(call, /data-testid="landing-demo-mobile-dock"/, "controls dock at the bottom");
  assert.match(call, /aria-label="Hang up"/, "hang-up is a circular icon control");
  assert.match(call, /size-16 rounded-full/, "hang-up is the prominent dock control");
  assert.match(call, /aria-label=\{muted \? "Unmute" : "Mute"\}/, "mute stays icon-only with accessible names");
  assert.match(call, /Captions/, "history hides behind a Captions toggle");
  assert.match(call, /flex min-h-0 w-full flex-1 flex-col px-1 pt-1/, "open history takes the height left, scrolling inside");
  assert.match(call, /data-testid="landing-demo-mobile-transcript"/);
  assert.match(call, /setCaptionsOpen\(true\)/, "a new call opens captions (phones default open)");
  assert.match(call, /size=\{transcriptShown \|\| addressChip \? "sm" : "lg"\}/, "the hero orb takes less room for real, never squeezed out");
  assert.match(call, /function StreamingText/, "streaming captions reveal word by word");
  assert.match(call, /stream-delay-\$\{Math\.min/, "word delays are classes, never inline styles");
  assert.match(call, /overheard/, "overlap renders marked while the agent holds the floor");
});

test("every VoiceCall path exposes mute state and hidden context without reply creation", () => {
  const call = readRepo("components/voice-call.tsx");
  const session = readRepo("lib/voice/session.ts");
  const cascade = readRepo("lib/voice/cascade-session.ts");
  const context = readRepo("lib/voice/context.ts");

  assert.match(call, /aria-pressed=\{muted\}/);
  assert.match(call, /muted \? "Unmute" : "Mute"/);
  assert.match(call, /toggleMute/);
  assert.match(call, /setInputMuted\(nextMuted\)/);
  assert.match(call, /muted: boolean/);
  assert.match(context, /type: "conversation\.message"/);
  assert.match(context, /role: "system"/);
  assert.match(session, /inputMuted/);
  assert.match(context, /type: "context"/);
  assert.match(cascade, /!this\.inputMuted/);
  const muteMethods = session.slice(
    session.indexOf("setInputMuted"),
    session.indexOf("requestReply"),
  );
  assert.doesNotMatch(muteMethods, /reply\.create/);
});

test("the desktop demo keeps the unfold card and transcript structure", () => {
  const call = readRepo("components/voice-call.tsx");
  const desktop = call.slice(
    call.indexOf("{/* A · Unfold"),
    call.indexOf("{/* B · Rise"),
  );

  assert.match(desktop, /hidden lg:block/);
  assert.match(desktop, /open \? "w-220" : "w-90"/);
  assert.match(desktop, /LIVE TRANSCRIPT/);
  assert.match(desktop, /<LandingOrb state=\{orbState\} \/>/, "the portrait orb tints by call state");
});

test("hidden stays live; hold starts only on freeze or a hidden drop", () => {
  const call = readRepo("components/voice-call.tsx");
  const hold = readRepo("lib/demo/hold.ts");
  const context = readRepo("lib/voice/context.ts");

  // Visibility only arms parking and saves the call memory; never blur.
  assert.match(call, /document\.addEventListener\("visibilitychange"/);
  assert.match(call, /document\.removeEventListener\("visibilitychange"/);
  assert.doesNotMatch(call, /window\.addEventListener\("blur"/);
  assert.match(call, /setParkOnDrop\(shouldParkOnDrop\(true, hidden\)\)/);
  // Hold entry: the browser froze the page, or the socket dropped while hidden.
  assert.match(call, /document\.addEventListener\("freeze", onFreeze\)/);
  assert.match(call, /onParked: \(\) => enterHold\(Date\.now\(\)\)/);
  // Silent entry: no hold line exists anymore (a frozen page can't speak).
  assert.doesNotMatch(call, /holdEnterInstructions|HOLD_DWELL_MS|holdTimerRef/);
  // `pagehide` saves the call memory, it never ends the call.
  assert.match(call, /window\.addEventListener\("pagehide", saveMemory\)/);
  // Demo-gated: inline test calls never hold.
  assert.match(call, /if \(mode\.kind !== "demo"\) return;/);
  // Hold pauses its own way: mic via setOnHold, clock via setHeld.
  assert.match(call, /session\.setOnHold\(true\)/);
  assert.match(call, /voice\?\.setOnHold\(false\)/);
  assert.match(call, /clockRef\.current\?\.setHeld\(true, at\)/);
  assert.match(call, /clockRef\.current\?\.setHeld\(false, now\)/);
  // The return path is the pure decision (table-tested in hold.test.ts).
  assert.match(call, /decideHoldReturn\(\{/);
  assert.match(call, /void voice\?\.wake\(\)/);
  assert.match(call, /if \(next === "resume"\) void voice\?\.resume\(\)/);
  // The cap fires even while away (a hidden, parked page).
  assert.match(hold, /HOLD_CAP_S = 120/);
  assert.match(call, /setTimeout\(exitHold, HOLD_CAP_S \* 1000/);
  assert.match(call, /HOLD_TIMEOUT_INSTRUCTIONS/);
  // Hidden hold context, never a reply or transcript row.
  assert.match(context, /HOLD_ON_CONTEXT/);
  assert.match(context, /HOLD_OFF_CONTEXT/);
  // Past the grace, a fresh session gets the call memory.
  assert.match(call, /buildHoldCarryover\(turnsRef\.current\)/);
  assert.match(call, /sessionRef\.current\.sendContext\(carryoverRef\.current\)/);
  assert.match(call, /shouldRejoinAfterHold\(/);
  // A restart never inherits the old transport, and waits for its fade.
  assert.match(call, /const previous = sessionRef\.current;/);
  assert.match(call, /sessionRef\.current = null;/);
  assert.match(call, /await previous\.stop\(\)/);
  // One welcome per return; a line refused between sockets retries on live.
  assert.match(call, /welcomedRef\.current = false/);
  assert.match(call, /const welcomeBackOnce = useCallback/);
  assert.match(call, /if \(welcomedRef\.current\) return;/);
  assert.match(call, /replyQueueRef\.current\?\.retry\(\)/);
  // On-screen state: hold status, holding marker, away-ended copy.
  assert.match(call, /On hold ·/);
  assert.match(call, /data-holding=\{holding\}/);
  assert.match(call, /The call ended while you were away\./);
});

test("a reload or discarded tab continues the same call from sessionStorage", () => {
  const call = readRepo("components/voice-call.tsx");
  // Restore on mount; one tap continues (audio needs a gesture on a fresh page).
  assert.match(call, /loadCallMemory\(Date\.now\(\)\)/);
  assert.match(call, /Continue call/);
  // Inside the grace: the same server session; otherwise the call memory.
  assert.match(call, /resumeIdRef\.current = snap\.sessionId/);
  assert.match(call, /\{ resumeSessionId \}/);
  // The talk clock restarts from the saved seconds at the tap, not at mount.
  assert.match(call, /new TalkClock\(Date\.now\(\) - restoredTalkRef\.current \* 1000\)/);
  // Forgotten on hang-up and on a finished call; a fresh call clears it.
  assert.match(call, /clearCallMemory\(\)/);
});

test("a hold return reconnects visibly, silently, and speaks exactly once", () => {
  const call = readRepo("components/voice-call.tsx");
  const agents = readRepo("lib/demo/stored-agents.ts");
  const token = readRepo("app/api/demo/token/route.ts");

  // Pending from hold exit until audio lands: a reconnecting note shows,
  // and no error banner can paint over it in that window. One setter owns
  // the ref/state pair.
  assert.match(call, /const setReturnPending = useCallback/);
  assert.match(call, /setReturnPending\(true\)/);
  assert.match(call, /setReturnPending\(false\)/);
  assert.match(call, /Reconnecting…/);
  assert.match(call, /error && !returning/);
  // A hold rejoin binds the greeting-less resume agent variant, so the
  // welcome-back is the single first utterance — never a re-introduction
  // stacked on one.
  assert.match(call, /demoToken\(voiceId, \{\s*resume: preserving,\s*callToken: callTokenRef\.current \?\? undefined,/);
  assert.match(agents, /demoAgentStorageKey/);
  assert.match(agents, /resume \? `\$\{voiceId\}:resume` : voiceId/);
  assert.match(token, /body\.resume === true/);
  // A preserving restart that also dies rejoins once more (single-retry
  // guard): the memory (turns + carryover) survives to the second attempt
  // instead of painting an error like a new call.
  assert.match(call, /greetOnListenRef\.current \|\| returnPendingRef\.current,\s*e\.code,\s*rejoiningRef\.current/);
  assert.match(call, /rejoiningRef\.current = true/);
  assert.match(call, /rejoiningRef\.current = false/);
});

test("the hold clock union survives mute overlap", () => {
  const clock = readRepo("lib/demo/talk-clock.ts");
  assert.match(clock, /setHeld/);
  assert.match(clock, /pauseStartedAt/);
});

test("the caption tick strikes only on the visitor's words, never over the agent", () => {
  const call = readRepo("components/voice-call.tsx");

  assert.doesNotMatch(call, /play\("pivot"\)/, "the flat pivot file is retired");
  assert.match(call, /tickAllowed\("user", false, sessionRef\.current\)\) sounds\(\)\.tick\(1, 0\.9\)/);
  assert.match(call, /tickAllowed\(liveCaption\.role, speakingRef\.current, sessionRef\.current\)/);
});

test("tickAllowed: visitor words into silence only", () => {
  const settled = { playbackSettled: () => true };
  const draining = { playbackSettled: () => false };
  assert.equal(tickAllowed("user", false, settled), true, "visitor speaks into silence");
  assert.equal(tickAllowed("agent", false, settled), false, "agent captions never tick");
  assert.equal(tickAllowed("user", true, settled), false, "agent is speaking");
  assert.equal(tickAllowed("user", false, draining), false, "agent tail still draining");
  assert.equal(tickAllowed("user", false, null), true, "no session (cascade idle)");
  assert.equal(tickAllowed("user", false, {}), true, "cascade has no playout probe");
});
