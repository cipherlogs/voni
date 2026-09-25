import test from "node:test";
import assert from "node:assert/strict";
import {
  BARGE_IN_THRESHOLD,
  FILLER_POOL,
  chooseReplyAction,
  heuristicBargeInScore,
  requestVoiceJudge,
  shouldAllowToolCall,
  shouldFlagOffTrack,
  shouldYieldToBargeIn,
} from "./jev-judges";

test("backchannel never yields (fail-closed)", () => {
  for (const text of ["uh-huh", "um", "uhm", "mhm", "okay", "right", "got it"]) {
    const r = shouldYieldToBargeIn({ partialText: text, agentSpeakingMs: 3000 });
    assert.equal(r.yield, false, text);
  }
});

test("bare yes/yeah never hard-cuts at partial stage (soft-confirm on the final)", () => {
  for (const text of ["yes", "yeah"]) {
    const r = shouldYieldToBargeIn({ partialText: text, agentSpeakingMs: 3000 });
    assert.equal(r.yield, false, text);
  }
});

test("command words yield even as single words (steering must be heard)", () => {
  for (const text of ["no", "stop", "wait", "repeat", "hold on", "nope"]) {
    const r = shouldYieldToBargeIn({ partialText: text, agentSpeakingMs: 3000 });
    assert.equal(r.yield, true, text);
    assert.ok(r.probability >= BARGE_IN_THRESHOLD, text);
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

test("speculative nav allows confident routes, suppresses weak ones", async () => {
  const { shouldAllowSpeculativeNav } = await import("./jev-judges");
  assert.equal(
    shouldAllowSpeculativeNav({ partialText: "open settin", candidateRoute: "/settings", confidence: 0.85 }).allow,
    true,
  );
  assert.equal(
    shouldAllowSpeculativeNav({ partialText: "open sett", candidateRoute: "/settings", confidence: 0.65 }).allow,
    true,
  );
  assert.equal(
    shouldAllowSpeculativeNav({ partialText: "uh", candidateRoute: "/settings", confidence: 0.3 }).allow,
    false,
  );
  assert.equal(
    shouldAllowSpeculativeNav({ partialText: "open settin", candidateRoute: "", confidence: 0.9 }).allow,
    false,
  );
});

test("off-track fallback flags nonsense, never a genuine short answer", () => {
  const goal = "Talk about their business.";
  const flag = (userText: string) =>
    shouldFlagOffTrack({ goal, agentLine: "Sound good?", userText }).offTrack;
  for (const text of ["hahaha lol", "asdfgh qwrtz", "blah blah blah blah", "poop poop"]) {
    assert.equal(flag(text), true, text);
  }
  for (const text of ["Sure", "yes", "Hi", "ha", "We run a dental clinic in Dubai.", "haha okay, we sell cars", "", "Hmm, let me think", "hmmm", "since 2019"]) {
    assert.equal(flag(text), false, text);
  }
});

test("off-track judge falls back to the heuristic when Jev is unreachable", async () => {
  const r = await requestVoiceJudge(
    "off-track",
    { goal: "Talk about their business.", agentLine: "", userText: "lol lol lol" },
    { fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch },
  );
  assert.equal(r.source, "fallback");
  assert.equal(r.decision, "off-track");
});

test("off-track judge sends the demo call bearer", async () => {
  let auth: string | null = null;
  await requestVoiceJudge(
    "off-track",
    { goal: "g", agentLine: "", userText: "hi" },
    {
      headers: { Authorization: "Bearer call-tok" },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        auth = new Headers(init.headers).get("authorization");
        return new Response(JSON.stringify({ decision: "on-track", probability: 0.1 }));
      }) as typeof fetch,
    },
  );
  assert.equal(auth, "Bearer call-tok");
});
