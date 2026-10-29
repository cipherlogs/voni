# The PSTN bridge stays a second implementation, pinned by behaviour

A dashboard live call runs `telephony-bot/server.py`, a second call engine beside the browser's `VoiceSession`. It has its own barge-in (no unheard-tail resume), its own goodbye drain (an estimate of unplayed audio, not the polled handshake), and its own sensitive-capture windows that disagree with the stored body (`max_silence` 500 against the body's 1000). A browser call and a phone call to the same agent therefore behave differently, and one of them is the one customers pay for.

True single-source-of-truth means folding the bridge into the shared engine. We deliberately do not do that yet: the bridge is the only path with no harness that can measure it, so a rewrite would be the untested path changing first, and it would sit in front of every locale fix. Instead the bridge keeps its own code and is pinned to the same behaviour: the stored body carries the turn preset, and the polled goodbye drain and unheard-tail barge-in resume are ported and covered by the same behavioural tests. Folding it into the shared engine remains the target.

## Consequences

- Until the fold-in, a new session mechanic is specified once and implemented twice. That cost is real and is why the fold-in is on record rather than forgotten.
- Anything measured only in the browser is not proven for phone calls. PSTN parity claims need their own evidence, not a browser artifact.
- Barge-in *latency* stays the platform's, not ours, on both paths (ADR-0003).
