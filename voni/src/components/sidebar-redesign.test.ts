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
  // Bell removed outright (see below): the shell account menu is the only
  // dropdown left, so only it is checked here.
  assert.match(shell, /DropdownMenuGroup/, `shell groups its menu`);
  assert.match(shell, /DropdownMenuLabel/, `shell labels its menu`);
  const groupAt = shell.indexOf("<DropdownMenuGroup");
  const labelAt = shell.indexOf("<DropdownMenuLabel");
  assert.ok(groupAt !== -1 && labelAt !== -1 && groupAt < labelAt, `shell label sits inside its group`);
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

test("notifications bell is removed outright", () => {
  const shell = source("sidebar-03/app-sidebar.tsx");
  // The bell module is deleted outright (not hidden): no file, no import,
  // no header usage.
  assert.equal(existsSync(join(here, "sidebar-03/notifications-bell.tsx")), false);
  assert.doesNotMatch(shell, /NotificationsBell/);
  assert.doesNotMatch(shell, /notifications-bell/);
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

test("jobs status lives only in the utility row, nav row removed", () => {
  const entry = source("app-sidebar.tsx");
  const utility = source("sidebar-03/utility-rows.tsx");
  // NAV_ITEMS keeps /jobs as the single source for command-menu + copilot
  // manifest; toRoutes filters it so the nav list has no duplicate row.
  assert.match(entry, /Background jobs/);
  assert.match(entry, /\.filter\(/);
  assert.match(entry, /\/jobs/);
  assert.doesNotMatch(entry, /\{ jobs: String\(jobsCount\) \}/);
  assert.doesNotMatch(entry, /activeJobs\.length \+ unreadJobs\.length/);
  // The utility row is the single jobs entry: ambient status with live
  // percent while running, results-ready text after, quiet link otherwise,
  // marking seen on open so unread does not stick without the bell.
  assert.match(utility, /useJobs/);
  assert.match(utility, /markSeen/);
  assert.match(utility, /View background jobs/);
  assert.match(utility, /getJobProgressPercent/);
  assert.match(utility, /group-data-\[collapsible=icon\]:hidden/);
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
