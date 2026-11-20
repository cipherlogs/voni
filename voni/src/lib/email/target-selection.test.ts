/**
 * The target-selection modes: what a stored script says it does, and how a
 * one-off click picks from the subset the operator ticked.
 *
 * What is proved here:
 *
 *   - a new script's mode is random, and a script with no marker reads back as
 *     rotate — the behaviour every pre-setting script actually had;
 *   - the read-back is strict: only the two modes parse, and a garbled marker
 *     does not become the panel's starting value;
 *   - `random` is a uniform draw with replacement, so a target may repeat;
 *   - `rotate` walks the selected list by last visit, never-seen first, and
 *     keeps the list's order on a tie.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGET_SELECTION_DEFAULT,
  TARGET_SELECTION_LEGACY,
  isTargetSelection,
  parseTargetSelection,
  pickTarget,
  readStoredTargetSelection,
  readTargetSelection,
} from "./target-selection";

test("the defaults: a new script draws at random, an unmarked one rotates", () => {
  assert.equal(TARGET_SELECTION_DEFAULT, "random");
  assert.equal(TARGET_SELECTION_LEGACY, "rotate");
  assert.notEqual(TARGET_SELECTION_DEFAULT, TARGET_SELECTION_LEGACY);
});

test("readTargetSelection reads the marker the builder writes", () => {
  assert.equal(
    readTargetSelection('const TARGET_SELECTION = "random";'),
    "random",
  );
  assert.equal(
    readTargetSelection('const TARGET_SELECTION = "rotate";'),
    "rotate",
  );
});

test("readTargetSelection: an unmarked or garbled script rotates", () => {
  // Every script uploaded before the mode existed draws from a shuffle bag, so
  // calling it anything else would make the panel describe the wrong check.
  assert.equal(readTargetSelection("export default function x() {}"), "rotate");
  assert.equal(readTargetSelection('const TARGET_SELECTION = "shuffle";'), "rotate");
  assert.equal(readTargetSelection('const TARGET_SELECTION = "random"'), "rotate");
});

test("readStoredTargetSelection: no marker is 'no choice yet', not rotate", () => {
  // The panel's switch starts from this reader: unmarked opens on the new
  // default, while the copy beside it says the live script still rotates.
  assert.equal(
    readStoredTargetSelection('const TARGET_SELECTION = "random";'),
    "random",
  );
  assert.equal(
    readStoredTargetSelection('const TARGET_SELECTION = "rotate";'),
    "rotate",
  );
  assert.equal(readStoredTargetSelection("export default function x() {}"), null);
  assert.equal(
    readStoredTargetSelection('const TARGET_SELECTION = "shuffle";'),
    null,
  );
  // The effective reader is the same answer with the legacy behaviour filled in.
  const unmarked = "export default function x() {}";
  assert.equal(readTargetSelection(unmarked), TARGET_SELECTION_LEGACY);
});

test("parseTargetSelection is strict: a form value is the two names or nothing", () => {
  assert.equal(parseTargetSelection("random"), "random");
  assert.equal(parseTargetSelection("rotate"), "rotate");
  for (const bad of [undefined, null, "", "Random", "shuffle", 1, {}]) {
    assert.equal(parseTargetSelection(bad), null);
  }
  assert.equal(isTargetSelection("rotate"), true);
  assert.equal(isTargetSelection("nope"), false);
});

test("pickTarget random: any entry, equal odds, with replacement", () => {
  const items = ["a", "b", "c"];
  assert.equal(pickTarget(items, "random", new Map(), () => 0), "a");
  assert.equal(pickTarget(items, "random", new Map(), () => 0.999), "c");
  // The same entry twice in a row is allowed: this is the whole difference from
  // a bag, which would never repeat before its pass ended.
  assert.equal(pickTarget(items, "random", new Map(), () => 0), "a");
});

test("pickTarget rotate: the least recently visited, never-seen first", () => {
  const items = ["a", "b", "c"];
  const seen = new Map([
    ["a", 3_000],
    ["b", 1_000],
  ]);
  // "c" has never been visited, which beats any timestamp.
  assert.equal(pickTarget(items, "rotate", seen), "c");

  assert.equal(pickTarget(items, "rotate", new Map([["a", 3_000], ["b", 1_000], ["c", 2_000]])), "b");
  // A tie keeps the list's own order, so equal history is not arbitrary.
  assert.equal(pickTarget(items, "rotate", new Map([["a", 1], ["b", 1], ["c", 1]])), "a");
  assert.equal(pickTarget(items, "rotate"), "a", "no history at all is a tie at the top");
});

test("pickTarget refuses an empty selection instead of returning undefined", () => {
  assert.throws(() => pickTarget([], "random"), /at least one target/);
  assert.throws(() => pickTarget([], "rotate"), /at least one target/);
});
