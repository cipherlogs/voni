/**
 * One rotation setting, read by every Producer.
 *
 * The mode is chosen once on the page and has to mean the same thing to all of
 * them: the Grafana script's draw, the GitHub dispatch's input, the one-off
 * click and the burst. So this file proves the resolution rule and then proves
 * that one resolved value really does reach both consumers in the shape each of
 * them reads it.
 *
 * What is proved here:
 *
 *   - the stored setting wins over the saved script, so a copy left behind in
 *     the script can never override the operator's choice;
 *   - until the setting is written for the first time, a script that already
 *     carries a mode keeps reporting that mode — the migration path, written as
 *     the acceptance criterion words it;
 *   - one write, resolved once, is what the Grafana script and the GitHub
 *     dispatch both carry;
 *   - both modes still select exactly as before, through `pickTarget`, the seam
 *     every producer's draw already goes through;
 *   - the setting lives in one page-level row, and the actions read it there
 *     instead of the form or a stored script.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BROWSER_CHECK_INPUTS,
  dispatchBrowserCheck,
} from "@/lib/github/dispatch";
import { buildCheckScript } from "./check-script";
import {
  TARGET_SELECTION_DEFAULT,
  TARGET_SELECTION_LEGACY,
  pickTarget,
  readStoredTargetSelection,
  readTargetSelection,
  resolveTargetSelection,
  type TargetSelection,
} from "./target-selection";
import { currentRotation } from "./rotation";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(path, "utf8");
const rotationSource = read(join(here, "rotation.ts"));
const actionsSource = read(join(here, "../../app/email/actions.ts"));
const schemaSource = read(join(here, "../db/schema.ts"));

const SECRET = "report-secret-value";
const TARGETS = ["https://voni.cc/a", "https://voni.cc/b", "https://voni.cc/c"];

/** One action's body, from its declaration to the next top-level `export`. */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is exported`);
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

test("the stored setting wins, so a script's cached copy cannot override it", () => {
  // The one thing the ticket is strict about: once the operator chose, the
  // saved script is a cache, and a stale cache must lose to the setting.
  assert.equal(resolveTargetSelection("random", "rotate"), "random");
  assert.equal(resolveTargetSelection("rotate", "random"), "rotate");
  assert.equal(resolveTargetSelection("rotate", null), "rotate");
  assert.equal(resolveTargetSelection("random", null), "random");
});

test("currentRotation: the setting wins, and the script is only the migration path", async () => {
  let asked = 0;
  const fromScript = async (): Promise<TargetSelection | null> => {
    asked += 1;
    return "rotate";
  };

  assert.equal(await currentRotation(fromScript, async () => "random"), "random");
  assert.equal(asked, 0, "the script is not even consulted once the setting exists");

  assert.equal(await currentRotation(fromScript, async () => null), "rotate");
  assert.equal(asked, 1, "until the first write, the script is what is reported");

  assert.equal(
    await currentRotation(async () => null, async () => null),
    TARGET_SELECTION_LEGACY,
    "no setting and no marker is the legacy script, which rotates",
  );
});

test("until the setting is written, an existing script keeps reporting its mode", () => {
  const rotateScript = buildCheckScript({
    clicksPerRun: 1,
    reportSecret: SECRET,
    targets: TARGETS,
    selection: "rotate",
  });
  const randomScript = buildCheckScript({
    clicksPerRun: 1,
    reportSecret: SECRET,
    targets: TARGETS,
    selection: "random",
  });

  assert.equal(
    resolveTargetSelection(null, readStoredTargetSelection(rotateScript)),
    "rotate",
    "a saved script that already carries rotate keeps reporting rotate",
  );
  assert.equal(
    resolveTargetSelection(null, readStoredTargetSelection(randomScript)),
    "random",
  );
  // No setting and no marker is the plain legacy script, which rotates.
  assert.equal(resolveTargetSelection(null, null), TARGET_SELECTION_LEGACY);
});

test("one write, resolved once, is what both consumers carry", async () => {
  const bodies: { inputs?: Record<string, string> } = {};
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      inputs: Record<string, string>;
    };
    bodies.inputs = body.inputs;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  for (const written of ["rotate", "random"] as const) {
    // A single write, read back once: this is what every consumer receives.
    const setting: TargetSelection | null = written;
    const resolved = resolveTargetSelection(setting, "rotate");

    // Grafana: the rebuild writes the resolved mode into the script it runs.
    const script = buildCheckScript({
      clicksPerRun: 1,
      reportSecret: SECRET,
      targets: TARGETS,
      selection: resolved,
    });
    assert.equal(readTargetSelection(script), written, "the script runs the write");

    // GitHub: the dispatch carries the same value under its own input name.
    const dispatched = await dispatchBrowserCheck(
      {
        os: "ubuntu",
        targets: TARGETS,
        intervalSeconds: 60,
        windowSeconds: 3_600,
        selection: resolved,
      },
      { fetcher, readSecret: async () => "ghp_test_token" },
    );
    assert.equal(dispatched.ok, true);
    assert.equal(
      bodies.inputs![BROWSER_CHECK_INPUTS.selection],
      written,
      "the next dispatch's input is the same write",
    );

    // The one-off click draws with the same resolved value.
    assert.equal(
      resolveTargetSelection(setting, "rotate"),
      written,
      "and so does the click behind the button",
    );
  }
});

test("both modes still select the way they always did, through the seam", () => {
  // Unchanged behaviour, asserted where the producers' draws already meet:
  // rotate visits every target once per pass, random draws with replacement.
  const rotate = resolveTargetSelection("rotate", "random");
  const visited = new Map<string, number>();
  const pass: string[] = [];
  for (let click = 0; click < TARGETS.length; click += 1) {
    const picked = pickTarget(TARGETS, rotate, visited);
    pass.push(picked);
    visited.set(picked, click);
  }
  assert.deepEqual(
    [...pass].sort(),
    [...TARGETS].sort(),
    "one shuffled pass visits every target exactly once",
  );

  const random = resolveTargetSelection("random", "rotate");
  const repeatable = [
    pickTarget(TARGETS, random, new Map(), () => 0),
    pickTarget(TARGETS, random, new Map(), () => 0),
  ];
  assert.deepEqual(repeatable, [TARGETS[0], TARGETS[0]]);
  assert.equal(pickTarget(TARGETS, random, new Map(), () => 0.999), TARGETS[2]);
  assert.equal(TARGET_SELECTION_DEFAULT, "random");
});

test("the setting is one nullable row, not a column on a producer", () => {
  assert.match(
    schemaSource,
    /export const emailSettings = pgTable\("email_settings", \{/,
    "one console-wide settings table",
  );
  const table = schemaSource.slice(schemaSource.indexOf("emailSettings = pgTable("));
  assert.match(
    table.slice(0, table.indexOf("});")),
    /targetSelection: text\("target_selection"\)/,
    "nullable: null is 'nobody chose yet', which is what keeps an existing script's mode reported",
  );

  // The row is read and written through one module, so both consumers cannot
  // grow their own copy of the rule.
  assert.match(rotationSource, /export async function readRotationSetting/);
  assert.match(rotationSource, /export async function saveRotationSetting/);
  assert.match(rotationSource, /\.onConflictDoUpdate\(/, "a first write creates the row");
});

test("every producer's mode comes from the setting, never from a form", () => {
  const saveVolume = fnBody(actionsSource, "saveVolume");
  assert.doesNotMatch(
    saveVolume,
    /formData\.get\("selection"\)/,
    "the Grafana form no longer submits a mode: the page-level control owns it",
  );

  // Every *reader* asks the same helper, so no two producers can resolve the
  // setting differently. `saveRotation` is the write path and uploads the value
  // it just stored; the test below pins that.
  for (const name of [
    "saveVolume",
    "dispatchGithubNow",
    "runOneOffClick",
    "runBurst",
  ]) {
    assert.match(
      fnBody(actionsSource, name),
      /await liveSelection\(\)/,
      `${name} reads the shared setting`,
    );
  }

  const push = actionsSource.slice(
    actionsSource.indexOf("async function pushTargetsToCheck("),
    actionsSource.indexOf("\nexport ", actionsSource.indexOf("async function pushTargetsToCheck(")),
  );
  assert.match(
    push,
    /await liveSelection\(\)/,
    "a target edit rebuilds with the setting, preserving the script only when none was ever written",
  );

  // And the helper itself is the one place the rule is written.
  const helper = actionsSource.slice(
    actionsSource.indexOf("async function liveSelection("),
    actionsSource.indexOf("\n}", actionsSource.indexOf("async function liveSelection(")),
  );
  assert.match(helper, /currentRotation\(scriptSelection\)/);
  assert.doesNotMatch(
    actionsSource,
    /data\.targetSelection \?\?/,
    "no producer keeps its own 'script or default' rule beside the setting",
  );
});

test("saving the mode is one unlocked write that rebuilds Grafana from it", () => {
  const save = fnBody(actionsSource, "saveRotation");
  assert.match(
    save,
    /if \(!\(await requirePageUnlock\(\)\)\) return locked\(\);/,
    "the page password is the only authorization",
  );
  assert.ok(
    save.indexOf("requirePageUnlock()") < save.indexOf('formData.get("selection")'),
    "the gate runs before the input is read",
  );
  assert.match(
    save,
    /const selection = parseTargetSelection\(formData\.get\("selection"\)\);/,
  );
  assert.ok(
    save.indexOf("if (selection === null)") > 0,
    "a missing or unrecognised mode is a refusal, not the default",
  );
  assert.ok(
    save.indexOf("await saveRotationSetting(selection)") <
      save.indexOf("uploadRebuiltCheck("),
    "the setting is written first: it is the source of truth, and the script is rebuilt from it",
  );
  assert.match(
    save,
    /uploadRebuiltCheck\(\{[\s\S]*?selection,\s*\}\)/,
    "the rebuild uploads the mode just written, not a second read that could race it",
  );
});
