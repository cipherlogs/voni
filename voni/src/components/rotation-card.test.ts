/**
 * The page-level rotation control, read as source because this runner cannot
 * render a client component.
 *
 * The invariant is the ticket's: the mode is chosen once, outside the Grafana
 * card, and the control posts a value rather than relying on the Switch. The
 * Grafana card must no longer carry a switch of its own — two controls would
 * let the two Sources disagree, which is exactly what this moved to prevent.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(path, "utf8");

const card = read(join(here, "rotation-card.tsx"));
const panel = read(join(here, "affiliate-control-panel.tsx"));
const page = read(join(here, "../app/email/page.tsx"));

test("the switch posts its value, so the server never guesses a mode", () => {
  assert.match(
    card,
    /<input type="hidden" name="selection" value=\{selection\} \/>/,
    "the Switch is a Base UI button and posts nothing on its own",
  );
  const switchBlock = /<Switch[\s\S]*?\/>/.exec(card)?.[0] ?? "";
  assert.ok(switchBlock, "the card renders the rotation Switch");
  assert.doesNotMatch(
    switchBlock,
    /name="selection"/,
    "the hidden field is the submission, not the Switch",
  );
  assert.match(switchBlock, /checked=\{selection === "random"\}/);
  assert.match(
    switchBlock,
    /disabled=\{saving\}/,
    "an in-flight save disables it, so a second submission cannot race the first",
  );
});

test("the save is visibly pending and reports through the toast", () => {
  // The repo's feedback protocol: every async trigger disables itself, shows a
  // pending label, and never fails silently.
  assert.match(card, /useActionState\(action, INITIAL\)/);
  assert.match(card, /<LoadingButton/);
  assert.match(card, /pending=\{saving\}/);
  assert.match(card, /pendingText="Saving…"/);
  assert.match(card, /useActionToast\(state, "Could not save the rotation mode"/);
});

test("the card says which mode runs, in the shared vocabulary", () => {
  assert.match(card, /TARGET_SELECTION_LABELS\[mode\]/);
  assert.match(card, /TARGET_SELECTION_LABELS\[selection\]/);
  assert.match(card, /TARGET_SELECTION_DESCRIPTIONS\[selection\]/);
  // The migration state is named rather than hidden: until a mode is saved, an
  // existing script keeps its own, and claiming otherwise would lie.
  assert.match(card, /chosen/);
  assert.match(
    card,
    /No mode has been saved here yet, so this shows what Grafana's script already does/,
  );
});

test("the Grafana card no longer owns the mode", () => {
  assert.doesNotMatch(
    panel,
    /email-control-selection/,
    "the old switch inside the Grafana card is gone",
  );
  assert.doesNotMatch(
    panel,
    /<input type="hidden" name="selection"/,
    "and it no longer posts a mode to saveVolume",
  );
  assert.doesNotMatch(panel, /useState<TargetSelection>/);
});

test("the page renders the control once, beside the shared target list", () => {
  const renders = page.match(/<RotationCard/g) ?? [];
  assert.equal(renders.length, 1, "one control, one setting");
  assert.ok(
    page.indexOf("<RotationCard") < page.indexOf("<AffiliateControlPanel"),
    "it sits above the source cards, outside the Grafana one",
  );
  assert.match(
    page,
    /mode=\{rotation\}[\s\S]*?action=\{saveRotation\}/,
    "the page passes the resolved mode and the one write that changes it",
  );
  assert.match(
    page,
    /const rotation = resolveTargetSelection\(\s*rotationSetting,/,
    "and resolves it with the shared rule, not its own fallback",
  );
});
