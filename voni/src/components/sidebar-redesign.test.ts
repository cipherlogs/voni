import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getDashboardSetupSteps } from "@/lib/dashboard/setup";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, path), "utf8");

test("collapsed sidebar centers controls and expanded desktop uses the wordmark", () => {
  const sidebar = source("app-sidebar.tsx");
  assert.match(sidebar, /state === "expanded"/);
  assert.match(sidebar, /<VoniLogo size="lg" wordmark/);
  assert.match(sidebar, /group-data-\[collapsible=icon\]:gap-0!/);
  assert.match(sidebar, /group-data-\[collapsible=icon\]:justify-center/);
  assert.match(sidebar, /group-data-\[collapsible=icon\]:size-10!/);
});

test("command-menu-03 is the only global shortcut surface", () => {
  const header = source("app-header.tsx");
  const commandMenu = source("command-menu-03/command-menu-03.tsx");
  assert.match(header, /<CommandMenu03 \/>/);
  assert.doesNotMatch(header, /ShortcutsDialog/);
  assert.equal(existsSync(join(here, "shortcuts-dialog.tsx")), false);
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
});

test("agent detail is one column with a full-screen idle test dialog", () => {
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
  assert.match(dialog, /h-dvh w-screen max-w-none/);
  assert.match(dialog, /canTest && open/);
  assert.match(dialog, /presentation="dialog"/);
  assert.match(chat, /MessageScrollerProvider/);
  assert.doesNotMatch(
    chat,
    /components\/ui\/(textarea|input-group)|<form|onSubmit=/,
  );
});
