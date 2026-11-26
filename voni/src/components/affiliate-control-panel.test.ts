import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  readCardOpen,
  writeCardOpen,
  type CardDisclosureStorage,
} from "@/components/card-disclosure";

/**
 * Source-text guards for the one wiring that has no other witness.
 *
 * `lockPage` shipped with no caller once already: the function dropped both
 * cookies correctly and nothing in the UI invoked it, so the protection existed
 * for a code path nobody could reach. There is no runtime test for a client
 * component's click handler in this repo, so this asserts the wiring — the
 * import, the call, and the redirect-tolerant rejection handling — the way
 * `src/app/email/page.gate.test.ts` asserts the gate's shape.
 */

const panel = readFileSync(
  new URL("./affiliate-control-panel.tsx", import.meta.url),
  "utf8",
);

test("the panel imports lockPage from the actions module", () => {
  assert.match(panel, /lockPage,/);
  assert.match(panel, /from "@\/app\/email\/actions"/);
});

test("a Lock page control calls lockPage and is the only way out", () => {
  assert.match(panel, /await lockPage\(\);/);
  assert.match(panel, /data-testid="email-lock-page"/);

  // One lock, one control: the page cookie is the write grant, so there is no
  // second "lock panel" button and no second cookie to clear.
  assert.equal(
    panel.split("<LockPageButton />").length - 1,
    1,
    "rendered once, in the controls the unlocked page shows",
  );
  assert.doesNotMatch(panel, /Lock panel/);
});

test("the panel has no second password form", () => {
  // The control secret and its unlock form are gone: the page password is the
  // only authorization, so a secret field here would be a lock nothing checks.
  assert.doesNotMatch(panel, /name="secret"/);
  assert.doesNotMatch(panel, /Control secret/);
  assert.doesNotMatch(panel, /unlockControl|lockControl/);
});

test("the redirect rejection is swallowed, not reported as a failed lock", () => {
  assert.match(
    panel,
    /void handleLockPage\(\)\.catch\(\(\) => \{\}\);/,
    "lockPage redirects, and that rejection is the navigation",
  );
});

test("the click table shows the User-Agent it already stores", () => {
  // Every row has a UA in Postgres and in the query, but the table only offered
  // it as a tooltip on the Device cell, so the panel read as "no UA recorded"
  // while 7,317 rows carried one. A stored value with no column is invisible.
  assert.match(panel, /<th[^>]*>User-Agent<\/th>/);
  assert.match(panel, /\{click\.userAgent \?\? "—"\}/);
});

test("the Grafana card no longer chooses the rotation mode", () => {
  // The mode moved to the page-level `RotationCard` because every producer
  // reads it. Keeping a switch here would be a second control for one setting,
  // and the two Sources could then disagree about how a click picks a target.
  assert.doesNotMatch(panel, /name="selection"/);
  assert.doesNotMatch(panel, /email-control-selection/);
  assert.doesNotMatch(panel, /import \{ Switch \}/);
});

test("the one-off note describes the mode the console resolved", () => {
  // `targetSelection` is now the page's answer (setting first, script second),
  // not the script's marker, so the note and the click cannot disagree.
  assert.match(panel, /targetSelection: TargetSelection;/);
});

test("the one-off click ticks enabled targets and names their hosts", () => {
  assert.match(
    panel,
    /oneOffTargets: OneOffTargetView\[\];/,
    "the panel receives the enabled rows from the page",
  );
  assert.match(panel, /oneOffTargets=\{oneOffTargets\}/);
  assert.match(panel, /name="target"/);
  assert.match(panel, /value=\{target\.id\}/);
  assert.match(panel, /import \{ targetHost \} from "@\/lib\/email\/target-url";/);
  assert.match(panel, /targetHost\(target\.url\)/);
  // Default all ticked: `oneOffSelected` starts as the whole enabled list.
  assert.match(panel, /oneOffTargets\.map\(\(target\) => target\.id\)/);
  assert.match(
    panel,
    /disabled=\{clicking\}/,
    "ticking is disabled while the click is in flight, like the probe rows",
  );
});

test("an empty picker disables the click with an immediate reason", () => {
  assert.match(
    panel,
    /const tickedCount = oneOffTargets\.filter\(\(target\) =>\s*oneOffSelected\.includes\(target\.id\),?\s*\)\.length;/,
  );
  assert.match(panel, /const oneOffReady = !hasOneOffTargets \|\| tickedCount > 0;/);
  assert.match(panel, /disabled=\{!oneOffReady\}/);
  assert.match(panel, /Select at least one target for this click\./);
  // Order matters: the picker sits above the button it gates, so the reason
  // for the disabled state is visible before the control that reports it.
  assert.ok(
    panel.indexOf('name="target"') <
      panel.indexOf('data-testid="email-one-off-click"'),
    "the target picker is rendered above the submit button",
  );
});

