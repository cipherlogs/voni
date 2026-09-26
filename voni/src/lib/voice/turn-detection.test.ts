import test from "node:test";
import assert from "node:assert/strict";
import { buildInlineSessionUpdate, TURN_PRESET, VoiceSession } from "./session";

(globalThis as unknown as { WebSocket: unknown }).WebSocket = { OPEN: 1 };

test("turn preset: adaptive end-of-turn, server barge-in at its maximum delay", () => {
  // Fixed silence windows switch off AssemblyAI's adaptive, meaning-based
  // end-of-turn for the whole session. The session adapts the delay per
  // reply. See docs/adr/0003-barge-in-recovery.md.
  assert.deepEqual(TURN_PRESET, { interrupt_response: true, interruption_delay: 1000 });
});

test("inline sessions get the turn preset without passing it", () => {
  const update = buildInlineSessionUpdate({
    mode: "inline",
    systemPrompt: "p",
    greeting: "hi",
    voiceId: "v",
  });
  assert.deepEqual(
    (update as { input: { turn_detection: unknown } }).input.turn_detection,
    TURN_PRESET,
  );
});

test("bound demo agents get the turn preset right after session.ready", () => {
  const session = new VoiceSession();
  const sent: string[] = [];
  const internals = session as unknown as Record<string, unknown>;
  internals["ws"] = { readyState: 1, send: (m: string) => sent.push(m) };
  internals["boundAgent"] = true;
  const handle = (m: Record<string, unknown>) =>
    (session as unknown as { handle: (raw: string) => void }).handle(JSON.stringify(m));

  handle({ type: "session.ready", session_id: "sess_1" });
  assert.deepEqual(JSON.parse(sent[0]), {
    type: "session.update",
    session: {
      input: {
        transcription_mode: "max_accuracy",
        voice_focus: "near-field",
        turn_detection: TURN_PRESET,
      },
    },
  });
  handle({ type: "session.updated" });
  // A resume re-emits session.ready; the server keeps config, so no resend.
  handle({ type: "session.ready", session_id: "sess_1" });
  assert.equal(sent.length, 1);
});
