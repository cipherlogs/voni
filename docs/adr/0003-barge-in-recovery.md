# Barge-in: the server stops the agent, Voni recovers

Callers found that "okaay so" stopped Voni mid-sentence, that they had to repeat themselves, and that the opener could not be interrupted. The "smart" Jev barge-in gate we had built only sent context after the fact: the speech service decided every barge-in on its own.

## Considered Options

- **Client-owned barge-in (server `interrupt_response: false`)**: rejected after a live spike. With the server's barge-in off, speech over the agent's *audible* reply is dropped for good: no `input.speech.started`, no partials, no transcript, even 20s later. It only looked viable when the caller spoke before the agent's first audio.
- **A fixed, longer interruption delay only**: rejected by the owner ("it needs to be smart"). Filler that lasts past the delay still stops the agent, and nothing repairs a barge-in that wasn't real.
- **Server barge-in, Voni recovers (chosen)**:
  - **Delay.** The server's default. An adaptive delay (1000ms explaining, 400ms once a reply asks something) shipped first and was withdrawn, see Consequences.
  - **Recovery.** After a barge-in, the caller's words are judged:
    - Steering, content and a request to end the call are answered as a normal turn. An end-call request is never sent to Jev: an aside verdict there made Voni talk on after "hang up".
    - Filler, back-channels and echo, plus asides as judged by Jev, make the agent resume where it stopped.
  - **How a resume works.** A `reply.create` sent mid-reply supersedes the running reply within ~60ms, since the API has no `reply.cancel`. The superseded reply's late audio is dropped client-side, and its caption keeps only the words the caller heard.

## Consequences

- **The server's semantic check sets barge-in latency, not the delay.** Measured stops were 0.9–1.9s at 1000ms and 1.0–1.7s at 400ms, and 1.0–1.1s at the default.
- **Never send `turn_detection`.** Any `turn_detection` object switches off adaptive end-of-turn for the session. That includes `interruption_delay` alone and mid-call updates. Measured from the caller's last word to the reply: 3.6–4.7s with any object, 1.3–2.5s with none or `null`. The adaptive delay sent one on every reply, so it was withdrawn (owner's call: speed over the delay). Stored demo agents send `turn_detection: null`. Only the sensitive-field turn sets windows, then restores `null`.
- **"Heard so far" is exact.** `transcript.agent.delta` streams one word per event, aligned to playback (`delta`, not `text`: the session had been reading the wrong field).
- **No fixed silence windows.** They made callers repeat themselves after a pause. Calls run `balanced`, the voice-agent default. Watch for this edge: a filler said just as a fast reply starts can join the caller's previous turn, and then nothing resumes (seen 2 in 16 `filler-over` runs, 0 in 4 after the change).
- **Cut latency under load.** `stop-over` measured 1.6–2.1s while three eval batches ran at once (2026-09-27). Run alone it measured 0.89–1.08s on both the working tree and the prior commit. Cut latency is the platform's; run timing evals one at a time.
- **Evals.** `npm run eval:demo-agent` drives the real `VoiceSession` with real speech for `filler-over`, `stop-over`, `over-talk`, `greeting-cut`, `hang-up-fast` and `hang-up-over`. `npm run call:trace` shows the server's view of any call.
