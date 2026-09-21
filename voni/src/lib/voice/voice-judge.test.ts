import test from "node:test";
import assert from "node:assert/strict";
import { decideVoiceJudge, parseVoiceJudgeRequest } from "./voice-judge";

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
