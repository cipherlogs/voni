import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { CopilotBus, type BusContext } from "./bus";
import { ProposalStore } from "./proposals";

function makeHarness() {
  let now = 1_000_000;
  const store = new ProposalStore(() => now);
  const bus = new CopilotBus(store, () => now);
  let executions = 0;
  let target = { value: "old goal", version: 3 };
  const ctx: BusContext = {
    userId: "user-1",
    organizationId: "org-1",
    sessionId: "sess-1",
    route: "/agents/new",
    registration: 7,
    targets: new Map([
      ["wizard:goal", () => ({ ...target })],
    ]),
  };
  bus.register({
    name: "wizard_apply",
    description: "Applies a confirmed wizard patch.",
    parameters: { type: "object" },
    schema: z.object({ goal: z.string() }),
    effect: { mutates: true, scope: "wizard", reversible: true },
    routes: ["/agents/new"],
    mode: "interactive",
    listed: false,
    run: null,
    executor: async (payload) => {
      executions += 1;
      const { goal } = payload as { goal: string };
      target = { value: goal, version: target.version + 1 };
      return {
        result: { applied: goal },
        resultingVersion: target.version,
      };
    },
  });
  const propose = (overrides: Record<string, unknown> = {}) =>
    store.create({
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      sessionId: ctx.sessionId,
      route: ctx.route,
      registration: ctx.registration,
      target: { kind: "wizard", id: "goal" },
      expected: { value: "old goal", version: 3 },
      payload: { goal: "new goal" },
      executor: "wizard_apply",
      summary: "Set the goal to new goal",
      keyPhrases: ["goal", "new goal"],
      inverse: { summary: "Restore the old goal", payload: { goal: "old goal" } },
      ...overrides,
    });
  // Full happy path up to the confirmation step.
  const driveToArmed = (proposalId: string) => {
    const proposal = store.get(proposalId);
    assert.ok(proposal);
    const matched = bus.recordAgentTurn(
      "agent-turn-1",
      "I'll set the goal to new goal, say apply when ready",
    );
    assert.ok(matched.includes(proposalId));
    assert.deepEqual(store.arm(proposalId), { ok: true });
  };
  return {
    store,
    bus,
    ctx,
    propose,
    driveToArmed,
    executions: () => executions,
    setTarget: (next: { value: string; version: number }) => (target = next),
    advance: (ms: number) => (now += ms),
  };
}

test("full loop: propose, readback, yes, apply — executor runs once", async () => {
  const h = makeHarness();
  const proposal = h.propose();
  h.driveToArmed(proposal.id);
  const heard = h.bus.recordVoiceTurn("user-turn-1", "yes", h.ctx);
  assert.equal(heard.verdict, "affirm");
  assert.equal(heard.proposalId, proposal.id);
  const result = await h.bus.confirmProposal(proposal.id, h.ctx);
  assert.equal(result.ok, true);
  assert.deepEqual((result as { data: unknown }).data, { applied: "new goal" });
  assert.equal(h.executions(), 1);
  // Duplicate confirm (double tool.call, voice+tap race) replays the outcome.
  const again = await h.bus.confirmProposal(proposal.id, h.ctx);
  assert.equal(again.ok, true);
  assert.equal(h.executions(), 1);
});

test("same-turn propose-and-confirm is rejected: readback comes first", async () => {
  const h = makeHarness();
  const proposal = h.propose();
  // The model calls confirm before anything was voiced.
  const result = await h.bus.confirmProposal(proposal.id, h.ctx);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /reading that back/);
  assert.equal((result as { retryable: boolean }).retryable, true);
  assert.equal(h.executions(), 0);
});

test("pre-arming yes does not count; a fresh yes after arming does", async () => {
  const h = makeHarness();
  const proposal = h.propose();
  const early = h.bus.recordVoiceTurn("user-turn-0", "yes", h.ctx);
  assert.equal(early.verdict, "ignored");
  h.driveToArmed(proposal.id);
  const late = h.bus.recordVoiceTurn("user-turn-1", "yes", h.ctx);
  assert.equal(late.proposalId, proposal.id);
  const result = await h.bus.confirmProposal(proposal.id, h.ctx);
  assert.equal(result.ok, true);
});

test("qualified assent keeps the proposal pending", async () => {
  const h = makeHarness();
  const proposal = h.propose();
  h.driveToArmed(proposal.id);
  const heard = h.bus.recordVoiceTurn("user-turn-1", "yes, but make it shorter", h.ctx);
  assert.equal(heard.verdict, "qualified");
  assert.equal(heard.proposalId, undefined);
  const result = await h.bus.confirmProposal(proposal.id, h.ctx);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /No confirmation observed/);
});

test("bare yes with two pending proposals demands disambiguation", () => {
  const h = makeHarness();
  const first = h.propose();
  const second = h.propose({
    target: { kind: "wizard", id: "tasks" },
    expected: { value: [], version: 1 },
    payload: { tasks: ["call leads"] },
    summary: "Set tasks to call leads",
    keyPhrases: ["tasks", "call leads"],
  });
  h.driveToArmed(first.id);
  h.store.matchReadback("agent-turn-2", "I'll set tasks to call leads");
  h.store.arm(second.id);
  const heard = h.bus.recordVoiceTurn("user-turn-1", "apply", h.ctx);
  assert.equal(heard.needsDisambiguation, true);
  assert.equal(heard.proposalId, undefined);
});

