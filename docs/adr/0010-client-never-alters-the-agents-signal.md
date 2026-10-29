# The client never alters the agent's signal

The browser playback path applied a per-voice linear gain and a `tanh` soft knee in the int16 domain, derived from loudness measured on preview mp3s that were replaced with pre-gained copies in the same commit that introduced the gain. It also never ran: `start()` reset the gain to `1.0` after the caller set it, so every voice played at native level while the code implied a match that has never existed.

We decide the playout owns **timing only** — jitter buffering, resampling, and fades at true boundaries. It never owns level. Loudness matching, where we want it, is set on the server through `output.volume` and proven by measuring the delivered signal. Any nonlinear processing of the agent's voice in the browser is a bug, not a tuning knob.

## Consequences

- The gain table and `VOICE_PLAYBACK_GAIN` are deleted rather than repaired. A voice that measures wrong is a server-configuration or asset problem.
- Loudness is not "matched" by a formula. The only acceptable evidence is a measurement of what the caller heard, so the eval harness must capture the browser's own output through a tap after the playout worklet; the server's session recording never contains client processing and cannot answer this question.
- The playout's remaining job is the harder one: hold a target cushion, correct drift slowly enough to be inaudible, and fade only when a reply truly begins or ends. Anything that reshapes the waveform to protect against a click is out of bounds.
- A per-voice level change now means changing the agent body, which is fingerprinted and refreshed — so a loudness fix is deployable and auditable instead of a client constant nobody can verify.
