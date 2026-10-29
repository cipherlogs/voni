# Audition clips

The picker plays `public/voices/<voice>.mp3` — "the voice you auditioned is the
voice you get". These files are **generated, never hand-captured**, by
`scripts/render-audition-clips.mts` (`npm run voice:clips`). `clips.json` is the
record of what that run rendered and measured; the test in
`src/lib/demo/audition-clips.test.ts` reads it without a live call.

## Run it when a greeting or a voice changes

```bash
cd voni
npm run voice:clips             # every catalog voice
npm run voice:clips -- --check  # no credentials: plan vs evidence vs bytes
```

`--check` fails when a greeting or the voice catalog changed but the clips did
not, when an asset is missing or was not produced by the script, or when a
committed file's bitrate is below the surviving floor. The unit test fails on
the same drift, so a greeting change cannot quietly leave a stale preview.

## What a clip is

- **The line the agent speaks.** `VONI_GREETINGS[voice.languageCode]`, which is
  `voniConfig(voice).greeting` — the greeting on the stored agent body. A clip
  is never a different sentence and never a fallback to English.
- **The voice's own Locale.** A voice speaks exactly one Locale
  ([CONTEXT.md](../../../CONTEXT.md), *Voice binding*). The ten English voices
  are English clips; `lola` is Spanish, `estelle` French, `juergen` German,
  `giovanni` Italian, `rafael` Portuguese.
- **The same source the agent speaks through.** A silent-greeting Voice Agent
  session (`src/lib/voice/silent-greeting.ts`) with the voice and the greeting
  as its only output configuration. The session's own confirmation shows
  `output.volume: null`; there is no gain, limiter or normalisation anywhere in
  the path. The native PCM render is written under `.voice-clips/` (gitignored).
- **Native level.** The encoder only changes format. The committed MP3's
  measured level is checked against the native render it came from; the deleted
  client gain table moved voices by up to 12 dB, so a baked-in copy cannot pass.
- **160 kbps mono at 24 kHz.** MPEG-2 Layer III's ceiling at the session's own
  rate. The generator decodes the committed file, re-encodes it at the 128 kbps
  delivery bitrate, and records that the level and the waveform's crest survive
  it. The old captures were 64 kbps second encodes.

`level.referenceIntegratedLufs` is the standalone TTS measurement from
`evidence/voice-levels/levels.json`, when the voice has one. It is **audit
only**: the session and TTS paths normalise a voice differently by −3.2 … +5.2
LU, so it is not the clip's level target.

## Regeneration take (ticket 39)

`takes/anna-en.json` + `takes/anna-en.wav` are one **fresh take** of anna's
English greeting, rendered through the same silent-greeting session after
`public/voices/anna.mp3` was committed. The unit test in
`src/lib/demo/clip-regeneration.test.ts` loads the take, encodes it with the
generator's encoder, measures it, and compares it with the committed clip:

- identity — the voice, its own Locale, and the greeting the agent speaks;
- duration within `AUDITION_REGENERATION_DURATION_RATIO` (5%);
- level within `AUDITION_REGENERATION_LEVEL_TOLERANCE_LU` (1 LU);
- crest within `AUDITION_REGENERATION_CREST_TOLERANCE_DB` (3 dB);
- plus ticket 38's format, native-level, bitrate and delivery re-encode checks.

The take is committed because the vendor's synthesis is nondeterministic: three
takes of the same line measured 5 630, 5 770 and 6 360 ms, and only the 5 770 ms
take is inside the 5% ratio against the committed clip's 6 024 ms. CI therefore
measures one fixed sample on every run, while the two rejected durations are
kept in the evidence and driven through the comparison to prove the ratio can
fail.

No token, socket or credential is used by the test. **ffmpeg is the only
prerequisite**: absent locally it is a named skip, absent in CI it is a named
failure. The test fails — never skips — when the committed clip, its evidence
record or the take (or its hash) is missing.

Refresh the take when the greeting or the voice changes, with
`npm run voice:reference -- --voice anna --out-dir <empty dir>`, then update
`takes/anna-en.json` (file name, sha256, duration) and the line hash together.

## Previews are covered by the clip test (ticket 79)

The picker's preview is gated per voice, not only for the featured voice.
`src/lib/demo/preview-clips.ts` checks all sixteen offered previews against
their voice binding: one voice, its own Locale, its own `/voices/<id>.mp3`, the
greeting the agent speaks, the recorded 24 kHz mono bitrate, and the native
level from this evidence file. `src/lib/demo/preview-clips.test.ts` drives it.

The frame facts and the evidence record need no decoder and no credential. The
stronger leg decodes the committed bytes and re-measures their level (catching
a swapped file); it needs ffmpeg, which is a named skip locally and a named
failure in CI. A preview whose Locale or level does not match its voice fails by
name — `voice "juergen" (de): speaks English, not its own Locale de`.

## Pending voices

A voice the generator cannot render gets **no audio** — no placeholder, no
stale file, no silence. `clips.json` lists it under `pending` with the reason
and the exact command to finish it:

```json
{
  "voice": "juergen",
  "locale": "de",
  "reason": "…",
  "command": "cd voni && npm run voice:clips -- --voice juergen"
}
```

`npm run voice:clips -- --strict` exits non-zero while anything is pending, for
CI. Ordinary runs print the pending list and keep the voices they could render.
