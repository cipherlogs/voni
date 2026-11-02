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

test("a call that opened a leg and then failed is a measured result", () => {
  const outcome = readCallOutcome(
    writeEnd({
      ...NO_LEG_OPENED,
      providers: {
        ...NO_LEG_OPENED.providers,
        stt: { provider: "muse-voice-transcribe-1.0", reason: null },
      },
    }),
  );
  assert.equal(outcome.kind, "measured");
  assert.match(outcome.detail, /1 leg\(s\) opened/);
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
