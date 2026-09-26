import test from "node:test";
import assert from "node:assert/strict";
import { buildInlineSessionUpdate, VoiceSession } from "./session";

(globalThis as unknown as { WebSocket: unknown }).WebSocket = { OPEN: 1 };

test("inline sessions never send turn_detection: it switches off adaptive end-of-turn", () => {
  // Any turn_detection object, even interruption_delay alone, measured
  // ~2s slower per reply. See ADAPTIVE_TURNS in ./session.ts.
  const update = buildInlineSessionUpdate({
    mode: "inline",
    systemPrompt: "p",
    greeting: "hi",
    voiceId: "v",
  }) as { input: Record<string, unknown> };
  assert.equal("turn_detection" in update.input, false);
});

test("bound demo agents get recognition tuning, never turn_detection, after session.ready", () => {
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
        transcription_mode: "balanced",
        voice_focus: "near-field",
      },
    },
  });
  handle({ type: "session.updated" });
  // A resume re-emits session.ready; the server keeps config, so no resend.
  handle({ type: "session.ready", session_id: "sess_1" });
  assert.equal(sent.length, 1);
});