test("no on a single armed proposal dismisses it", () => {
  const h = makeHarness();
  const proposal = h.propose();
  h.driveToArmed(proposal.id);
  const heard = h.bus.recordVoiceTurn("user-turn-1", "no, cancel that", h.ctx);
  assert.equal(heard.verdict, "deny");
  assert.equal(h.store.get(proposal.id)?.status, "dismissed");
});

test("typing before Apply conflicts instead of overwriting", async () => {
  const h = makeHarness();
  const proposal = h.propose();
  h.driveToArmed(proposal.id);
  h.bus.recordTapApply(proposal.id);
  // The user's keyboard got there first.
  h.setTarget({ value: "typed goal", version: 4 });
  const result = await h.bus.confirmProposal(proposal.id, h.ctx);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /changed since I proposed/);
  assert.equal(h.store.get(proposal.id)?.status, "conflicted");
  assert.equal(h.executions(), 0);
});

test("navigation expires the proposal instead of applying elsewhere", async () => {
  const h = makeHarness();
  const proposal = h.propose();
  h.driveToArmed(proposal.id);
  h.bus.recordTapApply(proposal.id);
  const elsewhere: BusContext = { ...h.ctx, route: "/jobs", registration: 8 };
  const result = await h.bus.confirmProposal(proposal.id, elsewhere);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /navigated away/);
  assert.equal(h.store.get(proposal.id)?.status, "expired");
  assert.equal(h.executions(), 0);
});

test("executor throw means unknown, never silent success or retry-run", async () => {
  const h = makeHarness();
  h.bus.register({
    name: "flaky_apply",
    description: "Throws mid-flight.",
    parameters: { type: "object" },
    schema: z.object({}),
    effect: { mutates: true, scope: "test", reversible: false },
    routes: ["/agents/new"],
    mode: "interactive",
    listed: false,
    run: null,
    executor: async () => {
      throw new Error("socket died mid-send");
    },
  });
  const proposal = h.propose({ executor: "flaky_apply" });
  h.driveToArmed(proposal.id);
  h.bus.recordTapApply(proposal.id);
  const result = await h.bus.confirmProposal(proposal.id, h.ctx);
  assert.equal(result.ok, false);
  assert.equal((result as { retryable: boolean }).retryable, true);
  assert.equal(h.store.get(proposal.id)?.status, "unknown");
  // A second confirm replays the memoized outcome — no blind rerun.
  const again = await h.bus.confirmProposal(proposal.id, h.ctx);
  assert.equal(again.ok, false);
});

test("dismissing an applied proposal points at undo instead", () => {
  const h = makeHarness();
  const proposal = h.propose();
  h.driveToArmed(proposal.id);
  h.bus.recordTapApply(proposal.id);
  return h.bus.confirmProposal(proposal.id, h.ctx).then(async (result) => {
    assert.equal(result.ok, true);
    const dismissed = h.bus.dismissProposal(proposal.id);
    assert.equal(dismissed.ok, false);
    assert.match((dismissed as { error: string }).error, /undo/);
  });
});

test("undo proposal goes stale when newer edits land", () => {
  const h = makeHarness();
  const proposal = h.propose();
  h.driveToArmed(proposal.id);
  h.bus.recordTapApply(proposal.id);
  return h.bus.confirmProposal(proposal.id, h.ctx).then(() => {
    const fresh = h.bus.buildUndoProposal(proposal.id, h.ctx);
    assert.equal(fresh.ok, true);
    // Another edit after applying invalidates that card's Undo.
    h.setTarget({ value: "even newer goal", version: 9 });
    const stale = h.bus.buildUndoProposal(proposal.id, h.ctx);
    assert.equal(stale.ok, false);
    assert.match((stale as { error: string }).error, /clobber/);
  });
});

test("mutating executors are unreachable by direct dispatch", async () => {
  const h = makeHarness();
  const result = await h.bus.dispatch("wizard_apply", { goal: "x" }, h.ctx);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /propose it first/);
  assert.equal(h.executions(), 0);
});

test("unknown and route-gated tools are rejected", async () => {
  const h = makeHarness();
  h.bus.register({
    name: "wizard_only_read",
    description: "Reads wizard state.",
    parameters: { type: "object" },
    schema: z.object({}),
    effect: { mutates: false, scope: "wizard", reversible: true },
    routes: ["/agents/new"],
    mode: "interactive",
    listed: true,
    run: async () => ({ ok: true, data: { state: "ok" } }),
    executor: null,
  });
  const unknown = await h.bus.dispatch("nope", {}, h.ctx);
  assert.equal(unknown.ok, false);
  const elsewhere: BusContext = { ...h.ctx, route: "/jobs", registration: 8 };
  const gated = await h.bus.dispatch("wizard_only_read", {}, elsewhere);
  assert.equal(gated.ok, false);
  assert.match((gated as { error: string }).error, /isn't available on this screen/);
  const home = await h.bus.dispatch("wizard_only_read", {}, h.ctx);
  assert.equal(home.ok, true);
});
