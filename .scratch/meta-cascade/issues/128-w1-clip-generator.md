# 128: Clips rendered from the same endpoint and binding table

**What to build:** A checked-in script renders each voice's real greeting in its own Locale at native level, from the same synthesis endpoint and binding table the call uses.

**Blocked by:** 120 (W0 reference render from direct synthesis)

**Status:** resolved

- [ ] A checked-in script renders each voice's real greeting in its own Locale at native level.
- [ ] The render uses the same synthesis endpoint and binding table as the call.
- [ ] A clip whose voice, Locale, text, format or measured level disagrees with its binding fails.
- [ ] A clip is never hand-edited and never sourced from another voice.

## Answer

# 128 — clips rendered from the same endpoint and binding table

- New `voice-pipeline/cascade/clips.py` + checked-in `scripts/render_clips.py`: the clip plan is the six demo voices; each renders its own Locale's greeting (`VONI_GREETINGS`, drift-tested against `voni-agent.ts`) through `reference_render` — the call's `AssemblyAIStreamingTTS`, `bind_voice`, browser transport (24 kHz mono `pcm_s16le`), model `assemblyai-tts-1` — and the synthesis bytes are written verbatim, so no gain, limiter or normalisation can enter a clip.
- German is explicit: `juergen`/de is a named **open** row carrying the binding's own refusal, with no asset, never re-cast to another Locale and never dropped. `--strict` fails while it stays open; ticket 130 owns the re-cast.
- The manifest pins endpoint, model, voice, Locale, vendor language, line + sha256, asset sha256, native format and measured level (sample peak/RMS). `--check` re-derives all of it from the committed bytes and fails a clip whose voice, Locale, text, format, endpoint/model or level disagrees; a clip for the open Locale, a clip for a non-demo voice, a hand-edited asset, a duplicate or a missing row all fail by name.
- No key means no audio: the script exits 1 naming `ASSEMBLYAI_API_KEY` and writes nothing (no manifest, no placeholder, no stale file). A voice that fails mid-run becomes a blocker row with its reason and exact command, and its stale asset is deleted.
- No `clips.json` or WAV is committed yet: producing them needs a keyed run (`cd voice-pipeline && python scripts/render_clips.py`). That is the named live blocker, matching ticket 120's key-gated reference render; the tests replay the shared recorded synthesis frames instead.

**Files:** `voice-pipeline/cascade/clips.py`, `cascade/test_clips.py` (40 tests), `scripts/render_clips.py`, `voni/evidence/cascade-clips/README.md`.

**Tests:** `cd voice-pipeline && /home/cipherlogs/Repos/AI/leadcalls/telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → **1495 tests, OK, 1 skipped** (40 new). `cd voni && npm run typecheck` → clean (no TS changes).

**Branch:** `cluster/clips-128`, commit `c88893ec`, base `06f9f097`; `git merge feat/meta-cascade` → already up to date.

**Merger notes:** no shared/TS/CI files touched. New paths `voni/public/voices/cascade/<voice>.wav` and `voni/evidence/cascade-clips/clips.json` are free for ticket 129 (regeneration/determinism); the managed `public/voices/<voice>.mp3` clips are untouched. `--check` currently fails in the repo with "clips.json is missing" until the first keyed run — deliberate.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
