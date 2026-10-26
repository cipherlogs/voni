import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function readRepo(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

// Ticket 05: heavy voice + Copilot modules load on demand with shaped
// skeleton fallbacks, so first paint stays light with identical post-load
// behavior. Source-text pins (repo prior art: no jsdom, read shipped files).
//
// Seams under test (route composition boundary):
// - Landing seam (landing-demo.tsx): the Demo call engine is code-split
//   behind the demo card. Catches eager bundling of the voice stack on
//   first paint; misses runtime chunk timing (covered by build comparison).
// - Dialog seam (test-agent-dialog.tsx): the Test call engine is
//   code-split and mounts only on dialog open. Catches eager engine load
//   on the agent-edit page; misses in-call behavior (existing voice tests).
// - Shell seam (shell-frame.tsx + layout + copilot-context.tsx): the
//   Copilot engine is code-split while its context stays light and the
//   provider instance survives in-app navigation. Catches engine code
//   leaking back into the dashboard first paint; misses session liveness
//   (existing copilot/voice tests + runtime check).

test("the Demo call engine loads on demand behind the landing demo card", () => {
  const demo = readRepo("components/landing-demo.tsx");
  assert.match(demo, /next\/dynamic/, "demo card splits the voice engine");
  assert.match(demo, /mod\.VoiceCall/, "dynamic keeps the named engine export");
  assert.match(demo, /DemoCallSkeleton/, "loading reads as the demo card shape");
  assert.doesNotMatch(
    demo,
    /import \{[^}]*\bVoiceCall\b[^}]*\} from "@\/components\/voice-call"/,
    "no static engine import in the landing bundle",
  );
  assert.match(demo, /export function LandingDemo/, "demo widget export stays");
  assert.match(demo, /kind: "demo"/, "Demo call wiring stays");
  assert.match(demo, /<VoiceCall/, "post-load tree keeps the voice surface");
});

test("the Test call engine loads on demand behind the dialog open", () => {
  const dialog = readRepo("components/test-agent-dialog.tsx");
  assert.match(dialog, /next\/dynamic/, "dialog splits the voice engine");
  assert.match(dialog, /mod\.VoiceCall/, "dynamic keeps the named engine export");
  assert.match(dialog, /TestCallSkeleton/, "loading reads as the call transcript shape");
  assert.doesNotMatch(
    dialog,
    /import \{[^}]*\bVoiceCall\b[^}]*\} from "@\/components\/voice-call"/,
    "no static engine import in the agent-edit bundle",
  );
  assert.match(
    dialog,
    /import type \{[^}]*VoiceCallHandle[^}]*\} from "@\/components\/voice-call"/,
    "engine types stay type-only (erased, never bundled)",
  );
  assert.match(dialog, /voice-call-theme/, "call chrome reads constants from the light theme module");
  assert.match(dialog, /DialogTrigger/, "dialog trigger stays synchronous");
  assert.match(dialog, /canTest && open/, "engine still mounts only on dialog open");
  assert.match(dialog, /ref=\{callRef\}/, "post-load call controls keep their handle");
});

test("call chrome constants live in one light module with identical values", async () => {
  const theme = await import("./voice-call-theme.js");
  assert.equal(theme.CALL_GREEN, "voice-call-live-fill", "Demo call / Test call green stays the live fill");
  assert.equal(
    theme.HANGUP_RED,
    "bg-destructive text-white hover:bg-destructive/90",
    "hang-up stays the solid destructive fill",
  );
  assert.equal(theme.INLINE_CAP_SECONDS, 180, "Test call cap stays 180s");

  const call = readRepo("components/voice-call.tsx");
  assert.match(call, /voice-call-theme/, "engine reads the same single source");
  assert.doesNotMatch(call, /const CALL_GREEN =/, "no duplicated constant in the engine");
  assert.doesNotMatch(call, /export const INLINE_CAP_SECONDS = 180/, "no duplicated cap in the engine");
});

test("the Copilot context module carries no runtime engine", () => {
  const context = readRepo("components/copilot/copilot-context.tsx");
  assert.match(context, /export function useCopilot/, "reader hook stays");
  assert.match(
    context,
    /useCopilot must be used inside CopilotProvider\./,
    "missing-provider contract stays",
  );
  assert.match(context, /export function useCopilotRoute/, "route registration hook stays");
  assert.match(context, /export type CopilotStatus/, "status type stays on the light module");
  assert.match(context, /export type RouteToolConfig/, "route config type stays on the light module");

  // Every heavy engine import in this module must be type-only (erased at
  // build), so the dashboard first paint never parses the voice graph.
  const heavyPaths = [
    "@/lib/voice/session",
    "@/lib/voice/cascade-session",
    "@/lib/voice/jev-judges",
    "@/lib/voice/call-timings",
    "@/lib/copilot/bus",
    "@/lib/copilot/proposals",
    "@/lib/copilot/prompt",
    "@/lib/copilot/jobs-tools",
    "@/lib/copilot/voice-prefetch",
    "@/lib/copilot/record-tools",
    "@/lib/copilot/ui-tools",
    "@/lib/copilot/app-guide",
    "@/lib/copilot/voice-prefs",
  ];
  for (const line of context.split("\n")) {
    for (const heavy of heavyPaths) {
      if (line.includes(`from "${heavy}"`)) {
        assert.match(line, /^\s*import type\b/, `light context: ${heavy} stays type-only: ${line.trim()}`);
      }
    }
  }
  assert.doesNotMatch(context, /new VoiceSession/, "no session construction in the light module");
  assert.doesNotMatch(context, /new CopilotBus/, "no bus construction in the light module");
  assert.doesNotMatch(context, /new ProposalStore/, "no store construction in the light module");
});

