# Barge-in: the server cuts, Voni recovers

Callers found that "okaay so" cut Voni off mid-sentence, that they had to repeat themselves, and that the opener could not be interrupted. The "smart" Jev barge-in gate we had built only sent context after the fact: the speech service decided every cut on its own.

## Considered Options

- **Client-owned barge-in (server `interrupt_response: false`)**: rejected after a live spike. With the server's barge-in off, speech over the agent's *audible* reply is dropped for good: no `input.speech.started`, no partials, no transcript, even 20s later. It only looked viable when the caller spoke before the agent's first audio.
- **A fixed, longer interruption delay only**: rejected by the owner ("it needs to be smart"). Filler that lasts past the delay still cuts, and nothing repairs a bad cut.
- **Server cuts with an adaptive delay, Voni recovers (chosen)**:
  - **Delay.** The explaining delay is the API maximum (1000ms). The opener, and any reply once it asks something, drops to 400ms.
  - **Recovery.** After a cut, the caller's words are judged:
    - Steering and content are answered as a normal turn.
    - Filler, back-channels and echo, plus asides as judged by Jev, make the agent resume where it was cut.
  - **How a resume works.** A `reply.create` sent mid-reply supersedes the running reply within ~60ms, since the API has no `reply.cancel`. The superseded reply's late audio is dropped client-side.

## Consequences

- **The server's semantic check sets cut latency, not the delay.** Measured cuts were 0.9–1.9s at 1000ms and 1.0–1.7s at 400ms. The adaptive delay mainly keeps filler from cutting explanations.
- **"Heard so far" is exact.** `transcript.agent.delta` streams one word per event, aligned to playback (`delta`, not `text`: the session had been reading the wrong field).
- **Fixed silence windows are gone from the turn preset.** They switch off adaptive end-of-turn for the whole session and made callers repeat themselves after a pause.
- **Evals.** `npm run eval:demo-agent` drives the real `VoiceSession` with real speech for `filler-over`, `stop-over`, `over-talk`, `greeting-cut` and `hang-up-fast`. `npm run call:trace` shows the server's view of any call.
