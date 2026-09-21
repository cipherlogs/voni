import test from "node:test";
import assert from "node:assert/strict";
import {
  BARGE_IN_THRESHOLD,
  FILLER_POOL,
  chooseReplyAction,
  heuristicBargeInScore,
  requestVoiceJudge,
  shouldAllowToolCall,
  shouldYieldToBargeIn,
} from "./jev-judges";

test("backchannel never yields (fail-closed)", () => {
  for (const text of ["uh-huh", "yeah", "mhm", "okay", "right"]) {
    const r = shouldYieldToBargeIn({ partialText: text, agentSpeakingMs: 3000 });
    assert.equal(r.yield, false, text);
  }
});

test("real interruption yields once the agent is established", () => {
  const r = shouldYieldToBargeIn({
    partialText: "stop, what is the price",
    agentSpeakingMs: 3000,
  });
  assert.equal(r.yield, true);
  assert.ok(r.probability >= BARGE_IN_THRESHOLD);
});

test("early-agent speech stays fail-closed even for real words", () => {
  const r = shouldYieldToBargeIn({
    partialText: "stop, what is the price",
    agentSpeakingMs: 200,
  });
  assert.equal(r.yield, false);
});

test("heuristic score ranks backchannel below interruption", () => {
  const back = heuristicBargeInScore({ partialText: "mhm", agentSpeakingMs: 5000 });
  const real = heuristicBargeInScore({
    partialText: "wait, tell me the price again",
    agentSpeakingMs: 5000,
  });
  assert.ok(back < real);
});

test("reply action: filler while tools work, reply on settled final", () => {
  assert.equal(
    chooseReplyAction({ hasFinal: false, silenceMs: 100, toolActive: true }).action,
    "play_filler",
  );
  assert.equal(
    chooseReplyAction({ hasFinal: true, silenceMs: 900, toolActive: false }).action,
    "reply_now",
  );
  assert.equal(
    chooseReplyAction({ hasFinal: false, silenceMs: 50, toolActive: false }).action,
    "wait_300ms",
  );
});

test("tool gate allows named tools, blocks empty names", () => {
  assert.equal(
    shouldAllowToolCall({ name: "lookupLead", transcriptTail: "price?" }).allow,
    true,
  );
  assert.equal(shouldAllowToolCall({ name: "", transcriptTail: "" }).allow, false);
});

test("requestVoiceJudge falls back fail-closed when the route is down", async () => {
  const failingFetch = async () => {
    throw new Error("network down");
  };
  const r = await requestVoiceJudge(
    "barge-in",
    { partialText: "uh-huh", agentSpeakingMs: 4000 },
    { fetchImpl: failingFetch as typeof fetch, timeoutMs: 50 },
  );
  assert.equal(r.source, "fallback");
  // Fail-closed: unsure backchannel must not cut the agent off.
  assert.equal(r.decision, "keep-speaking");
});

test("requestVoiceJudge honors server decision on success", async () => {
  const okFetch = async () =>
    new Response(JSON.stringify({ decision: "yield", probability: 0.91 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const r = await requestVoiceJudge(
    "barge-in",
    { partialText: "stop now", agentSpeakingMs: 4000 },
    { fetchImpl: okFetch as typeof fetch, timeoutMs: 500 },
  );
  assert.equal(r.source, "jev");
  assert.equal(r.decision, "yield");
  assert.equal(r.probability, 0.91);
});

test("filler pool is non-empty and agent-voiced", () => {
  assert.ok(FILLER_POOL.length >= 3);
  for (const line of FILLER_POOL) assert.ok(line.length <= 60);
});
