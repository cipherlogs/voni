/**
 * The end document decides whether a call existed. A call that died in the
 * opening handshake measured nothing and is re-made once; a call that opened a
 * leg and then failed is a result to judge, never a retry.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { endDocumentPath, readCallOutcome } from "./call-outcome";

function writeEnd(doc: unknown): { endPath: string; eventsDir: string; callId: string } {
  const root = mkdtempSync(join(tmpdir(), "dv-call-outcome-"));
  const endPath = join(root, "call.end.json");
  writeFileSync(endPath, typeof doc === "string" ? doc : JSON.stringify(doc));
  return { endPath, eventsDir: root, callId: "abc" };
}

const NO_LEG_OPENED = {
  endedBy: "error",
  error: { name: "TimeoutError", message: "timed out during opening handshake", stage: "open" },
  providers: {
    stt: { provider: null, reason: "the call ended before this leg opened" },
    llm: { provider: null, reason: "the call ended before this leg opened" },
    tts: { provider: null, reason: "the call ended before this leg opened" },
  },
};

test("a call that died in the opening handshake with no leg opened measured nothing", () => {
  const outcome = readCallOutcome(writeEnd(NO_LEG_OPENED));
  assert.equal(outcome.kind, "no-session");
  assert.match(outcome.detail, /opening handshake/);
});

test("a call that spoke a turn and then lost a leg is a measured result", () => {
  const outcome = readCallOutcome(
    writeEnd({
      ...NO_LEG_OPENED,
      error: { ...NO_LEG_OPENED.error, stage: "stop" },
      turns: 2,
    }),
  );
  assert.equal(outcome.kind, "measured");
  assert.match(outcome.detail, /2 turn\(s\)/);
});

test("a synthesis refusal before the greeting measured nothing, even though speech opened", () => {
  // Run en-1: STT opened, TTS refused with a session-rate error at stage open,
  // zero turns. The agent never spoke, so no property observed anything.
  const outcome = readCallOutcome(
    writeEnd({
      endedBy: "error",
      turns: 0,
      error: {
        name: "SynthesisHandshakeError",
        message:
          "synthesis session refused before Begin: Error 3009: Too many sessions opened for this account in the last minute",
        stage: "open",
      },
      providers: {
        stt: { provider: "meta", reason: "Meta realtime speech is the cascade's speech rung" },
        llm: { provider: null, reason: "the call ended before this leg opened" },
        tts: { provider: null, reason: "the call ended before this leg opened" },
      },
    }),
  );
  assert.equal(outcome.kind, "no-session");
  assert.match(outcome.detail, /before any turn was spoken/);
});

test("an error after the greeting but before any turn still measured nothing", () => {
  const outcome = readCallOutcome(
    writeEnd({ ...NO_LEG_OPENED, error: { ...NO_LEG_OPENED.error, stage: "stream" }, turns: 0 }),
  );
  assert.equal(outcome.kind, "no-session");
});

test("an error after the opening stage is a measured result, not an absent call", () => {
  const outcome = readCallOutcome(
    writeEnd({
      ...NO_LEG_OPENED,
      error: { ...NO_LEG_OPENED.error, stage: "stream" },
    }),
  );
  assert.equal(outcome.kind, "measured");
});

test("a call that ended normally is a measured result", () => {
  const outcome = readCallOutcome(writeEnd({ endedBy: "stop", providers: {} }));
  assert.equal(outcome.kind, "measured");
});

test("a missing or unreadable end document is unknown, so the default reading stands", () => {
  assert.equal(readCallOutcome({ endPath: null, eventsDir: "/nonexistent", callId: null }).kind, "unknown");
  assert.equal(
    readCallOutcome({ endPath: "/nonexistent/call.end.json", eventsDir: "/nonexistent", callId: "abc" }).kind,
    "unknown",
  );
  assert.equal(readCallOutcome(writeEnd("{not json")).kind, "unknown");
  assert.equal(readCallOutcome(writeEnd("[]")).kind, "unknown");
});

test("the end document is found beside the events when the harness reports no path", () => {
  const root = mkdtempSync(join(tmpdir(), "dv-call-outcome-"));
  writeFileSync(join(root, "abc.end.json"), JSON.stringify(NO_LEG_OPENED));
  const path = endDocumentPath({ endPath: null, eventsDir: root, callId: "abc" });
  assert.equal(path, join(root, "abc.end.json"));
  assert.equal(
    readCallOutcome({ endPath: null, eventsDir: root, callId: "abc" }).kind,
    "no-session",
  );
});
