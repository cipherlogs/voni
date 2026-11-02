# Scenario soundscapes

A scenario names a soundscape `id`; the adapter mixes the corresponding 24 kHz
mono PCM16 bed under the caller. The id is data, and an uncommitted id is a
named refusal, never digital silence wearing another name.

| Id | Committed media | What it is |
| --- | --- | --- |
| `quiet-room` | none (the adapter passes `null`) | Digital silence: the mixer adds nothing. It is a control condition, **not** a television or room bed. |
| `television` | `voni/evidence/soundscapes/television.wav` + `television.json` | A 30 s, 24 kHz mono PCM16 excerpt of the owner-supplied television audio. The protocol seam mixes it under the caller's uplink; the browser harness loops it into the synthetic mic's bus. It is ambience, never evidence of Voni's own audio. |

## The television bed

`voni/scripts/lib/soundscapes.ts` loads the committed pair by id and validates
the sidecar's id, file name, rate (24 kHz), channels (mono), bit depth (PCM16),
duration and sha256 against the decoded WAV. It never resamples: a file at
another rate is refused by name. `demo:verify` and `demo:certify:browser` load
the map once and pass it as the adapter's `soundscapes`; `soundscape-television`
and the four `locale-television-*` scenarios can then run. A scenario that names
an id the loader does not hold still refuses `soundscape:<id>` by name, and
`quiet-room` stays digital silence.

The bed's provenance and the owner's rights decision are recorded in
`television.json` and in `docs/agents/demo-verification.md`.

## Second voice and speakerphone

`second-voice` and `speakerphone` are held-out *caller* conditions. They use the
one committed TTS caller voice and the `quiet-room` soundscape: the second
speaker and the speakerphone are in the script's words, not in separate takes or
a speakerphone transfer function. That is the scenario's scope today; an
acoustic second voice or a speakerphone channel is a Studio/browser-adapter
take, and no claim of acoustic simulation is made until those takes exist.
