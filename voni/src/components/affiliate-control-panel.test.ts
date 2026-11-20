import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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

test("a Lock page control calls lockPage and is reachable in both panel states", () => {
  assert.match(panel, /await lockPage\(\);/);
  assert.match(panel, /data-testid="email-lock-page"/);

  const renders = panel.split("<LockPageButton />").length - 1;
  assert.equal(
    renders,
    2,
    "rendered for the unlocked panel and for the locked card, so the page lock exists without the control secret",
  );
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

test("the save form posts the target mode as a field, not through the Switch", () => {
  // The Switch is a button-style Base UI control with no form value of its own,
  // and `saveVolume` refuses a request without a mode rather than guessing the
  // default. So a hidden field carries the value, and the Switch must not be
  // trusted to submit one.
  assert.match(
    panel,
    /<input type="hidden" name="selection" value=\{selection\} \/>/,
  );
  assert.match(panel, /import \{ Switch \} from "@\/components\/ui\/switch";/);

  const switchBlock = /<Switch[\s\S]*?\/>/.exec(panel)?.[0] ?? "";
  assert.ok(switchBlock, "the selection Switch is rendered");
  assert.doesNotMatch(
    switchBlock,
    /name="selection"/,
    "the Switch posts nothing, so the hidden field is the submission",
  );
  assert.match(
    switchBlock,
    /disabled=\{disabled\}/,
    "same save-in-flight / check-unavailable gate as the interval and clicks",
  );
});

test("the mode shown is the one the stored script runs, read through its vocabulary", () => {
  // A mode held only in local state would let the panel show a preference the
  // deployed script never applied. An unmarked script is "no choice yet": the
  // switch opens on the new default and the copy says the live script still
  // rotates, so the display stays honest until Save writes the new script.
  assert.match(panel, /targetSelection: TargetSelection \| null;/);
  assert.match(
    panel,
    /useState<TargetSelection>\(\s*\(\) => check\?\.targetSelection \?\? TARGET_SELECTION_DEFAULT,/,
  );
  assert.match(panel, /checked=\{selection === "random"\}/);
  assert.match(panel, /from "@\/lib\/email\/target-selection"/);
  assert.match(panel, /TARGET_SELECTION_LABELS\[selection\]/);
  assert.match(panel, /TARGET_SELECTION_DESCRIPTIONS\[selection\]/);
  // The migration note names the real behaviour of an unmarked script, so the
  // switch never claims a mode the live check is not running.
  assert.match(panel, /selectionUnmarked/);
  assert.match(
    panel,
    /still rotating through every target; saving now applies your choice/,
  );
  // Copy that describes the current check (the one-off note) still reads the
  // live behaviour, where an unmarked script is rotate.
  assert.match(
    panel,
    /check\?\.targetSelection \?\? TARGET_SELECTION_LEGACY/,
  );
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

test("the rotate note follows the saved script, not the unsaved switch", () => {
  assert.match(panel, /const savedSelection: TargetSelection =/);
  assert.match(
    panel,
    /savedSelection === "rotate"/,
    "the server reads the mode from the stored check, so the copy must too",
  );
  assert.match(
    panel,
    /the least recently clicked of\s+the ticked targets/,
  );
});
