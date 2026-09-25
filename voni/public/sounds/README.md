# Call sounds

Drop mp3s in `voni/public/sounds/<variant>/`, named exactly:

| File | When it plays | Spec |
|---|---|---|
| `ringback.mp3` | while connecting, looped until the agent answers | loopable 2–4s, seamless loop points, soft telephone-ring feel |
| `connected.mp3` | first agent audio — the call is live | one-shot ≤0.8s chime |
| `hangup.mp3` | normal end, either side | one-shot ≤0.8s, resolved, not alarming |
| `error.mp3` | failure, drop, rate-limit block | one-shot ≤1s, distinct from hangup |

Format: mp3 (or wav — converted at build), each <100KB, roughly −14 LUFS so
they sit under speech. Volumes are fixed in code (ringback 0.25, the rest 0.4).

The caption tick has no file: it is synthesized per strike in
`src/lib/voice/call-sounds.ts` (`strikeTick`, tuned by `TICK_FEEL`) so each
hit varies like a hammer strike — a soft wooden knock whose velocity changes
loudness, click, brightness and pitch. It strikes as words land in the live caption and once, firmer,
when the agent yields to an overlap.

A missing file is silence, never an error — the call works with zero, some,
or all files present. A second set for A/B is a second folder
(`sounds/crisp/...`) plus `NEXT_PUBLIC_CALL_SOUND_VARIANT=crisp`.

The `default` set is generated, not hand-made: `scripts/synth-call-sounds.mts`
(plain DSP → lame). Run it without flags to render all A/B/C candidates plus
an audition page; run `--pick ringback=a,connected=b,...` to write the chosen
ones here. Tweak a sound by editing its constants and re-running.
