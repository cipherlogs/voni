import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Source-text guards for the target card's wiring.
 *
 * There is no runtime test for a client component's form bodies in this repo,
 * so this asserts the contract the server actions read: which fields each form
 * sends, that the pending state is per row, and that the actions arrive as
 * props from the page rather than being imported behind its back.
 */

const card = readFileSync(new URL("./targets-card.tsx", import.meta.url), "utf8");
const page = readFileSync(
  new URL("../app/email/page.tsx", import.meta.url),
  "utf8",
);

test("the card takes the actions as props and imports only their state types", () => {
  assert.match(card, /from "@\/lib\/email\/target-state"/);
  assert.match(card, /\bTargetState\b/);
  assert.match(card, /\bTargetView\b/);

  // The page owns the action imports; importing them here would let the card
  // bypass the props the page passes and hide a page that wired the wrong one.
  assert.doesNotMatch(card, /@\/app\/email\/actions/);
});

test("the page imports the three actions and passes them to the card", () => {
  const actionsImport = page.match(
    /import \{([^}]*)\} from "@\/app\/email\/actions";/,
  );
  assert.ok(actionsImport, "the page imports its actions from one module");

  for (const name of ["addTarget", "toggleTarget", "removeTarget"]) {
    assert.match(
      actionsImport[1],
      new RegExp(`\\b${name}\\b`),
      `${name} is imported by the page`,
    );
    assert.match(page, new RegExp(`${name}=\\{${name}\\}`));
  }
});

test("the add form sends the URL field the action reads", () => {
  assert.match(card, /action=\{action\}[\s\S]*?name="url"/);
  assert.match(
    card,
    /placeholder="https:\/\/www\.glizzitrium\.com\/BCMPW39K\/XXXX\/\?creative_id=123"/,
  );
});

test("pause and resume send the row id and the target's new enabled value", () => {
  assert.match(
    card,
    /action=\{toggleAction\}[\s\S]*?name="id"[\s\S]*?name="enabled"[\s\S]*?<\/form>/,
  );
  assert.match(card, /value=\{target\.enabled \? "false" : "true"\}/);
});

test("remove sends the row id", () => {
  assert.match(
    card,
    /action=\{removeAction\}[\s\S]*?name="id"[\s\S]*?<\/form>/,
  );
});

test("each write control is a LoadingButton with its own pending flag", () => {
  assert.match(card, /import \{ LoadingButton \} from "@\/components\/loading-button"/);
  assert.match(card, /pending=\{pending\}/);
  assert.match(card, /pending=\{toggling\}/);
  assert.match(card, /pending=\{removing\}/);

  // Per-row hooks, not one list-wide boolean: pausing one target must not
  // blank every other row's buttons.
  assert.match(card, /useActionState\(\s*toggleTarget,\s*INITIAL,?\s*\)/);
  assert.match(card, /useActionState\(\s*removeTarget,\s*INITIAL,?\s*\)/);
});

test("locked disables every write control and says why", () => {
  assert.match(
    card,
    /Unlock the controls to change the target list\./,
  );

  const disabled = card.split("disabled={locked}").length - 1;
  assert.ok(
    disabled >= 3,
    "add, pause/resume and remove are all disabled while locked",
  );
  assert.match(card, /\{locked \? null : <AddTargetForm/);
});
