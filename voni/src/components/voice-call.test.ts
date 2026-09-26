import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  assert.match(call, /max-h-\[36dvh\]/, "open history stays bounded");
  assert.match(call, /data-testid="landing-demo-mobile-transcript"/);
  assert.match(call, /setCaptionsOpen\(true\)/, "a new call opens captions (phones default open)");
  assert.match(call, /captionsOpen && "scale-75"/, "the hero orb shrinks instead of being squeezed out");
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

test("the demo parks on hold when the page hides and resumes on return", () => {
  const call = readRepo("components/voice-call.tsx");
  const hold = readRepo("lib/demo/hold.ts");
  const context = readRepo("lib/voice/context.ts");

  // Entry/exit ride visibilitychange only (blur fires while visible).
  assert.match(call, /document\.addEventListener\("visibilitychange"/);
  assert.match(call, /document\.removeEventListener\("visibilitychange"/);
  assert.doesNotMatch(call, /window\.addEventListener\("blur"/);
  // Demo-gated: inline test calls never hold.
  assert.match(call, /if \(mode\.kind !== "demo"\) return;/);
  // Hold pauses its own way: mic via setOnHold, clock via setHeld.
  assert.match(call, /session\.setOnHold\(true\)/);
  assert.match(call, /session\.setOnHold\(false\)/);
  assert.match(call, /clockRef\.current\?\.setHeld\(true/);
  assert.match(call, /clockRef\.current\?\.setHeld\(false/);
  // Spoken lines go through the queue, never over a reply. The hold line
  // rotates (holdEnterInstructions over HOLD_ENTER_LINES) and stays fenced
  // to its single sentence.
  assert.match(call, /holdEnterInstructions\(holdCountRef\.current\)/);
  assert.match(call, /HOLD_RETURN_INSTRUCTIONS/);
  assert.match(call, /HOLD_TIMEOUT_INSTRUCTIONS/);
  assert.match(call, /replyQueueRef\.current\?\.enqueue\(HOLD_/);
  assert.match(call, /replyQueueRef\.current\?\.enqueue\(holdEnterInstructions/);
  // The hold module owns the cap; the card enforces it off the same clock tick.
  assert.match(hold, /HOLD_CAP_S = 120/);
  assert.match(call, /holdRef\.current\?\.isExpired\(now\)/);
  // Hidden hold context, never a reply or transcript row.
  assert.match(context, /HOLD_ON_CONTEXT/);
  assert.match(context, /HOLD_OFF_CONTEXT/);
  // A post-grace restart carries the conversation, not a blank slate.
  // A resume that dies after a hold return rejoins on transport failure.
  assert.match(call, /buildHoldCarryover\(turnsRef\.current\)/);
  assert.match(call, /sessionRef\.current\.sendContext\(carryoverRef\.current\)/);
  assert.match(call, /shouldRejoinAfterHold\(greetOnListenRef\.current, e\.code\)/);
  // On-screen state: hold status, holding marker, away-ended copy.
  assert.match(call, /On hold ·/);
  assert.match(call, /data-holding=\{holding\}/);
  assert.match(call, /The call ended while you were away\./);
});

test("the hold clock union survives mute overlap", () => {
  const clock = readRepo("lib/demo/talk-clock.ts");
  assert.match(clock, /setHeld/);
  assert.match(clock, /pauseStartedAt/);
});

test("the caption tick is humanized and strikes on caption words and yield", () => {
  const call = readRepo("components/voice-call.tsx");

  assert.doesNotMatch(call, /play\("pivot"\)/, "the flat pivot file is retired");
  assert.match(call, /sounds\(\)\.tick\(1, 0\.9\)/, "the yield keeps one firm strike");
  assert.match(call, /if \(grown > 0\) sounds\(\)\.tick\(grown\)/, "new caption words strike the tick");
});
