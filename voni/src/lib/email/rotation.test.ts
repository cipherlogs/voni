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
 *   - a save writes the setting first and rebuilds Grafana from it, and a
 *     rebuild that fails is a saved setting with a stale script (a warning),
 *     not a failed save.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_CHECK_INPUTS,
  dispatchBrowserCheck,
} from "@/lib/github/dispatch";
import { saveRotationMode, type RotationSaveDeps } from "./rotation-save";
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

const SECRET = "report-secret-value";
const TARGETS = ["https://voni.cc/a", "https://voni.cc/b", "https://voni.cc/c"];

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
      { fetcher, readSecret: async () => "ghp_test_token", readPoolTarget: async () => 5 },
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


/**
 * A save has two effects and they can fail apart: the setting (the source of
 * truth every producer reads) and Grafana's saved script (a copy of it). These
 * tests drive the save through the injected seam, so what is asserted is what
 * the operator observes: the setting was written, what the rebuild received,
 * and whether the result is a success, a partial success or a refusal.
 */
function saveDeps(overrides: Partial<RotationSaveDeps> = {}): RotationSaveDeps {
  return {
    saveSetting: async () => {},
    readCheck: async () => ({ ok: true as const, clicksPerRun: 2 }),
    readTargets: async () => [...TARGETS],
    rebuild: async () => null,
    ...overrides,
  };
}

test("a save writes the setting, then rebuilds Grafana from that same value", async () => {
  const seen: string[] = [];
  const outcome = await saveRotationMode(
    "rotate",
    saveDeps({
      saveSetting: async (selection) => {
        seen.push(`setting:${selection}`);
      },
      readCheck: async () => {
        seen.push("check");
        return { ok: true as const, clicksPerRun: 4 };
      },
      rebuild: async (input) => {
        seen.push(`script:${input.selection}:${input.clicksPerRun}:${input.targets.length}`);
        return null;
      },
    }),
  );

  assert.deepEqual(
    seen,
    ["setting:rotate", "check", "script:rotate:4:3"],
    "the setting is stored before the script is derived from it",
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.warning, undefined, "both effects landed, so there is nothing to warn about");
});

test("a rebuild that fails leaves a saved setting and says the script is stale", async () => {
  const outcome = await saveRotationMode(
    "random",
    saveDeps({ rebuild: async () => "Grafana answered 500" }),
  );

  assert.equal(outcome.ok, true, "the operator's choice is stored; this is not a failed save");
  assert.equal("error" in outcome, false, "the failure title must not claim the save failed");
  assert.match(outcome.warning ?? "", /saved/i);
  assert.match(outcome.warning ?? "", /Grafana answered 500/);
  assert.match(outcome.warning ?? "", /Save again to retry/);
});

test("a check that cannot be read is the same partial success", async () => {
  const outcome = await saveRotationMode(
    "rotate",
    saveDeps({ readCheck: async () => ({ ok: false as const, message: "Grafana timed out" }) }),
  );

  assert.equal(outcome.ok, true);
  assert.match(outcome.warning ?? "", /Grafana timed out/);
});

test("a rebuild that throws is reported, not propagated", async () => {
  const outcome = await saveRotationMode(
    "rotate",
    saveDeps({
      rebuild: async () => {
        throw new Error("the upload socket closed");
      },
    }),
  );

  assert.equal(outcome.ok, true);
  assert.match(outcome.warning ?? "", /the upload socket closed/);
});

test("a setting write that fails changes nothing and rebuilds nothing", async () => {
  let rebuilt = false;
  const outcome = await saveRotationMode(
    "random",
    saveDeps({
      saveSetting: async () => {
        throw new Error("the database refused");
      },
      rebuild: async () => {
        rebuilt = true;
        return null;
      },
    }),
  );

  assert.equal(outcome.ok, false);
  assert.equal(rebuilt, false, "a script rebuilt without the setting would run a mode nobody stored");
  assert.match(outcome.ok ? "" : outcome.error, /nothing changed/);
});
