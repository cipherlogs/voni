import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tickAllowed } from "../lib/voice/call-sounds";
import { overheardLabel, settleOverheardTurn, userCaption } from "../lib/voice/overheard-caption";

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
  // Status copy derives during render from the tested lib seam (ticket 08):
  // the component holds no string copy, the helper pins the pixels.
  assert.match(call, /getVoiceStatusText\(/, "inline status derives in render");
  assert.match(
    readRepo("lib/voice/call-status-view.ts"),
    /Looking that up…/,
    "the existing filler/status feedback remains",
  );
  assert.match(call, /tools: compileVoiceTools\(config\)/, "signed-in calls keep backend tools");
  assert.match(call, /testAgentId: inlineAgentId/, "signed-in calls keep the test agent binding");
  assert.match(
    call,
    /const inlineAgentId = mode\.kind === "inline" \? mode\.agentId : undefined/,
    "the binding narrows to the stable scalar (ticket 08)",
  );
});

test("the demo call has no client level stage: level ships in the agent body", () => {
  const call = readRepo("components/voice-call.tsx");
  assert.doesNotMatch(call, /setOutputGain\(/, "the browser never sets a playback level");
  assert.doesNotMatch(call, /voicePlaybackGain|VOICE_PLAYBACK_GAIN/, "no per-voice gain table");
  assert.doesNotMatch(call, /params\.get\("gain"\)/, "no dev gain dial");
  assert.doesNotMatch(call, /output\.volume\s*=/, "no per-call server volume retune");
  assert.match(
    readRepo("lib/voice/session.ts"),
    /volume: voiceOutputVolume\(config\.voiceId\)/,
    "the server output level is the measured registry value for the voice, not a literal",
  );
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
  assert.match(call, /userCaption\(/, "partial captions derive in the tested caption seam");
  assert.match(call, /settleOverheardTurn\(/, "the settled turn keeps the mark the partial earned");
  assert.match(call, /overheardLabel\(/, "the Overheard suffix derives in the tested caption seam");
});

test("a visitor aside while the agent speaks is marked Overheard and kept in the ledger", () => {
  // Live caption: marked only while the agent holds the floor.
  const aside = userCaption("We're a bakery, actually.", true);
  assert.deepEqual(aside, { role: "user", text: "We're a bakery, actually.", overheard: true });
  assert.equal(overheardLabel(aside), " · overheard", "the caption row says Overheard");

  const freeFloor = userCaption("What does it cost?", false);
  assert.deepEqual(freeFloor, { role: "user", text: "What does it cost?" });
  assert.equal(overheardLabel(freeFloor), "", "ordinary caller speech is never marked");

  assert.equal(userCaption("", true), null, "no empty caption is rendered");

  // Settled final: the transcript ledger keeps the mark the partial earned.
  const settled = settleOverheardTurn({ role: "user", text: "We're a bakery, actually." }, true);
  assert.equal(settled.overheard, true);
  assert.equal(overheardLabel(settled), " · overheard");

  const quiet = settleOverheardTurn({ role: "user", text: "What does it cost?" }, false);
  assert.equal(quiet.overheard, undefined);

  const agent = settleOverheardTurn({ role: "agent", text: "Noted." }, true);
  assert.equal(agent.overheard, undefined, "an agent final never inherits the visitor's mark");
});

test("the test call resolves recognition language from the agent's Locale", () => {
  // The managed inline path hands the agent's conversation language to the one
  // shared rule. A dropped argument would silently lock a Spanish agent's call
  // to English again.
  const call = readRepo("components/voice-call.tsx");
  const sites = call.match(/effectiveInlineLanguages\([\s\S]{0,160}?\)/g) ?? [];
  assert.equal(sites.length, 1, "the managed inline path resolves it");
  for (const site of sites) {
    assert.match(site, /conversationLanguage/, "the agent's Locale reaches the rule");
  }
  // The cascade path takes its languages (and prompt, tools, voice) from the
  // signed stored body, never from browser-assembled config (ticket 65).
  assert.doesNotMatch(
    call,
    /language_codes\s*:\s*effectiveInlineLanguages/,
    "the cascade config no longer assembles a language list",
  );
  assert.doesNotMatch(call, /pipeline:\s*\{[\s\S]{0,200}?fallback_mode/);
});

test("the production early return cannot short-circuit the browser E2E capture flag", () => {
  // Ticket 149's browser E2E serves a production-mode candidate. A blanket
  // `production || …` return would leave the capture off there even though
  // `deliveredCaptureRequested` allows the isolated test build; the probes
  // stay dev-only, the capture flag decides for itself.
  const call = readRepo("components/voice-call.tsx");
  const flags = call.slice(
    call.indexOf("function callDebugFlags"),
    call.indexOf("function StreamingText"),
  );
  assert.doesNotMatch(
    flags,
    /production \|\| typeof window === "undefined"/,
    "the production short-circuit hides the test-build capture",
  );
  assert.match(flags, /popProbe: !production && params\.get\("popprobe"\) === "1"/);
  assert.match(flags, /tickOff: !production && params\.get\("tick"\) === "0"/);
  assert.match(
    flags,
    /deliverCapture: deliveredCaptureRequested\(window\.location\.search, production\)/,
  );
});

test("the browser call marks are gated by the capture flag and wired to the cascade", () => {
  const call = readRepo("components/voice-call.tsx");
  const demo = call.slice(
    call.indexOf('if (modeKind === "demo") {'),
    call.indexOf("const session = new VoiceSession({"),
  );

  // The recorder exists only through the gated factory; a production build
  // without the capture flag gets `null` and writes nothing.
  assert.match(
    demo,
    /const marks = createCallMarks\(\s*window\.location\.search,\s*process\.env\.NODE_ENV === "production",\s*\)/,
    "the one capture flag decides whether marks exist",
  );
  assert.doesNotMatch(demo, /new CallMarks\(/, "no ungated recorder construction");
  assert.match(demo, /marks\?\.mark\("start_requested"\)/);
  assert.match(
    demo,
    /onMinted: \(minted\) => \{\s*marks\?\.mark\("mint_done"\);\s*const callId = callIdFromDemoToken\(minted\.demoCallToken\);\s*if \(callId !== null && marks\?\.adoptCallId\(callId\) === true\) \{\s*cascade\.setDeliveredCapture\(callDebugFlags\(\)\.deliverCapture, callId\);\s*\}\s*\}/,
    "the mint binds the WAV and marks to the trace's call id before the mic attaches",
  );
  assert.match(
    demo,
    /setDeliveredCapture\(callDebugFlags\(\)\.deliverCapture, marks\?\.callId\)/,
    "the WAV and the marks share one call id",
  );
  assert.match(
    demo,
    /new CascadeSession\(\{[\s\S]*?\}, \{\s*marks,[\s\S]*?reconnect: async \(\) => \{/,
    "the session emits the transport marks and owns the one reconnect",
  );
  assert.match(
    demo,
    /mintDemoCall\(\{[\s\S]*?resume: true,[\s\S]*?history: boundedResumeHistory\(turnsRef\.current\)/,
    "a reconnect re-mints the resume body with the carried turns",
  );
  assert.match(demo, /mark\("turn", \{ role: caption\.role, index: turnsRef\.current\.length \}\)/);
  assert.match(demo, /marks\.mark\("connected_painted"\)/);
  assert.match(demo, /marks\?\.mark\("start_failed"/);
  assert.match(call, /marksRef\.current\?\.mark\("chime"\)/, "the chime is a mark");
});

test("the contact chip has one render site, gated on the invite, the inbox and the call tag", () => {
  const call = readRepo("components/voice-call.tsx");
  assert.equal((call.match(/<DemoAddressChip\b/g) ?? []).length, 1, "one chip, never a second");
  assert.match(
    call,
    /emailTest\.invited && active && testTag \? <DemoAddressChip address=\{DEMO_INBOX_ADDRESS\} tag=\{testTag\} \/> : null/,
    "the chip shows once the invite is up, with the call's inbox and tag",
  );
  // The invite signal moved to the cascade tool path (ticket 15); this test
  // keeps the render contract, which does not change with the transport.
  assert.doesNotMatch(call, /putTestUp\(/, "the managed-only invite handler is gone");
});

test("every demo note is hidden context on the cascade, never a spoken managed line", () => {
  const call = readRepo("components/voice-call.tsx");
  const speak = call.slice(
    call.indexOf("const speak = useCallback"),
    call.indexOf("/** Page hidden right now (demo)"),
  );

  // One transport-neutral note path: the managed session keeps its floor
  // queue, the cascade gets a hidden context frame. Hidden context is applied
  // to the next generated turn and never becomes a caption or a turn.
  assert.match(speak, /if \(session instanceof VoiceSession\) \{[\s\S]*?session\.speak\(instructions, opts\);/);
  assert.match(
    speak,
    /if \(session instanceof CascadeSession\) session\.sendContext\(instructions\);/,
    "the cascade receives the note over the context frame",
  );
  assert.doesNotMatch(speak, /setTurns|setLiveCaption/, "a note never enters the transcript");

  // Every live instruction type is routed through speak() (directly, or via
  // closeCall for the time-up and hold-cap closings).
  for (const note of [
    "MUTE_CHECK_IN_INSTRUCTIONS",
    "checkEmailInstructions(result)",
    "emailArrivedInstructions(result, { fromLastCall: !test.invited })",
    "body.data.instructions",
    "rungInstructions(rung, goal)",
    "inviteNowInstructions(tag)",
  ]) {
    assert.ok(
      call.includes(`speak(${note}`) || call.includes(`speak(${note},`),
      `${note} reaches the hidden note path`,
    );
  }
  assert.match(
    call,
    /closeCall\(test\.invited && !test\.found && !test\.gated \? LATE_EMAIL_INSTRUCTIONS : TIME_UP_INSTRUCTIONS\)/,
  );
  assert.match(call, /closeCall\(HOLD_TIMEOUT_INSTRUCTIONS\)/);
  // The goodbye/close note is the closing line; the service's end_call ends
  // the call (CascadeSession drains then stops), not a browser tool relay.
  assert.match(call, /if \(markClosing\(\)\) speak\(instructions, \{ key: "close" \}\)/);
});

test("the cascade demo restores the off-track ladder and invite fallback as notes", () => {
  const call = readRepo("components/voice-call.tsx");

  // A final visitor caption is judged against the current beat, exactly like
  // the managed demo did; the rung is a hidden note for the next reply.
  assert.match(call, /requestVoiceJudge\(\s*"off-track"/);
  assert.match(call, /beatGoal\(emailTestRef\.current\)/);
  assert.match(
    call,
    /ladderRef\.current\?\.onVerdict\(\s*verdict\.decision === "off-track",?\s*\)/,
  );
  assert.match(call, /if \(rung === "end"\) closeCall\(rungInstructions\(rung, goal\)\)/);
  assert.match(call, /else speak\(rungInstructions\(rung, goal\)\)/);

  // Voni mentioned the screen without the invite: the fallback note is hidden
  // context. The chip itself is ticket 15's job.
  assert.match(call, /inviteFallbackAction\(\{/);
  assert.match(call, /speak\(inviteNowInstructions\(tag\), \{ key: "invite" \}\)/);
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
  // Shared fan-out: one native listener per family across voice + jobs.
  assert.match(call, /subscribeVisibilityChange\(onVisibility\)/);
  assert.match(call, /subscribeFreeze\(onFreeze\)/);
  assert.match(call, /subscribePageHide\(saveMemory\)/);
  assert.match(call, /from "@\/lib\/client\/shared-listeners"/);
  assert.doesNotMatch(call, /document\.addEventListener\("visibilitychange"/);
  assert.doesNotMatch(call, /document\.addEventListener\("freeze"/);
  assert.doesNotMatch(call, /window\.addEventListener\("pagehide"/);
  assert.doesNotMatch(call, /window\.addEventListener\("blur"/);
  assert.match(call, /setParkOnDrop\(shouldParkOnDrop\(true, hidden\)\)/);
  // Hold entry: the browser froze the page, or the socket dropped while hidden.
  // (Shared freeze fan-out asserted above.)
  assert.match(call, /onParked: \(\) => enterHold\(Date\.now\(\)\)/);
  // Silent entry: no hold line exists anymore (a frozen page can't speak).
  assert.doesNotMatch(call, /holdEnterInstructions|HOLD_DWELL_MS|holdTimerRef/);
  // `pagehide` saves the call memory, it never ends the call (shared fan-out).
  // Demo-gated: inline test calls never hold (kind narrows to a scalar, ticket 08).
  assert.match(call, /if \(modeKind !== "demo"\) return;/);
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
  // No welcome-back line on a return (owner, 2026-09-27); every prompted
  // line goes through the session's floor, never straight to the socket.
  assert.doesNotMatch(call, /welcomeBack|welcomedRef|ReplyQueue|replaceNextReply/);
  assert.match(call, /session\.speak\(instructions, opts\)/);
  // On-screen state: hold status, holding marker, away-ended copy. Status
  // copy lives in the tested lib seam (ticket 08); the component derives it.
  assert.match(call, /getDemoCallStatus\(/, "demo status derives in render");
  assert.match(
    readRepo("lib/voice/call-status-view.ts"),
    /On hold ·/,
    "hold status copy remains",
  );
  assert.match(call, /data-holding=\{holding\}/);
  assert.match(call, /The call ended while you were away\./);
});

test("a reload or discarded tab continues the same call from sessionStorage", () => {
  const call = readRepo("components/voice-call.tsx");
  // Restore on mount; one tap continues (audio needs a gesture on a fresh page).
  assert.match(call, /loadCallMemory\(Date\.now\(\)\)/);
  assert.match(call, /Continue call/);
  // Inside the grace: the call memory and its demo call token carry the call;
  // the cascade has no server session id to rejoin (ticket 13).
  assert.match(call, /resumeIdRef\.current = snap\.sessionId/);
  // The talk clock restarts from the saved seconds at the tap, not at mount.
  assert.match(call, /new TalkClock\(Date\.now\(\) - restoredTalkRef\.current \* 1000\)/);
  // Forgotten on hang-up and on a finished call; a fresh call clears it.
  assert.match(call, /clearCallMemory\(\)/);
});

test("a hold return reconnects visibly, silently, and speaks exactly once", () => {
  const call = readRepo("components/voice-call.tsx");
  const agents = readRepo("lib/demo/stored-agents.ts");
  const token = readRepo("lib/demo/mint.ts");

  // Pending from hold exit until audio lands: a reconnecting note shows,
  // and no error banner can paint over it in that window. One setter owns
  // the ref/state pair.
  assert.match(call, /const setReturnPending = useCallback/);
  assert.match(call, /setReturnPending\(true\)/);
  assert.match(call, /setReturnPending\(false\)/);
  // Status copy lives in the tested lib seam (ticket 08); the component
  // derives it, the helper pins the pixels.
  assert.match(
    readRepo("lib/voice/call-status-view.ts"),
    /Reconnecting…/,
    "the reconnecting note remains",
  );
  assert.match(call, /error && !returning/);
  // A hold rejoin continues the same demo call: the carried demo call token
  // and the visitor's tag ride into the fresh cascade mint (ticket 10).
  assert.match(
    call,
    /startDemoCall\(\s*cascade,\s*\{\s*voiceId,\s*resume: preserving,[\s\S]{0,120}?tagToken: loadTagToken\(\)/,
  );
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

test("a refused cascade connect is unavailable, never a managed retry", () => {
  const call = readRepo("components/voice-call.tsx");
  const handler = call.slice(
    call.indexOf("onConnectFailure: (failure)"),
    call.indexOf("onEnd: () => {"),
  );

  // The demo is the cascade's only client: every pre-accept refusal ends the
  // call with the visitor copy, and nothing decides a managed retry.
  assert.match(call, /demoUnavailableMessage/);
  assert.match(
    handler,
    /cascadeEnded = true;[\s\S]*?setError\(\{ message: demoUnavailableMessage\(failure\.code\) \}\)[\s\S]*?setCallState\("ended"\)/,
    "the refusal maps the cause and ends the call",
  );
  assert.doesNotMatch(call, /decideCascadeFallback|FALLBACK_REASONS/);
  assert.doesNotMatch(call, /requestManagedFallback/);
  assert.doesNotMatch(call, /engineOverrideRef|cascadeFellBackRef|pendingFallbackRef|fallbackStartRef/);
  assert.doesNotMatch(call, /fallbackReason/, "no visible fallback reason survives");
});

test("a cascade hold return re-mints the same call with resume and carried history", () => {
  const call = readRepo("components/voice-call.tsx");

  // Hold entry works for the cascade transport too (the demo is cascade-only).
  const enter = call.slice(
    call.indexOf("const enterHold = useCallback"),
    call.indexOf("const exitHold = useCallback"),
  );
  assert.match(
    enter,
    /if \(!\(session instanceof VoiceSession\) && !\(session instanceof CascadeSession\)\) return;/,
    "both transports hold",
  );
  assert.match(enter, /if \(session instanceof VoiceSession\) session\.setOnHold\(true\);/);
  assert.match(enter, /clockRef\.current\?\.setHeld\(true, at\)/);

  // A cascade return never reuses the old socket or token: it re-mints the
  // same call id with a greeting-less body and the carried history.
  const exit = call.slice(
    call.indexOf("const exitHold = useCallback"),
    call.indexOf("// Hold cap while away"),
  );
  assert.match(exit, /const cascade = session instanceof CascadeSession/);
  assert.match(exit, /const next: HoldReturn = cascade[\s\S]{0,160}?"rejoin"/);
  assert.match(exit, /carryoverRef\.current = buildHoldCarryover\(turnsRef\.current\)/);
  assert.match(exit, /preserveRef\.current = true/);
  assert.match(exit, /void startRef\.current\(\)/);

  const demoStart = call.slice(
    call.indexOf('if (modeKind === "demo") {'),
    call.indexOf("const session = new VoiceSession({"),
  );
  assert.match(demoStart, /resume: preserving/);
  assert.match(demoStart, /callToken: callTokenRef\.current \?\? undefined/);
  assert.match(demoStart, /history: preserving \? boundedResumeHistory\(turnsRef\.current\) : undefined/);
  assert.match(call, /import \{ boundedResumeHistory \} from "@\/lib\/voice\/resume-history"/);
});

test("the pipeline's tools leave the demo UI working without a browser tool relay", () => {
  const call = readRepo("components/voice-call.tsx");
  const cascade = call.slice(
    call.indexOf("const cascade = new CascadeSession({"),
    call.indexOf("const session = new VoiceSession({"),
  );

  // The invite chip comes from Voni's final line (the pipeline ran the tool
  // server-side); the state flips once, so a duplicate line cannot invite twice.
  assert.match(cascade, /const action = inviteFallbackAction\(\{/);
  assert.match(
    cascade,
    /if \(action !== "none"\) \{[\s\S]{0,600}?setEmailTest\(\{ \.\.\.test, invited: true \}\)/,
    "a tagged final agent turn puts the chip up",
  );
  assert.match(
    cascade,
    /if \(action === "show-and-speak" && tag\) \{?\s*speak\(inviteNowInstructions\(tag\), \{ key: "invite" \}\)/,
    "only a line without the tag gets the spoken fallback",
  );
  assert.doesNotMatch(cascade, /onToolResult/, "the cascade never waits for a browser tool result");
  assert.doesNotMatch(cascade, /putTestUp|SHOW_TEST_ADDRESS_TOOL|CHECK_CODE_TOOL|SEND_CODE_REPLY_TOOL/);

  // The two call-scoped polls survive unchanged: they are HTTP facts, not a
  // tool relay. The code readback is Voni's spoken line from the service.
  assert.match(call, /fetch\(`\/api\/demo\/tools\/\$\{CHECK_EMAIL_TOOL\}`/);
  assert.match(call, /fetch\(`\/api\/demo\/tools\/\$\{WEBSITE_POLL\}`/);
  assert.match(call, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(call, /check_code|send_code_reply|show_test_address/);
  assert.match(call, /speak\(emailArrivedInstructions\(result, \{ fromLastCall: !test\.invited \}\), \{ key: "email" \}\)/);
  assert.match(call, /speak\(body\.data\.instructions, \{ key: "website" \}\)/);
});

test("the demo start is the cascade client: one mint, no managed session", () => {
  const call = readRepo("components/voice-call.tsx");

  // The demo is the cascade's only client, so the cascade branch is demo-only
  // and the managed branch below is unreachable for `mode.kind === "demo"`.
  assert.match(call, /if \(modeKind === "demo"\) \{/, "the cascade branch is demo-only");
  assert.doesNotMatch(call, /activeEngine/);
  assert.doesNotMatch(call, /cascadeUrl/, "the mint delivers the pipeline URL");
  assert.doesNotMatch(call, /engine\?:/, "the call has no engine prop");

  // The managed session exists only in the branch after the cascade slice.
  const managedMarker = call.indexOf("const session = new VoiceSession({");
  assert.ok(managedMarker > 0, "the managed branch is still there for inline calls");
  assert.equal(
    call.slice(0, managedMarker).includes("new VoiceSession("),
    false,
    "no managed session is constructed on the demo or cascade path",
  );
  assert.match(call.slice(managedMarker), /new VoiceSession\(/);
  assert.match(call.slice(0, managedMarker), /new CascadeSession\(/);

  // The demo mints through the one door, then starts the real cascade client
  // with the minted identity. The demo call token is the tool/judge credential,
  // never the cascade connect token (that is `minted.callToken`).
  const demo = call.slice(call.indexOf('if (modeKind === "demo") {'), managedMarker);
  assert.match(demo, /await startDemoCall\(\s*cascade,/);
  assert.match(demo, /callTokenRef\.current = minted\.demoCallToken/);
  assert.doesNotMatch(demo, /minted\.callToken/, "the cascade token never replaces the demo call token");
  assert.doesNotMatch(demo, /demoToken\(/, "the managed demo mint is gone");
  assert.doesNotMatch(demo, /compileSystemPrompt|compileVoiceTools|authedToken/);
  assert.doesNotMatch(call, /\/api\/voice-token/, "the demo never asks for a managed token");

  // A refused connect is surfaced, never retried on managed; the 429 keeps its
  // countdown instead of collapsing into a generic error.
  assert.doesNotMatch(call, /alreadyFellBack/);
  assert.match(call, /e instanceof RateLimitError/);
  assert.match(call, /setRetryIn\(retryAfter/);
});

test("a post-accept managed or draining refusal never re-routes the call", () => {
  // The session owns this: only a pre-accept named refusal becomes a connect
  // failure; once accepted the frame is an ordinary call error.
  const session = readRepo("lib/voice/cascade-session.ts");
  const receive = session.slice(
    session.indexOf('case "error":'),
    session.indexOf("  /**\n   * Let the goodbye finish playing"),
  );
  assert.match(
    receive,
    /!this\.accepted &&[\s\S]{0,160}?event\.code === "draining"[\s\S]{0,160}?event\.code === "managed"[\s\S]{0,160}?event\.code === "protocol_version"/,
    "the connect failure is gated on the call not yet being accepted",
  );
  assert.match(receive, /this\.failConnect\(/);
  assert.match(receive, /this\.handlers\.onError\?\.\(event\.message\)/);
  assert.doesNotMatch(receive, /requestManagedFallback|decideCascadeFallback|retry-managed/);
});

test("the browser poll carries the call's code readback into the verified state", () => {
  const call = readRepo("components/voice-call.tsx");

  // The pipeline runs check_code server-side, so the poll's `codeVerified`
  // raises the visible verified state; Voni's spoken line is the readback.
  assert.match(call, /const next = emailTestAfterPoll\(test, body\.data\)/);
  assert.match(call, /if \(next !== test\) startPollTransition\(\(\) => setEmailTest\(next\)\)/);
  assert.match(
    call,
    /\(emailTest\.invited \|\| tagCarried \|\| emailTest\.found\) &&\s*!emailTest\.verified/,
    "the poll continues after found until the code readback is verified",
  );
  assert.doesNotMatch(call, /emailTestAfterCheck/, "one transition per response");
});

test("the demo restores the silence check-in as hidden cascade context", () => {
  const call = readRepo("components/voice-call.tsx");
  const effect = call.slice(
    call.indexOf("const floor = createDemoFloor({"),
    call.indexOf("cascadeFloorRef.current = floor"),
  );

  // The check-in is the configured note, sent through speak() (hidden context
  // on the cascade) and never appended to the transcript.
  assert.match(
    effect,
    /speak: \(instructions\) => speak\(instructions, \{ key: "silence", droppable: true \}\)/,
  );
  assert.match(
    effect,
    /settled: \(\) =>\s*!speakingRef\.current &&\s*!mutedRef\.current &&\s*!holdingRef\.current &&\s*!closingRef\.current &&\s*!returnPendingRef\.current/,
    "never over the agent, while muted, on hold, closing or waiting on a return",
  );
  assert.match(
    effect,
    /allowed: \(\) =>\s*!mutedRef\.current && !holdingRef\.current && !closingRef\.current && !returnPendingRef\.current/,
  );
  assert.match(call, /setInterval\(\(\) => floor\.tick\(\), DEMO_FLOOR_TICK_MS\)/);

  // The cascade feeds the same floor events the managed session does.
  assert.match(call, /cascadeFloorRef\.current\?\.callerWords\(\)/);
  assert.match(call, /cascadeFloorRef\.current\?\.callerSpeechStarted\(\)/);
  assert.match(call, /cascadeFloorRef\.current\?\.callerTurnDone\(\)/);
  assert.match(call, /cascadeFloorRef\.current\?\.replyStarted\(\)/);
  assert.match(call, /cascadeFloorRef\.current\?\.replyDone\(false\)/);
  assert.match(call, /cascadeFloorRef\.current\?\.replyDone\(true\)/);
  assert.doesNotMatch(call, /setTurns\([^)]*SILENCE_CHECK_IN/);
});

test("no inline cascade surface remains: the demo is the cascade's only client", () => {
  const call = readRepo("components/voice-call.tsx");
  const dialog = readRepo("components/test-agent-dialog.tsx");
  const landing = readRepo("components/landing-demo.tsx");

  assert.equal(
    existsSync(join(here, "../app/e2e/cascade/page.tsx")),
    false,
    "the hidden inline cascade page is deleted, not merely unlinked",
  );
  assert.doesNotMatch(call, /engine="cascade"|engine=\{|cascadeUrl/);
  assert.doesNotMatch(dialog, /engine=/);
  assert.match(landing, /<VoiceCall mode=\{\{ kind: "demo" \}\} \/>/);
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

// ── The turn ends on the playout's drain, not on the caption ─────────────
// Call 285138f6: the greeting's final caption completed at 460 ms over 1.76 s
// of audio and moved the call to `listening`, so the synthetic caller answered
// 1.2 s before the speech ended. The state now follows `onSpeechEnd`.

test("a final agent caption does not end the turn: the audio is still playing", () => {
  const call = readRepo("components/voice-call.tsx");
  const branch = (() => {
    const start = call.indexOf('marks?.mark("turn", { role: caption.role');
    assert.ok(start >= 0, "the final caption branch is where the turn was marked");
    const agent = call.indexOf('if (caption.role === "agent") {', start);
    const otherwise = call.indexOf("} else {", agent);
    assert.ok(agent >= 0 && otherwise > agent, "the agent final caption branch has a body");
    return call.slice(agent, otherwise);
  })();
  assert.ok(
    !branch.includes('setCallState("listening")'),
    "the caption's final flag is text completion, not the end of the reply's audio",
  );
  assert.ok(
    !branch.includes("speakingRef.current = false"),
    "the caller still hears the agent as speaking until the playout drains",
  );
  assert.ok(
    !branch.includes("replyDone("),
    "the floor is released when the audio ends, never when the transcript does",
  );
});

test("the playout's drain is the turn end: speaking -> listening and the floor", () => {
  const call = readRepo("components/voice-call.tsx");
  const start = call.indexOf("onSpeechEnd: () => {");
  assert.ok(start >= 0, "the cascade session's drain handler is wired");
  const body = call.slice(start, call.indexOf("},", start));
  assert.ok(body.includes("speakingRef.current = false"), "the drained turn stops speaking");
  assert.ok(body.includes('setCallState("listening")'), "the drained turn opens the caller's turn");
  assert.ok(body.includes("replyDone(false)"), "a finished reply releases the floor");
});

test("a barge-in still ends the turn at the cut, not at a drain that never comes", () => {
  const call = readRepo("components/voice-call.tsx");
  const start = call.indexOf("onInterrupted: () => {");
  assert.ok(start >= 0);
  const body = call.slice(start, call.indexOf("},", start));
  assert.ok(body.includes('setCallState("listening")'));
  assert.ok(body.includes("replyDone(true)"), "the cut reply is recorded as interrupted");
});