test("dashboard readers use the light Copilot context, never the heavy provider", () => {
  for (const file of [
    "components/sidebar-03/utility-rows.tsx",
    "components/copilot/route-brief.tsx",
    "components/copilot/copilot-shell.tsx",
    "app/(dashboard)/agents/new/page.tsx",
  ]) {
    const source = readRepo(file);
    assert.match(source, /copilot-context/, `${file} reads the light context`);
    assert.doesNotMatch(
      source,
      /from "@\/components\/copilot\/copilot-provider"|from "\.\/copilot-provider"/,
      `${file} no longer pulls the engine into first paint`,
    );
  }
  const shell = readRepo("components/copilot/copilot-shell.tsx");
  assert.match(shell, /export function CopilotShell/, "Copilot shell export stays");
});

test("the Copilot provider loads on demand with the same enabled gate", () => {
  const frame = readRepo("components/shell-frame.tsx");
  assert.match(frame, /next\/dynamic/, "shell splits the Copilot engine");
  assert.match(frame, /mod\.CopilotProvider/, "dynamic keeps the named provider export");
  assert.match(frame, /CopilotBootSkeleton/, "loading reads as the shell shape");
  assert.match(frame, /CopilotProvider enabled=\{enabled\}/, "auth-only load gate stays");
  assert.match(frame, /\{children\}/, "provider still wraps the shell children");
  assert.doesNotMatch(
    frame,
    /import \{ CopilotProvider \} from "@\/components\/copilot\/copilot-provider"/,
    "no static engine import in the shell bundle",
  );

  const provider = readRepo("components/copilot/copilot-provider.tsx");
  assert.match(provider, /export function CopilotProvider/, "provider export stays for post-load");
  assert.match(provider, /enabled: boolean/, "enabled gate prop stays");
  assert.match(provider, /copilot-context/, "provider implements the shared light context");
  assert.match(provider, /stays mounted across signed-in navigation/, "single-session survival stays documented");
});

test("the Copilot shell loads on demand inside the dashboard layout", () => {
  // next/dynamic code-splitting lives in the client shell-frame (a Server
  // Component dynamic boundary gets no automatic code splitting); the
  // server layout only swaps which shell-frame export it mounts.
  const frame = readRepo("components/shell-frame.tsx");
  assert.match(frame, /mod\.CopilotShell/, "dynamic keeps the named shell export");
  assert.match(frame, /CopilotShellSkeleton/, "shell loading reads as the call pill shape");
  assert.match(frame, /export function ShellCopilotShell/, "layout mounts the on-demand shell");
  assert.match(frame, /<CopilotShell \/>/, "post-load tree keeps the shell mount");

  const layout = readRepo("app/(dashboard)/layout.tsx");
  assert.match(layout, /<ShellCopilotProvider>/, "provider scope stays above the shell");
  assert.match(layout, /<ShellCopilotShell \/>/, "layout mounts the on-demand shell");
  assert.doesNotMatch(
    layout,
    /import \{ CopilotShell \} from "@\/components\/copilot\/copilot-shell"/,
    "no static shell import in the layout bundle",
  );
});

test("every on-demand boundary ships a shaped skeleton fallback", () => {
  const skeletons = readRepo("components/page-skeletons.tsx");
  for (const name of ["DemoCallSkeleton", "TestCallSkeleton", "CopilotShellSkeleton", "CopilotBootSkeleton"]) {
    assert.match(skeletons, new RegExp(`export function ${name}`), `${name} ships with the page skeletons`);
  }
  for (const name of ["DemoCallSkeleton", "TestCallSkeleton", "CopilotShellSkeleton", "CopilotBootSkeleton"]) {
    const block = skeletons.slice(skeletons.indexOf(`export function ${name}`));
    const nextExport = block.indexOf("export function ", 1);
    const body = nextExport === -1 ? block : block.slice(0, nextExport);
    assert.match(body, /<Skeleton/, `${name} composes the Skeleton primitive`);
    assert.match(body, /aria-hidden/, `${name} stays presentational`);
  }
});
