# Per-voice output level — measured reference

Committed evidence for `.scratch/voice-parity/issues/37-stored-body-level.md`:
each offered voice's native reference loudness, and the `output.volume` the
stored agent body carries for it.

A voice's level is a field on the stored body (`output.volume`), not a client
gain. The browser alters timing only (ticket 36), so this file is where a level
decision is auditable: the number on the body, the measured audio behind it,
the date, and the command that reproduces the measurement.

## Why the target is the voice's own reference

The level a caller should hear is the voice's **reference render** — the
vendor's own audio of the line the agent speaks, at native level, with no
client, platform or model in the path (`src/lib/demo/reference-render.ts`).
The timbre gate compares Delivered audio against that file at 0.20 LU (ticket
16). `output.volume` is an attenuation: the platform caps it at 100, the
native reference, so it can never boost.

The decision, therefore:

| measured delivered vs reference | `output.volume` |
| --- | --- |
| equal (native is the target) | `100` |
| delivered louder than reference | `100 · 10^(−ΔdB/20)` |
| delivered quieter than reference | `100`, reported — no boost exists |

The old client gain table was the defect this ticket removes: it matched
voices to *each other* from audition previews. Level is now decided per voice
against that voice's measured reference, and nothing in the browser changes it.

## The measurement

| field | value |
| --- | --- |
| date | `2026-10-29` |
| method | `POST https://tts.us.assemblyai.com/v1/speech`, `stream=false`, `container=wav`, `encoding=pcm_s16le`, `sample_rate=24000`, each voice's own greeting in its own Locale |
| takes | 3 renders per voice; the recorded loudness is the median |
| measured with | `src/lib/audio/level-facts.ts` (BS.1770-4 gated integrated loudness, 4× true peak) |
| anna floor (separate baseline) | `evidence/vendor-floor/anna-en.wav`, −20.04 LUFS (ticket 18) |
| file | `levels.json` — every take, the median, the loudest true peak and the volume |
| reproduce | `cd voni && npm run voice:levels` (writes `levels.json`; `--force` replaces an existing record) |

Measured medians run from −20.11 (`anna`) to −26.41 (`rafael`) LUFS, a spread
of about 6 dB. **Each voice is measured against its own reference render, not
against `anna`.** The anna floor is a single-voice vendor baseline from
ticket 18; comparing a voice to it is not a cross-voice parity claim, and the
~6 dB spread is expected native variation, not a level defect. No take clips
(loudest true peak −1.48 dBTP, `paul`), and `output.volume` is
attenuation-only. Since each voice's native reference is already its target,
no voice needs attenuation and none may be boosted: **`volume = 100` for
every measured voice**. That is the measured decision, not an untouched
default.

German was re-cast from `juergen` (the TTS endpoint answered `422
voice_not_found`) to `jorg`, whose native reference was measured on 2026-10-30
at −24.93 LUFS (worst true peak −5.96 dBTP). Every offered voice now has a
measured row, so `UNMEASURED_VOICE_LEVELS` is empty; the visible-unmeasured
mechanism remains for a future voice the endpoint cannot serve, and an
unmeasured voice never passes on a default.

## Registry

`voni/src/lib/agents/voice-levels.ts` holds the same numbers and is the only
source the demo and tenant builders read. `voices.test.ts` compares the
registry against this file, so neither can move alone: a recapture is a new
evidence record and a reviewed registry change, never a silent retune.
