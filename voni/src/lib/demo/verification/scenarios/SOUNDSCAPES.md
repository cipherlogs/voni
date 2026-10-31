# Scenario soundscapes

A scenario names a soundscape `id`; the adapter mixes the corresponding 24 kHz
mono PCM16 bed under the caller. The id is data, and an uncommitted id is a
named refusal, never digital silence wearing another name.

| Id | Committed media | What it is |
| --- | --- | --- |
| `quiet-room` | none (the adapter passes `null`) | Digital silence: the mixer adds nothing. It is a control condition, **not** a television or room bed. |
| `television` | **none** | The `soundscape-television` scenario exists so the gap is visible. No television/background PCM asset is committed, so the protocol adapter refuses `soundscape:television` by name (`missing-soundscape`) before any vendor opens. |

## The television gap (ticket 14)

The spec's soundscape class asks the agent to handle background television
(visitor story 10), but no television PCM exists in the repository. Ticket 14
does not substitute `quiet-room`: that would report a clean call that never had
a television in it. Instead:

- `soundscape-television/scenario.json` names `television`;
- the protocol adapter's preflight refuses the id by name and opens no call;
- `class-corpus.test.ts` pins both facts, and
  `scripts/lib/protocol-adapter/runner.test.ts` proves the refusal.

**To close it:** commit a small, hashed 24 kHz mono PCM16 bed (with its sha256 in
a record beside it), add it to the adapter's soundscape map, and run the
scenario. Do not map an uncommitted id to `quiet-room`.

## Second voice and speakerphone

`second-voice` and `speakerphone` are held-out *caller* conditions. They use the
one committed TTS caller voice and the `quiet-room` soundscape: the second
speaker and the speakerphone are in the script's words, not in separate takes or
a speakerphone transfer function. That is the scenario's scope today; an
acoustic second voice or a speakerphone channel is a Studio/browser-adapter
take, and no claim of acoustic simulation is made until those takes exist.
