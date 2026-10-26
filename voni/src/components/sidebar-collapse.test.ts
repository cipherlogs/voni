import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Ticket 09 (V2): sidebar collapse is already cheap and state-preserving —
// this file is a regression guard, not a rework brief. Collapse must stay
// an uncontrolled show/hide (defaultOpen + cookie restore) that re-renders
// providers instead of remounting them, so toggling the rail never tears
// down jobs, voice, or nav state.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

function readRepo(relative: string): string {
  return readFileSync(join(srcRoot, relative), "utf8");
}

test("sidebar collapse stays uncontrolled with cookie restore", () => {
  const layout = readRepo("app/(dashboard)/layout.tsx");
  assert.ok(
    layout.includes("<SidebarProvider defaultOpen={true}>"),
    "rail opens by default through the uncontrolled prop",
  );
  assert.doesNotMatch(
    layout,
    /<SidebarProvider[^>]*\bopen=\{/,
    "layout never drives the provider as a controlled input",
  );
  assert.ok(
    layout.includes("<SidebarStateRestore />"),
    "remembered collapse restores inside the provider",
  );

  const entry = readRepo("components/app-sidebar.tsx");
  assert.ok(
    entry.includes("sidebar_state=(true|false)"),
    "restore reads the remembered open bit from the cookie",
  );
  assert.ok(
    entry.includes("setOpen(remembered)"),
    "restore applies the choice through the provider, not a remount",
  );
  assert.ok(
    entry.includes("if (done.current) return;"),
    "restore applies once instead of syncing in a loop",
  );

  const primitive = readRepo("components/ui/sidebar.tsx");
  assert.ok(
    primitive.includes("React.useState(defaultOpen)"),
    "provider state seeds from defaultOpen",
  );
  assert.ok(
    primitive.includes("${SIDEBAR_COOKIE_NAME}=${openState}"),
    "toggles persist the open bit for the next load",
  );
});

test("sidebar scope re-renders providers instead of remounting them", () => {
  const frame = readRepo("components/shell-frame.tsx");
  assert.ok(
    frame.includes("re-render — never remount —"),
    "frame documents the no-remount contract",
  );
  for (const scope of [
    "ShellJobsProvider",
    "ShellCopilotProvider",
    "ShellSidebar",
  ]) {
    assert.ok(frame.includes(scope), `${scope} stays wired in the frame`);
  }
  assert.doesNotMatch(
    frame,
    /key=\{/,
    "no key-driven remount of the provider scopes",
  );

  const layout = readRepo("app/(dashboard)/layout.tsx");
  const providers = [
    "<ShellJobsProvider>",
    "<ShellCopilotProvider>",
    "<ShellSidebar />",
  ];
  for (const marker of providers) {
    assert.ok(layout.includes(marker), `layout keeps ${marker}`);
  }
  assert.ok(
    layout.includes("collapsible=\"icon\"") ||
      readRepo("components/sidebar-03/app-sidebar.tsx").includes(
        'collapsible="icon"',
      ),
    "collapse stays an icon-rail show/hide, not an unmount",
  );
});
