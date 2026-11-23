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
  assert.match(
    card,
    /import type \{ PauseAllState, PauseOutcome \} from "@\/app\/email\/actions"/,
    "the pause-all result types come from the action module, not a local copy",
  );

  // The page owns the action imports; importing a value here would let the card
  // bypass the props the page passes and hide a page that wired the wrong one.
  assert.doesNotMatch(
    card,
    /import \{(?![^}]*\btype\b)[^}]*\} from "@\/app\/email\/actions"/,
  );
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
  assert.match(card, /useIntentActionState\(\s*toggleTarget,\s*INITIAL,?/);
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

/**
 * Ticket 09: the aggregate volume line and Pause all. The console exists to
 * show one number — what every enabled source adds up to per day — so these
 * assertions pin where that number comes from, what it says when Grafana
 * cannot be read, and that pausing everything is one labelled act rather than
 * an unlabelled spinner.
 */
test("the header states the total across enabled continuous sources", () => {
  assert.match(card, /data-testid="email-targets-volume"/);
  assert.match(card, /volume\.totalClicksPerDay/);
  assert.match(card, /clicks\/day/);
  // A short per-source breakdown follows the total, from the same prop.
  assert.match(card, /volume\.sources\.map/);
  assert.match(card, /source\.label/);
});

test("a failed Grafana read makes the total Unavailable, never zero", () => {
  assert.match(
    card,
    /volume\.totalClicksPerDay === null[\s\S]*?Unavailable/,
    "the null branch renders the word",
  );
  assert.match(
    card,
    /unknown\s+rather than zero/,
    "and says why the number is missing",
  );
  assert.match(
    card,
    /source\.clicksPerDay === null[\s\S]*?unavailable/,
    "the per-source breakdown distinguishes unavailable from paused",
  );
});

test("a disabled source is shown as paused, contributing nothing", () => {
  assert.match(card, /if \(!source\.enabled\) return `\$\{source\.label\} paused`/);
});

test("Pause all is beside the aggregate line and posts to its own action", () => {
  assert.match(card, /pauseAll:/, "the action arrives as a prop");
  assert.match(card, /<form action=\{pauseAction\}>/);
  assert.match(card, /Pause all/);
  assert.match(
    card,
    /It leaves the target\s+list alone[\s\S]*?queued GitHub segment keeps running/,
    "the copy says what Pause all does not do",
  );
  assert.match(
    page,
    /pauseAllSources/,
    "the page imports the action",
  );
  assert.match(page, /pauseAll=\{pauseAllSources\}/);
});

test("each affected source has its own pending line", () => {
  assert.match(card, /Pausing Grafana…/);
  assert.match(card, /Disabling GitHub…/);
  assert.match(
    card,
    /pausingAll \?[\s\S]*?Pausing Grafana…[\s\S]*?Disabling GitHub…/,
    "both lines render together while the single request runs",
  );
});

test("locked disables Pause all and says why", () => {
  assert.match(
    card,
    /Unlock the controls to pause every source\./,
  );
  const testId = card.indexOf('data-testid="email-targets-pause-all"');
  const form = card.slice(card.indexOf("<form action={pauseAction}>"), testId);
  assert.match(form, /pending=\{pausingAll\}/);
  assert.match(form, /disabled=\{locked\}/);
});

test("add, pause and remove results are toasts only", () => {
  assert.match(
    card,
    /useActionToast\(state, TARGET_ERROR_TITLE, \{ successTitle: "Target added" \}\)/,
  );
  assert.match(
    card,
    /successTitle: pauseIntent \? "Target paused" : "Target resumed"/,
  );
  assert.match(
    card,
    /useIntentActionState\(\s*toggleTarget,\s*INITIAL,\s*\(formData\) => formData\.get\("enabled"\) === "false",/,
    "pause/resume titles read the submitted value, not the revalidated row",
  );
  assert.doesNotMatch(
    card,
    /successTitle: target\.enabled \?/,
    "revalidation must not be able to invert the title",
  );
  assert.match(
    card,
    /useActionToast\(removeState, TARGET_ERROR_TITLE, \{\s*successTitle: "Target removed"/,
  );
  assert.doesNotMatch(card, /<FeedbackAlert/, "no duplicate inline surface");
  // The pending lines stay: they show work in progress, not a result.
  assert.match(card, /Pausing Grafana…/);
});

test("per-source outcomes keep their sentences, in the toast", () => {
  assert.match(card, /state\.grafana/);
  assert.match(card, /state\.github/);
  assert.match(card, /check paused/);
  assert.match(card, /source disabled/);
  assert.match(card, /was already paused/);
  assert.match(card, /could not be paused/);
  assert.match(card, /could not be disabled/);
  assert.match(card, /successTitle: "Paused every source"/);
  assert.match(card, /details\.join\(" "\)/, "both lines ride in one toast");
  assert.doesNotMatch(
    card,
    /email-targets-pause-grafana|email-targets-pause-github/,
    "no inline outcome paragraphs remain",
  );
});
