# Cascade clips

One native clip per bound demo voice: the real greeting, in the voice's own
Locale, at the level the voice speaks. These are the cascade's clips, not the
managed picker's: `public/voices/<voice>.mp3` is untouched, because a cascade
clip is a new native render and never a silent swap.

**Producer:** `voice-pipeline/scripts/render_clips.py` — the only writer of
`public/voices/cascade/*.wav` and `clips.json`.

```bash
cd voice-pipeline
python scripts/render_clips.py                 # with ASSEMBLYAI_API_KEY
python scripts/render_clips.py --voice lola    # finish one voice
python scripts/render_clips.py --check         # no key: plan vs evidence vs bytes
python scripts/render_clips.py --check --strict  # fail while a Locale is open
```

## What a clip is

- **The call's own synthesis.** `cascade.reference_render` over
  `cascade.assemblyai_tts.AssemblyAIStreamingTTS` — the same WebSocket
  endpoint (`wss://tts.us.assemblyai.com/v1/ws`), model (`assemblyai-tts-1`),
  transport format (24 kHz mono `pcm_s16le`) and voice binding the call uses.
  There is no STT, LLM, browser or platform in the path.
- **The line the call speaks.** `VONI_GREETINGS[locale]` from
  `voni/src/lib/demo/voni-agent.ts`. The plan restates it and the test compares
  the two, so a greeting change fails the plan instead of leaving a stale clip.
- **Native level.** The synthesis bytes are written verbatim into a PCM16 WAV:
  no gain, no limiter, no normalisation, no `output.volume`. The cascade has no
  gain stage; a level change is a new render, not a client setting.
- **Pinned.** `clips.json` records endpoint, model, voice, Locale, vendor
  language, line and its sha256, the file's sha256, the native format and the
  measured sample peak/RMS. `--check` recomputes all of it from the committed
  bytes, so a hand-edited, swapped or gain-processed file fails by name.

## Open and blocked voices

`juergen`/de is an **open Locale**: the catalogue offers the voice, the vendor
does not serve it (`422 voice_not_found`), so the plan keeps a named open row
with no clip. It is never re-cast to a voice bound to another Locale and never
dropped; ticket 130 owns the re-cast. `/de` therefore blocks cutover and
`--check --strict` exits non-zero.

A bound voice whose render fails today gets a **blocker row** with the reason
and the exact command, and its old asset is removed. Without
`ASSEMBLYAI_API_KEY` the script writes nothing at all — no manifest, no
placeholder, no stale file — and fails naming the key. No audio is ever
fabricated.
