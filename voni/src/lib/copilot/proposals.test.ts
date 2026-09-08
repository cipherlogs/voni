import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAssent,
  ProposalStore,
  readbackMatches,
} from "./proposals";

function makeStore(nowValue = 1_000_000) {
  let now = nowValue;
  const store = new ProposalStore(() => now);
  return { store, advance: (ms: number) => (now += ms) };
}

const BASE = {
  userId: "user-1",
  organizationId: "org-1",
  sessionId: "sess-1",
  route: "/agents/new",
  registration: 7,
  target: { kind: "wizard", id: "goal" },
  expected: { value: "old goal", version: 3 },
  payload: { goal: "new goal" },
  executor: "wizard_apply",
  summary: "Set the goal to new goal",
  keyPhrases: ["goal", "new goal"],
};

test("proposals require readback phrases and freeze their payload", () => {
  const { store } = makeStore();
  assert.throws(
    () => store.create({ ...BASE, keyPhrases: [] }),
    /readback key phrases/,
  );
  const proposal = store.create(BASE);
  assert.equal(Object.isFrozen(proposal.payload), true);
  assert.throws(() => {
    (proposal.payload as Record<string, unknown>)["goal"] = "hacked";
  });
});

test("readback matcher is strict containment, not vibes", () => {
  assert.equal(readbackMatches("I'll set the goal to new goal now", ["goal", "new goal"]), true);
  // Case and punctuation insensitive.
  assert.equal(readbackMatches("Goal: NEW goal!", ["goal", "new goal"]), true);
  // Every phrase must appear.
  assert.equal(readbackMatches("I'll set the goal now", ["goal", "new goal"]), false);
  // Word boundaries: "he" must not match inside "the".
  assert.equal(readbackMatches("the goal", ["he"]), false);
  // No phrases, no match — unvoiced proposals can never arm.
  assert.equal(readbackMatches("anything at all", []), false);
});

test("assent classifier accepts only bare affirmations", () => {
  for (const yes of ["yes", "Yeah!", "APPLY", "do it", "go ahead", "sounds good", "ok"]) {
    assert.equal(classifyAssent(yes), "affirm", yes);
  }
  assert.equal(classifyAssent("yes, but make it shorter"), "qualified");
  assert.equal(classifyAssent("yes however keep the old name"), "qualified");
  assert.equal(classifyAssent("no"), "deny");
  assert.equal(classifyAssent("nope, cancel that"), "deny");
  assert.equal(classifyAssent("don't do that"), "deny");
  assert.equal(classifyAssent("maybe later"), "ambiguous");
  assert.equal(classifyAssent("what did you propose?"), "ambiguous");
  assert.equal(classifyAssent(""), "ambiguous");
});

test("arming requires an observed readback first", () => {
  const { store } = makeStore();
  const proposal = store.create(BASE);
  assert.deepEqual(store.arm(proposal.id), {
    ok: false,
    reason: "Readback not observed yet.",
  });
  store.matchReadback("agent-turn-1", "I'll set the goal to new goal");
  assert.deepEqual(store.arm(proposal.id), { ok: true });
  assert.equal(store.get(proposal.id)?.status, "armed");
});

test("pre-arming speech can never attach as assent", () => {
  const { store } = makeStore();
  const proposal = store.create(BASE);
  // The user says "yes" (event 1) before any readback exists.
  const earlySeq = store.noteEvent();
  store.matchReadback("agent-turn-1", "I'll set the goal to new goal");
  store.arm(proposal.id);
  assert.equal(store.attachVoiceAssent(proposal.id, "user-turn-1", earlySeq), false);
  assert.equal(store.get(proposal.id)?.assent, null);
});

test("claim is single-use: double tool.call cannot double-execute", () => {
  const { store } = makeStore();
  const proposal = store.create(BASE);
  store.matchReadback("agent-turn-1", "I'll set the goal to new goal");
  store.arm(proposal.id);
  store.attachTapAssent(proposal.id);
  assert.deepEqual(store.claim(proposal.id), { ok: true });
  assert.deepEqual(store.claim(proposal.id), {
    ok: false,
    reason: "Proposal is executing.",
  });
});

test("expired and scoped-out proposals die loudly", () => {
  const { store, advance } = makeStore();
  const proposal = store.create({ ...BASE, ttlMs: 1000 });
  advance(2000);
  assert.deepEqual(store.purgeExpired(), [proposal.id]);
  assert.equal(store.get(proposal.id)?.status, "expired");

  const { store: store2 } = makeStore();
  const other = store2.create(BASE);
  const expired = store2.expireWhere((p) => p.route !== "/jobs");
  assert.deepEqual(expired, [other.id]);
});
