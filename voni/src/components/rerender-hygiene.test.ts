import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatCallStatus } from "../lib/calls/call-status.js";
import {
  getDemoCallStatus,
  getVoiceStatusText,
} from "../lib/voice/call-status-view.js";
import { getSidebarJobsText } from "../lib/jobs/ui-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

function readRepo(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

// Ticket 08: re-render hygiene — derived values computed during render,
// transient high-frequency state held in refs/leaves, transitions + deferred
// values for non-urgent updates, no component inside a component.
//
// Seams under test:
// - Derivation seam (lib/voice/call-status-view.ts, lib/jobs/ui-helpers.ts):
//   pure status strings. Same inputs → same pixels; catches drift between
//   render and effect copies. Misses timing/interaction (existing voice-call
//   tests + runtime check cover those).
// - Structural seam (component source text, repo prior art: no jsdom):
//   ref/transition/memo placement. Catches reintroduced sync effects and
//   per-tick tree renders. Misses runtime timing (runtime check covers it).

test("call timer stays second-quantized m:ss", () => {
  assert.equal(formatCallStatus(0), "0:00");
  assert.equal(formatCallStatus(5), "0:05");
  assert.equal(formatCallStatus(65), "1:05");
  assert.equal(formatCallStatus(180), "3:00");
});

test("voice status text derives every call state", () => {
  const base = {
    elapsed: 65,
    toolActive: false,
    filler: null,
    quotaExceeded: false,
  };
  assert.equal(
    getVoiceStatusText({ ...base, state: "connecting", elapsed: 0 }),
    "Calling…",
  );
  assert.equal(
    getVoiceStatusText({ ...base, state: "listening" }),
    "1:05 · listening",
  );
  assert.equal(
    getVoiceStatusText({ ...base, state: "speaking", elapsed: 5 }),
    "0:05 · speaking",
  );
  assert.equal(
    getVoiceStatusText({ ...base, state: "listening", toolActive: true }),
    "Looking that up…",
  );
  assert.equal(
    getVoiceStatusText({
      ...base,
      state: "listening",
      toolActive: true,
      filler: "One moment…",
    }),
    "One moment…",
  );
  assert.equal(
    getVoiceStatusText({
      ...base,
      state: "speaking",
      filler: "One moment…",
    }),
    "One moment…",
  );
  assert.equal(
    getVoiceStatusText({ ...base, state: "ended", elapsed: 180, quotaExceeded: true }),
    "Free demo time is up",
  );
  assert.equal(
    getVoiceStatusText({ ...base, state: "ended" }),
    "Call ended · 1:05",
  );
  assert.equal(
    getVoiceStatusText({ ...base, state: "idle", elapsed: 0 }),
    "Call ended · 0:00",
  );
});

test("demo status text derives hold/reconnect/speaking states", () => {
  const base = {
    hasError: false,
    returning: false,
    holding: false,
    connected: false,
    reconnecting: false,
    speaking: false,
    toolActive: false,
    filler: null,
    elapsed: 65,
    statusText: "Looking that up…",
  };
  assert.equal(
    getDemoCallStatus({ ...base, hasError: true }),
    "Call didn't connect",
  );
  assert.equal(
    getDemoCallStatus({ ...base, hasError: true, returning: true }),
    "Reconnecting…",
  );
  assert.equal(
    getDemoCallStatus({ ...base, returning: true }),
    "Reconnecting…",
  );
  assert.equal(
    getDemoCallStatus({ ...base, holding: true, connected: true }),
    "On hold · 1:05",
  );
  assert.equal(
    getDemoCallStatus({ ...base, holding: true, reconnecting: true }),
    "On hold · 1:05",
  );
  assert.equal(
    getDemoCallStatus({ ...base, holding: true }),
    "Looking that up…",
  );
  assert.equal(
    getDemoCallStatus({
      ...base,
      connected: true,
      speaking: true,
      statusText: "0:05 · speaking",
    }),
    "Speaking · 1:05",
  );
  assert.equal(
    getDemoCallStatus({
      ...base,
      connected: true,
      elapsed: 5,
      statusText: "0:05 · listening",
    }),
    "Listening · 0:05",
  );
  assert.equal(
    getDemoCallStatus({ ...base, connected: true, toolActive: true }),
    "Looking that up…",
  );
  assert.equal(
    getDemoCallStatus({
      ...base,
      connected: true,
      filler: "One moment…",
      statusText: "One moment…",
    }),
    "One moment…",
  );
});

test("sidebar jobs row derives running/ready/quiet copy with labels", () => {
  assert.deepEqual(getSidebarJobsText({ activeCount: 2, unreadCount: 0 }), {
    text: "2 running",
    ariaLabel: "2 background jobs running. View jobs.",
  });
  assert.deepEqual(getSidebarJobsText({ activeCount: 1, unreadCount: 3 }), {
    text: "1 running",
    ariaLabel: "1 background jobs running. View jobs.",
  });
  assert.deepEqual(getSidebarJobsText({ activeCount: 0, unreadCount: 1 }), {
    text: "1 result ready",
    ariaLabel: "1 result ready. View jobs.",
  });
  assert.deepEqual(getSidebarJobsText({ activeCount: 0, unreadCount: 3 }), {
    text: "3 results ready",
    ariaLabel: "3 results ready. View jobs.",
  });
  assert.deepEqual(getSidebarJobsText({ activeCount: 0, unreadCount: 0 }), {
    text: "Background jobs",
    ariaLabel: "View background jobs",
  });
});

test("voice-call holds no mirrored state/ref sync effects", () => {
  const call = readRepo("components/voice-call.tsx");
  // Mirrors update in the handlers that set state (RouteError render-selection
  // precedent: never set-state-in-effect, never a lagging sync effect).
  assert.match(call, /Handler-driven mirror/, "mirror strategy is documented");
  for (const [ref, state] of [
    ["turnsRef", "turns"],
    ["stateRef", "state"],
    ["mutedRef", "muted"],
  ] as const) {
    assert.doesNotMatch(
      call,
      new RegExp(
        `useEffect\\(\\(\\) => \\{\\s+${ref}\\.current = ${state};\\s+\\}, \\[${state}\\]\\);`,
      ),
      `${ref} no longer syncs ${state} in an effect`,
    );
  }
  assert.doesNotMatch(
    call,
    /useEffect\(\(\) => \{\s+onPendingChangeRef\.current = onPendingChange;\s+\}, \[onPendingChange\]\);/,
    "pending-change ref no longer syncs in an effect",
  );
  assert.doesNotMatch(call, /onPendingChangeRef/, "pending-change mirror ref is gone");
  assert.doesNotMatch(
    call,
    /useEffect\(\(\) => \{\s+startRef\.current = start;\s+\}, \[start\]\);/,
    "start holder no longer needs a dedicated sync effect",
  );
  assert.match(
    call,
    /startRef\.current = start;/,
    "the imperative-handle creator refreshes the holder at commit",
  );
  // No whole-state mirror assignment survives outside the handlers that own
  // each value (setCallState, setMuted, start, transcript finals).
  for (const stmt of [
    "turnsRef.current = turns;",
    "stateRef.current = state;",
    "mutedRef.current = muted;",
  ]) {
    assert.ok(!call.includes(stmt), `${stmt} assigns nowhere`);
  }
});

test("voice-call derives during render and defers the non-urgent", () => {
  const call = readRepo("components/voice-call.tsx");
  assert.match(call, /getVoiceStatusText\(/, "inline status derives in render");
  assert.match(call, /getDemoCallStatus\(/, "demo status derives in render");
  assert.match(
    call,
    /from "@\/lib\/voice\/call-status-view"/,
    "derivation lives in the tested lib seam",
  );
  assert.match(call, /useDeferredValue/, "partials/meter resolve deferred");
  assert.match(
    call,
    /deferredLiveCaption/,
    "per-word partials render from the deferred value",
  );
  assert.match(
    call,
    /deferredElapsed/,
    "parent status echoes the deferred second",
  );
  assert.match(call, /useTransition/, "background discovery yields");
  assert.match(call, /startPollTransition/, "poll writes are the transition");
  assert.match(call, /memo\(/, "transcript subtree skips meter ticks");
  assert.match(call, /\[modeKind/, "effects depend on the kind string");
  assert.doesNotMatch(
    call,
    /if \(state === "ended" && \(closingRef/,
    "ended cleanup is one effect, not two",
  );
});

test("voice-call keeps the healthy render shape", () => {
  const call = readRepo("components/voice-call.tsx");
  assert.match(call, /function DemoTranscript/, "transcript stays module scope");
  assert.match(call, /function StreamingText/, "streaming text stays module scope");
  assert.match(call, /function FollowingViewport/, "viewport stays module scope");
  assert.match(call, /\{arrow\(-1\)\}/, "switcher arrows stay plain closures");
  assert.doesNotMatch(call, /<(arrow|switcher|statusLine)/, "no closure renders as a component");
});

test("sidebar meter ticks live in a leaf, never in the button", () => {
  const utility = readRepo("components/sidebar-03/utility-rows.tsx");
  assert.match(utility, /function VoiceElapsedText/, "timer is its own leaf");
  const buttonBlock = utility.slice(
    utility.indexOf("function SidebarVoiceButton"),
    utility.indexOf("function SidebarJobsRow"),
  );
  assert.doesNotMatch(buttonBlock, /setInterval/, "the button owns no interval");
  assert.doesNotMatch(
    buttonBlock,
    /setElapsed/,
    "the button owns no ticking state",
  );
  const leafBlock = utility.slice(
    utility.indexOf("function VoiceElapsedText"),
    utility.indexOf("function SidebarVoiceButton"),
  );
  assert.match(leafBlock, /setInterval/, "the leaf owns the 1s tick");
  assert.match(utility, /useDeferredValue/, "job progress resolves deferred");
  assert.match(utility, /memo\(/, "meter leaves skip provider ticks");
  assert.match(
    utility,
    /getSidebarJobsText/,
    "jobs copy derives from the tested helper",
  );
  assert.match(utility, /useCopilot/, "voice row stays");
  assert.match(utility, /useJobs/, "jobs row stays");
  assert.match(utility, /getJobProgressPercent/, "jobs percent stays");
  assert.match(utility, /markSeen/, "opening jobs settles the unread count");
  assert.match(utility, /aria-label=\{ariaLabel\}/, "label stays announced");
  assert.match(
    utility,
    /group-data-\[collapsible=icon\]:hidden/,
    "rows collapse to icons",
  );
  assert.match(utility, /formatCallStatus/, "timer reads the shared formatter");
  assert.match(utility, /Voice copilot/, "voice idle copy stays");
});

test("healthy re-render invariants stay untouched", () => {
  const numbers = readRepo("components/phone-numbers.tsx");
  assert.match(numbers, /pendingId/, "per-item pending stays");
  assert.match(numbers, /useTransition/, "list transitions stay");
  const sections = readRepo("components/settings-sections.tsx");
  assert.match(sections, /pendingId/, "per-item pending stays");
  assert.match(sections, /useTransition/, "list transitions stay");
  const bars = readRepo("components/copilot/voice-bars.tsx");
  assert.doesNotMatch(bars, /setInterval/, "voice bars stay animation-free");
});
