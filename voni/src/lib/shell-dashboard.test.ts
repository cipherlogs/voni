import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Ticket 03 pin (minimalist-editorial-pass): shell + dashboard in the
// editorial language. Source-text checks mirror the ticket checkboxes with
// the frozen logic kept byte-identical: auth resolution, provider ordering,
// active-link highlight, jobs badge semantics, command + voice rows, query
// predicates, and pagination stay; only markup moves. Follows the existing
// source-text prior art (design-foundation.test.ts, landing-auth.test.ts):
// no jsdom, read the real files that ship.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

function readRepo(relative: string): string {
  return readFileSync(join(srcRoot, relative), "utf8");
}

test("shell preserves the sidebar-03 idiom with resolver, ordering, and collapse contract", () => {
  const layout = readRepo("app/(dashboard)/layout.tsx");
  // No top bar: search, voice, and jobs status live in the rail; pages own
  // their titles.
  assert.doesNotMatch(layout, /AppHeader/, "no top-bar reintroduction");
  assert.doesNotMatch(layout, /top-16/, "voice panel stays corner-anchored");
  // Provider order is load-bearing — auth first, then jobs, then voice —
  // because the sidebar reads all three.
  const authAt = layout.indexOf("<ShellAuthProvider>");
  const jobsAt = layout.indexOf("<ShellJobsProvider>");
  const copilotAt = layout.indexOf("<ShellCopilotProvider>");
  const sidebarAt = layout.indexOf("<ShellSidebar />");
  assert.ok(
    authAt !== -1 && jobsAt !== -1 && copilotAt !== -1 && sidebarAt !== -1,
    "auth, jobs, voice, and sidebar scopes all present",
  );
  assert.ok(
    authAt < jobsAt && jobsAt < copilotAt && copilotAt < sidebarAt,
    "provider order stays auth, jobs, voice, sidebar",
  );
  // Static shell: the auth resolver streams behind its own boundary so the
  // generic frame prerenders; remembered collapse restores the open bit.
  assert.match(layout, /<Suspense/, "resolver stays behind its boundary");
  assert.match(layout, /ShellAuthResolver/, "session resolver stays");
  assert.match(layout, /fallback=\{null\}/, "shell streams without a fallback");
  assert.match(layout, /SidebarStateRestore/, "remembered collapse stays");
  assert.match(layout, /defaultOpen=\{true\}/, "rail opens by default");
  assert.match(layout, /<SidebarProvider/, "sidebar provider stays");
  // App content sits on the shared document measure with macro-whitespace
  // rhythm — the same max-w-6xl as the public gutter, generous padding.
  assert.match(layout, /max-w-6xl/, "content shares the document measure");
  assert.match(layout, /gap-6/, "content keeps its section rhythm");
  assert.match(layout, /p-4 md:p-6 lg:p-8/, "content keeps generous padding");

  const frame = readRepo("components/shell-frame.tsx");
  assert.match(frame, /JobsProvider enabled=\{enabled\}/, "jobs gate stays");
  assert.match(
    frame,
    /CopilotProvider enabled=\{enabled\}/,
    "voice gate stays",
  );

  const entry = readRepo("components/app-sidebar.tsx");
  assert.match(entry, /export const NAV_ITEMS/, "shared nav source stays");
  assert.match(entry, /<Suspense/, "active-link boundary stays");
  assert.match(entry, /SidebarStateRestore/, "restore stays wired");
  assert.match(entry, /DashboardSidebarShell/, "vendored shell stays");
  // Jobs status lives solely in the utility group — the nav list filters
  // the duplicate row but keeps /jobs as the command-menu + manifest source.
  assert.match(entry, /\.filter\(/, "nav filters the jobs duplicate");

  const shell = readRepo("components/sidebar-03/app-sidebar.tsx");
  assert.match(shell, /collapsible="icon"/, "icon rail stays");
  assert.match(shell, /variant="floating"/, "floating shell stays");
  assert.match(shell, /SidebarBrandHeader/, "brand slot stays");
  assert.match(shell, /SidebarUtilityGroup/, "utility rows stay");
  assert.match(shell, /SidebarAccount/, "single-identity footer stays");
  assert.match(shell, /aria-expanded/, "collapse state stays announced");

  const utility = readRepo("components/sidebar-03/utility-rows.tsx");
  assert.match(utility, /<CommandMenu03 \/>/, "command row stays");
  assert.match(utility, /useCopilot/, "voice row stays");
  assert.match(utility, /useJobs/, "jobs row stays");
  assert.match(utility, /getJobProgressPercent/, "jobs percent stays");
  assert.match(
    utility,
    /group-data-\[collapsible=icon\]:hidden/,
    "rows collapse to icons",
  );
});

test("dashboard outcome Tiles speak the editorial Tile grammar with honest drill-down links", () => {
  const page = readRepo("app/(dashboard)/dashboard/page.tsx");
  const actions = readRepo("app/(dashboard)/dashboard/actions.ts");
  // Honest drill-down: each outcome links to its filtered list on the same
  // grain and predicate as the number it shows.
  for (const href of [
    "/leads?stage=worked",
    "/calls?outcome=connected",
    "/leads?stage=booked",
    "/leads?stage=handoff",
  ]) {
    assert.ok(page.includes(href), `outcome Tile links to ${href}`);
  }
  // Lead grain stays explicit: booked counts distinct booked leads, not
  // appointment rows; connected counts calls with their own grain hint.
  assert.match(page, /Booked leads/, "booked Tile names its lead grain");
  assert.match(page, /Counts calls, not leads/, "connected Tile names its call grain");
  assert.match(actions, /workedLeadExists/, "worked predicate stays");
  assert.match(actions, /callConnected/, "connected predicate stays");
  assert.match(actions, /liveAppointmentExists/, "booked predicate stays");
  assert.match(actions, /latestBlockersNonEmpty/, "handoff predicate stays");

  // Editorial Tile grammar (shared with the landing Tile grid): generous
  // grid rhythm that starts single-column on narrow screens, flat card
  // tokens with ring hairlines (via the Card primitive), generous card
  // padding, hover breath on the shared standard, full-height Tiles with
  // bottom-anchored drill-down footers, tight-tracking tabular numbers,
  // token-only text with no primary-color fills.
  assert.match(
    page,
    /grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4/,
    "outcome grid starts calm on narrow with generous rhythm",
  );
  assert.match(page, /h-full/, "Tiles stretch to equal height");
  assert.match(page, /p-8/, "Tiles keep generous card padding");
  assert.match(
    page,
    /duration-\[var\(--motion-standard\)\]/,
    "Tiles breathe on the shared standard",
  );
  assert.match(page, /hover:shadow-md/, "Tiles keep the quiet hover breath");
  assert.match(page, /mt-auto/, "drill-down footers anchor to the bottom");
  assert.match(page, /tracking-tight/, "display numbers stay tight-tracked");
  assert.match(page, /tabular-nums/, "display numbers stay tabular");
  assert.match(page, /text-muted-foreground/, "labels stay on the muted token");
  assert.doesNotMatch(page, /bg-primary/, "no primary-color fills on stat Tiles");
  assert.doesNotMatch(
    page,
    /gradient|neon|glass|backdrop-blur/,
    "no hype surfaces on stat Tiles",
  );
  // Frozen shell: suspense stays around the outcomes, loading reads as the
  // stat grid, errors read as the shared route card.
  assert.match(page, /<Suspense/, "outcomes stay behind their boundary");
  assert.match(page, /StatGridSkeleton/, "loading stays the stat grid");

  const card = readRepo("components/ui/card.tsx");
  assert.match(card, /bg-card/, "Tile surface stays the card token");
  assert.match(card, /ring-1/, "Tile hairline stays a ring");
  assert.match(card, /ring-foreground\/10/, "hairline stays on the foreground token");
  assert.match(card, /rounded-xl/, "Tiles stay on the standard radius");
});

test("first-run setup stays text-focused with shared step states and retargeted indent", () => {
  const onboarding = readRepo("components/onboarding-01/onboarding-01.tsx");
  const setup = readRepo("lib/dashboard/setup.ts");
  const page = readRepo("app/(dashboard)/dashboard/page.tsx");
  // First-run branch: zero outcomes render the setup path, never an empty grid.
  assert.match(page, /isFirstRun/, "page branches on first-run");
  assert.match(page, /<Onboarding01 steps=\{setupSteps\} \/>/, "setup path stays");
  // Text-focused rows: status reads from the shared StepIndicator only —
  // filled primary Check versus muted CircleDashed — with no decorative
  // per-step icons.
  assert.match(onboarding, /StepIndicator/, "status reads from one indicator");
  assert.match(onboarding, /<Check/, "completed state stays the filled check");
  assert.match(onboarding, /CircleDashed/, "open state stays the muted dash");
  assert.match(onboarding, /bg-primary/, "filled step stays on the primary token");
  assert.match(onboarding, /ChevronDown/, "rows stay expandable");
  assert.match(onboarding, /Progress/, "header progress stays");
  assert.doesNotMatch(onboarding, /STEP_ICONS|CirclePlay/, "no decorative step icons");
  assert.doesNotMatch(onboarding, /\bBot\b/, "no bot icon noise");
  assert.doesNotMatch(onboarding, /\bUpload\b/, "no upload icon noise");
  // Retargeted indent: the body sits under the indicator column, not the
  // old wide offset.
  assert.match(onboarding, /pl-12/, "body keeps the retargeted indent");
  assert.doesNotMatch(onboarding, /pl-16/, "old wide indent stays retired");
  // Prose stays constrained with muted tone.
  assert.match(onboarding, /max-w-prose/, "step copy keeps its measure");
  assert.match(onboarding, /text-muted-foreground/, "step copy keeps its tone");
  // Setup truth comes from saved workspace data with deep links to the
  // real next action.
  assert.match(setup, /"\/agents\/new"/, "agent step deep-links creation");
  assert.match(setup, /"\/campaigns\/new"/, "leads step deep-links creation");
  assert.match(setup, /#import/, "import links land on the import section");
});

test("empty campaigns surface a next action and funnel links match their lists", () => {
  const page = readRepo("app/(dashboard)/dashboard/page.tsx");
  // Empty campaigns are a next action, never a dead end.
  assert.match(page, /emptyCampaigns/, "empty campaigns stay surfaced");
  assert.match(page, /Next action/, "empty state names its action");
  assert.match(page, /has no leads yet/, "empty state states the truth");
  assert.match(page, /Import leads/, "empty state links the import");
  assert.match(page, /#import/, "import link lands on the import section");
  // One Tile language: the next-action panel shares the generous card
  // padding with the outcome and funnel grids, not a second density.
  assert.match(
    page,
    /<CardHeader className="p-8 pb-2">/,
    "next-action header shares the generous padding",
  );
  // Funnel: collapsed secondary view where each stage links to its
  // filtered leads list on the DB's own casing, named for assistive tech.
  assert.match(page, /Pipeline funnel by stage/, "funnel stays collapsed");
  assert.match(page, /<details/, "funnel stays a disclosure");
  assert.match(
    page,
    /encodeURIComponent\(stage\.stage\)/,
    "funnel href carries the DB casing",
  );
  assert.match(page, /\/leads\?stage=/, "funnel links to the leads list");
  assert.match(
    page,
    /View \${pipelineStateLabel\(stage\.stage\)} leads/,
    "funnel links name their stage",
  );
  // Funnel cards share the outcome Tile grammar, not a second language.
  assert.match(
    page,
    /grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5/,
    "funnel grid shares the generous rhythm",
  );
  assert.match(page, /CardFooter/, "funnel cards share the stat shape");
});
