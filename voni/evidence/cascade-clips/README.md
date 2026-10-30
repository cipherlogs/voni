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

## Regeneration and vendor determinism (ticket 129)

The PR test replays a **recorded synthesis fixture**
(`voice-pipeline/cascade/fixtures/clips/<voice>-<locale>.json`) through the
call's own client and binding table — no key, no socket — and compares the
regenerated clip's binding, Locale, vendor language, text, endpoint, format and
measured level with the fixture. The fixture pins the PCM hash, the WAV hash and
the level; the loader recomputes all three from the frames, so a changed frame
fails by fixture name.

Byte identity is **measured, never assumed**: the fixture is replayed at least
twice and only a byte-identical render sets `byteIdentityRequired`. A byte
difference with matching binding and level is not a failure.

A live regeneration is key-gated: without `ASSEMBLYAI_API_KEY` it returns a
named blocker and writes nothing. A live take is recorded as evidence
(`clip-regeneration` document: endpoint, format, sha256, level, determinism),
never swapped in as the committed asset.

## Previews are these clips (ticket 132)

The picker's cascade preview *is* the clip: `/voices/cascade/<voice>.wav`, the
same asset the synthesis endpoint rendered at native level and the same row this
manifest records. There is no second renderer. The clip gate therefore covers
every preview:

- a preview file on disk with no manifest row fails by name (a hand capture or
  a silent swap, never a preview the clip test checked);
- a preview whose bytes no longer match its recorded sha256 fails by name;
- a preview whose Locale or level disagrees with its voice fails by name;
- an open Locale (`juergen`/de) has no preview URL and keeps no asset.

The managed picker's `public/voices/<voice>.mp3` is untouched. The
`voice-preview` route's old claim that the vendor offers no standalone synthesis
was wrong: AssemblyAI does offer streaming TTS, and these clips come from it. The
route's real rationale is that it is not a second renderer — a preview is a
committed, hash-pinned native clip, not audio synthesized per request.