test("no picker is rendered when every target is paused", () => {
  // The server already refuses with "Every target is paused…"; an empty
  // fieldset would only restate that and leave the button disabled for a
  // reason the operator cannot act on from here.
  assert.match(panel, /\{hasOneOffTargets \? \(/);
  assert.match(panel, /const hasOneOffTargets = oneOffTargets\.length > 0;/);
});

test("the Grafana interval Select shows its label closed, never the raw minutes", () => {
  assert.match(panel, /items=\{FREQUENCY_ITEMS\}/);
  assert.match(
    panel,
    /const FREQUENCY_ITEMS: Record<string, string> = Object\.fromEntries/,
    "one map for the closed trigger",
  );
  assert.match(panel, /Every \$\{minutes\} min/);
  assert.match(
    panel,
    /\{FREQUENCY_ITEMS\[String\(minutes\)\]\}/,
    "the open options render the same map the trigger reads",
  );
});

test("the shared click table filters by link chips, not client state", () => {
  // The chosen surface for the source filter is links carrying the value in the
  // URL: no Tabs primitive, no client state to lose on reload, and the value is
  // resolved server-side so a copied URL opens the same narrowed table.
  assert.match(panel, /import Link from "next\/link";/);
  assert.match(
    panel,
    /render=\{<Link href=\{chip\.href\} \/>\}/,
    "each chip is a real anchor, so it can be copied and opened",
  );
  assert.match(panel, /data-testid=\{`email-clicks-source-\$\{chip\.value\}`\}/);
  assert.match(panel, /aria-current=\{chip\.active \? "page" : undefined\}/);
  assert.doesNotMatch(panel, /from "@\/components\/ui\/tabs"/);
  assert.doesNotMatch(panel, /<Tabs/);
});

test("the Grafana card prints its own 24-hour numbers when expanded", () => {
  assert.match(panel, /<SourceStatsSection stats=\{stats\} \/>/);
  assert.match(panel, /data-testid="email-control-grafana-stats"/);
  // Both surfaces read the same block, so the card and the table cannot show
  // two different visual languages for the same counts.
  assert.equal(
    panel.split("<StatsBlock stats={stats} />").length - 1,
    2,
    "the card's inline stats and the shared table share one block",
  );
});

test("save, toggle and one-off results are toasts only", () => {
  assert.match(
    panel,
    /useActionToast\(saveState, "Could not save the volume", \{\s*successTitle: "Volume saved"/,
  );
  assert.match(
    panel,
    /useActionToast\(toggleState, "Could not update the check", \{\s*successTitle: "Check updated"/,
  );
  assert.match(
    panel,
    /useActionToast\(clickState, "Could not run the click", \{\s*successTitle: "Click ran"/,
  );
  assert.doesNotMatch(panel, /<FeedbackAlert/, "no duplicate inline surface");
});

test("the rotate note follows the mode the console resolved", () => {
  // The page resolves the mode once (setting, else the script's marker) and
  // passes it to this card, so the note cannot describe a mode the click will
  // not use.
  assert.match(panel, /const savedSelection: TargetSelection =/);
  assert.match(
    panel,
    /savedSelection === "rotate"/,
    "the one-off click resolves the same value server-side, so the copy must match it",
  );
  assert.match(
    panel,
    /the least recently clicked of\s+the ticked targets/,
  );
});

class MemoryStorage implements CardDisclosureStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/** The shared click surface, and only it: the source card has its own guards. */
function clickSurface(): string {
  const start = panel.indexOf("export function ClickSurface");
  const end = panel.indexOf("function ControlsSection");
  assert.ok(start > 0 && end > start, "ClickSurface is a top-level export");
  return panel.slice(start, end);
}

test("the clicks card folds like every other card, closed until opened", () => {
  const surface = clickSurface();

  // The fold memory is the shared hook, keyed by the card's own test id, so it
  // restores after a reload and never opens a different card.
  assert.match(surface, /useCardDisclosure\("email-control-analytics"\)/);
  assert.match(surface, /className="group\/card grid gap-\(--card-spacing\)"/);
  assert.match(
    surface,
    /<CollapsibleCardTitle[\s\S]*?testId="email-clicks-trigger"/,
    "the title is the fold trigger",
  );
  assert.match(
    surface,
    /<Collapsible\s+open=\{open\}\s+onOpenChange=\{onOpenChange\}/,
  );

  // A remount re-reads storage; the same fixture the other cards use.
  const storage = new MemoryStorage();
  assert.equal(
    readCardOpen("email-control-analytics", storage),
    false,
    "a card nobody opened starts collapsed",
  );
  writeCardOpen("email-control-analytics", true, storage);
  assert.equal(
    readCardOpen("email-control-analytics", storage),
    true,
    "opening it survives a remount",
  );
  assert.equal(
    readCardOpen("email-rotation-card", storage),
    false,
    "and it never opens another card",
  );
});

test("a collapsed clicks card still shows the volume and the worst health", () => {
  const surface = clickSurface();
  const contentAt = surface.indexOf("<CollapsibleContent>");
  assert.ok(contentAt > 0, "the card has a foldable body");

  for (const [fact, label] of [
    ["{stats.total} clicks", "the total clicks"],
    ["health.label", "the worst health label"],
  ] as const) {
    const at = surface.indexOf(fact);
    assert.ok(at > 0, `${label} is rendered`);
    assert.ok(
      at < contentAt,
      `${label} is outside the fold, so collapsing cannot hide it`,
    );
  }

  // Everything else is the body: a collapsed card hides the table and the
  // source chips, never the numbers in its header.
  assert.ok(surface.indexOf("<table") > contentAt);
  assert.ok(surface.indexOf('data-testid="email-clicks-sources"') > contentAt);
});

test("the Grafana panel is already a collapsible source card, not a bare card", () => {
  // It renders through `SourceCard`, which owns the fold, so it needs no second
  // collapsible of its own.
  const start = panel.indexOf("export function AffiliateControlPanel");
  const section = panel.slice(start);
  assert.match(section, /<SourceCard/);
  assert.match(section, /testId="email-control-source-grafana"/);
  assert.doesNotMatch(section, /<Collapsible\b/);
});
