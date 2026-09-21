import test from "node:test";
import assert from "node:assert/strict";
import {
  decideVoiceJudge,
  JUDGE_GATEWAY_URL,
  JUDGE_MODEL,
  parseVoiceJudgeRequest,
  resolveJudgeApiKey,
  resolveJudgeGatewayUrl,
  resolveJudgeModel,
} from "./voice-judge";

test("rejects unknown kinds and bad bodies", () => {
  assert.equal(parseVoiceJudgeRequest(null).ok, false);
  assert.equal(parseVoiceJudgeRequest({ kind: "nap", state: {} }).ok, false);
  assert.equal(parseVoiceJudgeRequest({ kind: "barge-in" }).ok, false);
});

test("accepts all three judge kinds", () => {
  for (const kind of ["barge-in", "reply", "tool"] as const) {
    const parsed = parseVoiceJudgeRequest({ kind, state: {} });
    assert.equal(parsed.ok, true);
  }
});

test("heuristic decide is fail-closed on backchannel", () => {
  const r = decideVoiceJudge("barge-in", { partialText: "mhm", agentSpeakingMs: 5000 });
  assert.equal(r.decision, "keep-speaking");
  assert.equal(r.source, "heuristic");
});

test("heuristic decide yields on real interruption", () => {
  const r = decideVoiceJudge("barge-in", {
    partialText: "stop, what does it cost per month",
    agentSpeakingMs: 5000,
  });
  assert.equal(r.decision, "yield");
});

test("heuristic decide plays filler while tools are active", () => {
  const r = decideVoiceJudge("reply", { hasFinal: false, silenceMs: 100, toolActive: true });
  assert.equal(r.decision, "play_filler");
});

test("heuristic decide denies empty tool names", () => {
  const r = decideVoiceJudge("tool", { name: "", transcriptTail: "" });
  assert.equal(r.decision, "deny");
});

test("gateway URL defaults to the Vercel AI Gateway evaluate endpoint", () => {
  assert.equal(resolveJudgeGatewayUrl({}), JUDGE_GATEWAY_URL);
  assert.match(JUDGE_GATEWAY_URL, /ai-gateway\.vercel\.sh\/v1\/evaluate/);
  assert.equal(
    resolveJudgeGatewayUrl({ VOICE_JUDGE_GATEWAY_URL: "https://x/y" }),
    "https://x/y",
  );
});

test("the existing AI gateway key wins over the judge-specific one", () => {
  assert.equal(
    resolveJudgeApiKey({ AI_GATEWAY_API_KEY: "a", VOICE_JUDGE_API_KEY: "b" }),
    "a",
  );
  assert.equal(resolveJudgeApiKey({ VOICE_JUDGE_API_KEY: "b" }), "b");
  assert.equal(resolveJudgeApiKey({}), undefined);
});

test("judge model defaults to typesafe-ai/jev", () => {
  assert.equal(resolveJudgeModel({}), JUDGE_MODEL);
});
