# Handoff: demo-verification

**State:** merged to `main` at `61b8d56e` (pushed to `origin/main`, 2026-11-03). The 313-commit `demo-verification` effort is in.

## What is certified

**Nothing.** The owner accepted the voice on 2026-11-03 and explicitly skipped the full English run (129 calls), the certificate, the panel rating and the signature. Do not read this merge as a certification.

What the owner did accept, by ear and by transcript:

- the opening listens before it greets, and the caller's first sentence is heard and answered;
- a reply ends when its audio has drained, and a caller who pauses mid-sentence is answered once;
- no repeated line, question or opener; no filler acknowledgement (the hidden latency cover included);
- a casual register, chosen over the call-centre and therapy templates;
- no test offer unless the caller is willing;
- `muse-wonder-1.0` as the demo model, priced on `rates/v2.json`;
- reply latency 1.5–3.4 s measured per call, with the vendor tail named as the open item.

## Residual risks, named

- **Review gate red.** `REVIEWED_SHA` is `94bf79b4`; the merge commit has no line-by-line human review. The owner approved the merge explicitly, but that is not a code review. Resolve by reviewing the merged range and running `bash scripts/review-gate.sh --update`.
- **X4 unmeasured.** No tagged inbox email was ever sent during a live call, so the lookup and the code reply are unproven end to end. Owner action: in a live demo, send a work email to `test@voni.cc` with the tag Voni speaks, then say "sent".
- **H2 unmeasured.** One panel session cannot reach the 40-label floor; the owner decision on the label floor is still open (RR-10).
- **A5 unmeasured.** The reference render is not the same audio.
- **Spectral balance** is below the bar.
- **Model cost.** Wonder is ~3.2x input / 4.7x output over Spark; measured demo calls are ~$0.05 each, roughly double the Spark calls.

## Behaviour that is now code, not prompt hope

`cascade/turn_stream.py` owns the reply guards: no repeated line (including inside one reply), no unanswered-question loop, no offer on a non-willing turn, no filler opener. `cascade/ack.py` owns the tone-aware, uncaptioned latency cover and records the line it spoke (`turn.ack`). `cascade/call.py` owns the listen-first opening, the paced opening replay and the caller turn hold (`turn.hold_silence_ms=350`, `turn.hold_max_ms=900`). The preview mix reads the capture's own clock (`capture_started`) and refuses to guess.
