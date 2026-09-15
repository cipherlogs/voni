import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getDashboardSetupSteps } from "@/lib/dashboard/setup";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, path), "utf8");

test("floating sidebar-03 shell centers controls and swaps brand by density and theme", () => {
  const shell = source("sidebar-03/app-sidebar.tsx");
  const entry = source("app-sidebar.tsx");
  const brand = source("sidebar-03/logo.tsx");
  // Floating icon-collapsible shell, no motion dependency.
  assert.match(shell, /variant="floating"/);
  assert.match(shell, /collapsible="icon"/);
  assert.doesNotMatch(shell, /framer-motion/);
  assert.doesNotMatch(shell, /NotificationsPopover/);
  // Four-state brand: expanded lockup vs collapsed mark, class-strategy theme swap.
  assert.match(brand, /logo-expanded-light\.svg/);
  assert.match(brand, /logo-expanded-dark\.svg/);
  assert.match(brand, /logo-collapsed-light\.svg/);
  assert.match(brand, /logo-collapsed-dark\.svg/);
  assert.match(brand, /dark:hidden/);
  assert.match(brand, /hidden dark:block/);
  assert.match(shell, /density=\{isCollapsed \? "collapsed" : "expanded"\}/);
  // Entry keeps the shared nav source, the active-link Suspense boundary,
  // and the remembered-state restore.
  assert.match(entry, /export const NAV_ITEMS/);
  assert.match(entry, /<Suspense/);
  assert.match(entry, /SidebarStateRestore/);
  assert.match(entry, /DashboardSidebarShell/);
});

test("footer is single-identity: account menu only, switcher fully removed", () => {
  const shell = source("sidebar-03/app-sidebar.tsx");
  // The workspace switcher module is deleted outright (not hidden): no file,
  // no import, no footer usage, no single-workspace copy path left behind.
  assert.equal(existsSync(join(here, "sidebar-03/team-switcher.tsx")), false);
  assert.doesNotMatch(shell, /TeamSwitcher/);
  assert.doesNotMatch(shell, /VONI_TEAMS/);
  assert.doesNotMatch(shell, /SidebarTeam/);
  assert.doesNotMatch(shell, /team-switcher/);
  // Footer keeps exactly one identity: the user-gated account menu plus the
  // unauthenticated session-note text, never a previous user's identity.
  assert.match(shell, /SidebarAccount/);
  assert.match(shell, /sessionNote/);
});

test("sidebar dropdown labels live inside their menu group", () => {
  const shell = source("sidebar-03/app-sidebar.tsx");
  const bell = source("sidebar-03/notifications-bell.tsx");
  // Base UI GroupLabel reads MenuGroupContext and throws without a Group
  // above it — every DropdownMenuLabel must sit inside a DropdownMenuGroup.
  for (const [name, src] of [["shell", shell], ["bell", bell]] as const) {
    assert.match(src, /DropdownMenuGroup/, `${name} groups its menu`);
    assert.match(src, /DropdownMenuLabel/, `${name} labels its menu`);
    const groupAt = src.indexOf("<DropdownMenuGroup");
    const labelAt = src.indexOf("<DropdownMenuLabel");
    assert.ok(groupAt !== -1 && labelAt !== -1 && groupAt < labelAt, `${name} label sits inside its group`);
  }
  assert.doesNotMatch(bell, /sampleNotifications/);
});

test("last-resort error matches the shared route error card", () => {
  const globalError = source("../app/global-error.tsx");
  // Must keep its own <html>/<body> (it replaces the root layout), speak the
  // current-generation retry callback, and read as the same system as RouteError.
  assert.match(globalError, /<html/);
  assert.match(globalError, /retry/);
  assert.doesNotMatch(globalError, /\breset\b/);
  // Unified presentation: the last-resort boundary delegates to the shared
  // route error card instead of carrying bespoke copy and button markup.
  assert.match(globalError, /RouteError/);
  assert.match(globalError, /<RouteError/);
});

