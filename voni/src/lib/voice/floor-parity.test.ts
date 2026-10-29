/**
 * Floor arbitration while the agent holds the floor (meta-cascade ticket 70).
 *
 * The cascade owns the decision (`voice-pipeline/cascade/floor.py`); the
 * browser owns one of the word sets and the overlap judge. Both read the same
 * table, `floor-cases.json`, exactly as the barge-in recovery table is shared
 * between the browser and the phone bridge. The table is the external
 * contract: a verdict mapping that stops holding is drift, not a new expected
 * value.
 *
 * Vocabulary: take the floor / yield / wait. `commit` is not cascade
 * vocabulary; `judge` is the browser's deferral, which the cascade resolves to
 * take_floor or wait with its injected judge score.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { judgeOverlap } from "./barge-in";
import { EN_RECOGNITION, isCommandBargeIn, isFillerOnly } from "./recognition";

type Verdict = "yield" | "ignore" | "judge";
type Action = "take_floor" | "backchannel" | "wait";

type Case = {
  name: string;
  text: string;
  agentSpeakingMs: number;
  judgeScore: number;
  command: boolean;
  backchannel: boolean;
  tsVerdict: Verdict;
  cascade: Action;
  softConfirm?: boolean;
};

const fixture = JSON.parse(
  readFileSync(new URL("./floor-cases.json", import.meta.url), "utf8"),
) as { contract: string; comment: string; cases: Case[] };

/** What each browser verdict permits the cascade to decide. */
const ALLOWED: Record<Verdict, ReadonlySet<Action>> = {
  yield: new Set<Action>(["take_floor"]),
  ignore: new Set<Action>(["backchannel", "wait"]),
  judge: new Set<Action>(["take_floor", "wait"]),
};

/** The existing establishment window, from `voice-pipeline/turns.py`. */
const ESTABLISHED_MS = 800;

test("the floor table is the contract the cascade pins", () => {
  assert.equal(fixture.contract, "floor-arbitration/1");
  assert.ok(fixture.cases.length > 20);
  assert.ok(fixture.comment.length > 0);
});

test("every case classifies into the existing command and filler sets", () => {
  for (const item of fixture.cases) {
    assert.equal(
      isCommandBargeIn(item.text, EN_RECOGNITION),
      item.command,
      item.name,
    );
    assert.equal(
      isFillerOnly(item.text, EN_RECOGNITION),
      item.backchannel,
      item.name,
    );
  }
});

test("the browser overlap verdict matches the recorded verdict", () => {
  for (const item of fixture.cases) {
    assert.equal(
      judgeOverlap(item.text, "", EN_RECOGNITION),
      item.tsVerdict,
      item.name,
    );
  }
});

test("the browser verdict maps onto the cascade action", () => {
  for (const item of fixture.cases) {
    const allowed = new Set(ALLOWED[item.tsVerdict]);
    if (item.agentSpeakingMs < ESTABLISHED_MS) {
      // The browser judge has no talk-over window; the cascade waits inside
      // the existing establishment guard whatever the judge says.
      allowed.add("wait");
    }
    assert.ok(
      allowed.has(item.cascade),
      `${item.name}: ${item.tsVerdict} -> ${item.cascade}`,
    );
  }
});

test("bare assent is never a command, never filler and never a cut", () => {
  const assent = fixture.cases.filter((item) => item.softConfirm === true);
  assert.deepEqual(
    assent.map((item) => item.text).sort(),
    ["yeah", "yes"],
  );
  for (const item of assent) {
    assert.equal(item.command, false, item.name);
    assert.equal(item.backchannel, false, item.name);
    assert.equal(item.cascade, "wait", item.name);
  }
});
