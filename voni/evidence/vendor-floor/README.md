# Vendor floor — `anna` / English

Committed evidence for `.scratch/voice-parity/issues/18-vendor-capture.md`: the
vendor's own rendering of one line in one voice, captured outside any
conversation. This is the floor every subject must clear in the comparator
(ticket 19) — parity means **at least as good as the vendor**, never merely
different from before.

This is the one committed audio capture. Reference, platform and delivered
captures stay gitignored working files; the floor is committed because a gate
that points at a regenerated file is a gate that cannot fail.

## The capture

| field | value |
| --- | --- |
| voice | `anna` (`aai-anna`, British English, the featured demo voice) |
| locale | `en` |
| line | `Hi, I'm Voni! Let's try something cool: I'll show you what I can do while we talk. Ready?` |
| date | `2026-10-29` |
| how | `POST https://tts.us.assemblyai.com/v1/speech`, buffered (`stream=false`), `container=wav`, `encoding=pcm_s16le`, `sample_rate=24000`, `language=english`, request `0121e472-b089-493f-9b59-dc135e2eec63` |
| vendor model | `assemblyai-tts-1` |
| file | `anna-en.wav` — 5.84 s, 24 000 Hz, mono, 16-bit PCM WAV, 280 364 bytes |
| sha256 | `239b589943f66aa5d89be5a6b1b77416aa06d87a2e41389d5db1132d7ef3bd25` |

The line is `VONI_GREETINGS.en` — the most-heard sentence in the product, and
the one the first subject (`anna`, ticket 60) is re-proved on. Deciding the
line at capture time is what makes the floor comparable to a reference
rendering: both speak the same text in the same voice.

**What "playground" means here.** The vendor's browser playground and this
capture drive the same text-to-speech engine; this file is that engine's
render with no client, platform or model in the path, so it is the vendor's
output rather than ours. It was produced by a checked-in script and is
reproducible with the command below. A literal dashboard-playground recording
is still accepted — it would replace this file as `method:
"playground-recording"` with the owner's own provenance, using the same
command (see [Owner-supplied capture](#owner-supplied-capture)).

## Reproduce

```bash
cd voni
npm run voice:vendor-floor -- --voice anna --locale en --force
```

`--force` is required to replace an existing floor: a recapture is a new
evidence record, and the commit message must say why. Without it the script
refuses and names the existing pair.

## Load

`voni/src/lib/audio/vendor-floor.ts` (`loadVendorFloor`) is the only reader.
It validates the sidecar (`voice`, `locale`, `line`, `capturedOn`, `producedBy`,
`method`, `vendor`, `audio` facts and sha256) and decodes the WAV with the same
`decodeWav` the comparison uses on every capture. There is no empty state:

| refusal | code |
| --- | --- |
| WAV or sidecar absent | `vendor-floor-missing` |
| sidecar missing a field, unparseable, wrong voice/locale, impossible date | `vendor-floor-sidecar-invalid` |
| file unreadable or not PCM16 WAV | `vendor-floor-unreadable` |
| sha256 or declared format disagrees with the audio | `vendor-floor-audio-mismatch` |

Every message names the path and the command that produces a real floor.

## Measured baseline (W0 comparison)

The floor read through `voni/src/lib/audio/level-facts.ts`,
`distortion-crest.ts`, `spectral-balance.ts` and `breakups.ts`:

| axis | floor |
| --- | --- |
| integrated loudness | −20.04 LUFS |
| RMS | −20.04 dBFS |
| true peak | −4.44 dBTP |
| crest factor | 6.01 |
| breakups | 0 (no inserted silence) |
| band spread | 37.4 dB |

These are readings of the floor, not new budget thresholds; the frozen budget
table is untouched. A subject is "worse than the floor" when a comparator axis
says so (ticket 19), not when a number here is copied into a threshold.

Note the vendor's own render of `anna` is louder than the −23.1 LUFS the old
audition clips were measured at. That is a fact about the old clips (pre-gained
and re-encoded by hand), not a target: the floor is the audio the owner called
superb, and it is this file.

## Owner-supplied capture

If the floor must be a literal browser-playground recording instead of the
engine render, supply the audio and state how it was made:

```bash
cd voni
npm run voice:vendor-floor -- \
  --voice anna --locale en --force \
  --from-recording ~/playground-anna-en.wav \
  --captured-on 2026-10-29 \
  --produced-by "AssemblyAI dashboard TTS playground, Chrome tab capture, <who>"
```

Requirements for the supplied file:

- any container/codec `ffmpeg` can read; the script normalises it to mono
  24 000 Hz 16-bit PCM WAV (what `lib/audio/format-facts` accepts);
- the exact line above, spoken by `aai-anna`, nothing else in the recording;
- `--captured-on` and `--produced-by` are mandatory, so the sidecar always
  records the date and the human capture method.

The script refuses a voice/locale pair the catalog does not bind: a voice
speaks exactly one Locale.