test("command-menu-03 lives in the rail, with no top bar left", () => {
  const layout = source("../app/(dashboard)/layout.tsx");
  const utility = source("sidebar-03/utility-rows.tsx");
  const commandMenu = source("command-menu-03/command-menu-03.tsx");
  assert.doesNotMatch(layout, /AppHeader/);
  assert.equal(existsSync(join(here, "app-header.tsx")), false);
  assert.match(utility, /<CommandMenu03 \/>/);
  assert.doesNotMatch(utility, /ShortcutsDialog/);
  assert.match(commandMenu, /Meta\+K Control\+K \//);
  assert.match(commandMenu, /isCommandMenuEditableTarget/);
  assert.match(commandMenu, /auth\.platformAdmin/);
  assert.match(commandMenu, /NAV_ITEMS\.map/);
  for (const href of [
    "/agents/new",
    "/campaigns/new",
    "/leads?stage=worked",
    "/calls?outcome=connected",
    "/leads?stage=booked",
    "/leads?stage=handoff",
  ]) {
    assert.ok(commandMenu.includes(href), `command menu includes ${href}`);
  }
  for (const legacy of ["PENDING_G_WINDOW_MS", "focusNeighbor", "toggleBulkCheckbox"]) {
    assert.doesNotMatch(commandMenu, new RegExp(legacy));
  }
});

test("bell reads live jobs plus recent calls, never sample data", () => {
  const shell = source("sidebar-03/app-sidebar.tsx");
  const bell = source("sidebar-03/notifications-bell.tsx");
  const endpoint = source("../app/api/activity/recent/route.ts");
  assert.match(shell, /<NotificationsBell \/>/);
  assert.doesNotMatch(shell, /NotificationsPopover/);
  assert.match(bell, /useJobs/);
  assert.match(bell, /\/api\/activity\/recent/);
  assert.match(bell, /markSeen/);
  assert.match(bell, /activeJobs\.length \+ unreadJobs\.length/);
  assert.doesNotMatch(bell, /\/avatars\//);
  assert.doesNotMatch(bell, /sampleNotifications/);
  // Endpoint is org-scoped, display-safe, and gated.
  assert.match(endpoint, /getCtx/);
  assert.match(endpoint, /401/);
  assert.match(endpoint, /listCalls\(1, 5\)/);
  assert.doesNotMatch(endpoint, /phone/);
  assert.doesNotMatch(endpoint, /transcript/);
});

test("voice and jobs status relocate into the rail, panel anchors to the corner", () => {
  const utility = source("sidebar-03/utility-rows.tsx");
  const shell = source("copilot/copilot-shell.tsx");
  assert.match(utility, /useCopilot/);
  assert.match(utility, /useJobs/);
  assert.match(utility, /getJobProgressPercent/);
  assert.match(utility, /group-data-\[collapsible=icon\]:hidden/);
  assert.match(shell, /bottom-4/);
  assert.doesNotMatch(shell, /top-16/);
});

test("rail rows use the accent token at the default icon width", () => {
  const nav = source("sidebar-03/nav-main.tsx");
  const layout = source("../app/(dashboard)/layout.tsx");
  assert.doesNotMatch(nav, /sidebar-muted/);
  assert.match(nav, /bg-sidebar-accent/);
  assert.doesNotMatch(layout, /--sidebar-width-icon/);
});

test("dashboard setup steps reflect saved workspace state", () => {
  const fresh = getDashboardSetupSteps(
    {
      agentCreated: false,
      leadsImported: false,
      campaignActivated: false,
    },
    [],
  );
  assert.deepEqual(fresh.map((step) => step.completed), [false, false, false]);
  assert.equal(fresh[0]?.actionHref, "/agents/new");
  assert.equal(fresh[1]?.actionHref, "/campaigns/new");

  const waiting = getDashboardSetupSteps(
    {
      agentCreated: true,
      leadsImported: false,
      campaignActivated: false,
    },
    [{ id: "campaign-1", name: "September outreach" }],
  );
  assert.equal(waiting[1]?.title, "Import leads into September outreach");
  assert.equal(waiting[1]?.actionHref, "/campaigns/campaign-1#import");

  const complete = getDashboardSetupSteps(
    {
      agentCreated: true,
      leadsImported: true,
      campaignActivated: true,
    },
    [],
  );
  assert.ok(complete.every((step) => step.completed));
});

test("dashboard onboarding is persisted-data driven", () => {
  const page = source("../app/(dashboard)/dashboard/page.tsx");
  const actions = source("../app/(dashboard)/dashboard/actions.ts");
  const onboarding = source("onboarding-01/onboarding-01.tsx");
  assert.match(page, /<Onboarding01 steps=\{setupSteps\} \/>/);
  assert.match(actions, /isNull\(agents\.generationJobId\)/);
  assert.match(actions, /campaignLeads\.campaignId/);
  assert.match(actions, /"active", "paused", "completed"/);
  assert.match(onboarding, /<Collapsible/);
  assert.doesNotMatch(onboarding, /setCurrentSteps|setDismissed|handleStepAction/);
  // No per-step icons: status reads from the shared StepIndicator only.
  assert.doesNotMatch(onboarding, /STEP_ICONS|CirclePlay/);
  assert.doesNotMatch(onboarding, /\bBot\b/);
  assert.doesNotMatch(onboarding, /\bUpload\b/);
  assert.match(onboarding, /StepIndicator/);
  assert.match(onboarding, /CircleDashed/);
  assert.match(onboarding, /<Check/);
  assert.match(onboarding, /ChevronDown/);
  assert.match(onboarding, /Progress/);
});

test("jobs nav carries a text count badge, never icon-alone", () => {
  const entry = source("app-sidebar.tsx");
  const nav = source("sidebar-03/nav-main.tsx");
  // Badge reads the shell-level provider: active (in-flight) + unread
  // (finished, unseen) jobs on the "Background jobs" row only.
  assert.match(entry, /useJobs/);
  assert.match(entry, /activeJobs\.length \+ unreadJobs\.length/);
  assert.match(entry, /\{ jobs: String\(jobsCount\) \}/);
  // Text count, not a bare dot or icon: the digits render, the accessible
  // name carries them too, and the tooltip includes them.
  assert.match(nav, /sidebar-nav-badge/);
  assert.match(nav, /aria-label=\{badge/);
  assert.match(nav, /\$\{route\.title\} \(\$\{badge\}\)/);
  // Collapsed icon rail: the label hides but the count survives as a corner
  // pill (absolute-positioned under group-data-[collapsible=icon]).
  assert.match(nav, /sidebar-nav-label/);
  assert.match(nav, /group-data-\[collapsible=icon\]:absolute/);
});

test("agent detail is one column with a constrained-card test dialog", () => {
  const form = source("agent-config-form.tsx");
  const edit = source("../app/(dashboard)/agents/[id]/edit-agent.tsx");
  const dialog = source("test-agent-dialog.tsx");
  const chat = source("chat-01/chat-01.tsx");
  // form-layout-03 idiom: flat side-label sections use md:grid-cols-3 with
  // the field column at md:col-span-2 (Goal 2 unboxing).
  assert.match(form, /md:grid-cols-3|md:col-span-2/);
  assert.match(form, /footerPrimaryActions\?: ReactNode/);
  assert.match(edit, /max-w-3xl/);
  // Goal 1: the Agent status timeline is removed; only the deployment /
  // generation banners remain on the detail page.
  assert.doesNotMatch(edit, /Agent status/);
  assert.doesNotMatch(edit, /test-rail|lg:grid-cols-\[minmax/);
  assert.match(edit, /<TestAgentDialog/);
  // Upstream card wins: constrained ai-05 card, not fullscreen chrome.
  assert.match(dialog, /h-\[560px\].*max-w-2xl.*rounded-3xl/);
  assert.doesNotMatch(dialog, /h-dvh w-screen max-w-none/);
  assert.match(dialog, /canTest && open/);
  assert.match(dialog, /presentation="dialog"/);
  assert.match(chat, /MessageScrollerProvider/);
  assert.doesNotMatch(
    chat,
    /components\/ui\/(textarea|input-group)|<form|onSubmit=/,
  );
});
