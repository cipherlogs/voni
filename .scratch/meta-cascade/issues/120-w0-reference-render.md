# 120: W0 reference render from direct synthesis

**What to build:** The reference is a direct synthesis of the intended line in the same voice, language and format as the call, with no speech, model, client or platform in the path. The default line is the greeting, because that separates broken-from-the-first-word from breaks-once-the-model-speaks.

**Blocked by:** 46 (Voice binding table), 47 (Synthesis connect per transport), 49 (Sentence scheduling: first sentence flushes immediately), 77 (The greeting is spoken before any user audio)

**Status:** resolved

- [ ] The reference is a direct synthesis of the intended line in the same voice, language, format and text as the call.
- [ ] It uses the same synthesis client and binding table as the call, with no speech, model, client or platform in the path.
- [ ] The default line is the body's greeting; another sentence can be rendered for a mid-call defect.
- [ ] The reference is cached by voice, text and format.
- [ ] The render path contains no model and no client by test.

## Answer

# 120 — W0 reference render from direct synthesis

- The W0 reference is now `voice-pipeline/cascade/reference_render.py`: a direct synthesis of the body's greeting (or a `--text` sentence for a mid-call defect), through `AssemblyAIStreamingTTS` and `bind_voice` — the call's own client and binding table — with no STT, LLM, browser or platform in the path.
- The line goes through `CallGreeting` (ticket 77), so one `Generate` + `Flush` per sentence is observed on the wire and the first sentence is flushed before the second is sent; the whole greeting is rendered, verbatim including the body's own whitespace.
- The PCM is written verbatim as a 44-byte-header PCM16 mono WAV at the transport's native rate (browser: 24 kHz `pcm_s16le`). No gain, limiter or normalisation.
- Cache is keyed by voice + text + whole format (transport, rate, encoding, model, container, channels, width); a hit costs no synthesis and returns the same `sha256` pin. A truncated/foreign file is re-rendered. `ReferenceRender.to_document()` carries path + hash, never audio bytes.
- Live synthesis is key-gated: `voice-pipeline/scripts/render_reference.py --body body.json [--text LINE]` refuses by name when `ASSEMBLYAI_API_KEY` is unset and writes nothing. No live render was performed and no WAV was committed; tests replay the shared recorded synthesis frames through `ScriptedSocketFactory`.

**Why Python, not the TS renderer:** AC2 requires the call's synthesis client and binding table, which live in the service. `voni/src/lib/demo/reference-render.ts` remains the managed scoreboard/audition reference; its header and `render-reference.mts`'s now say so explicitly (comments only).

**Files:** `voice-pipeline/cascade/reference_render.py`, `cascade/test_reference_render.py` (13 tests), `scripts/render_reference.py`; comment-only pointers in `voni/src/lib/demo/reference-render.ts` + `voni/scripts/render-reference.mts`.

**Tests:** Python `cd voice-pipeline && … -m unittest discover -s . -p 'test_*.py'` → 1314 pass, 0 fail, 1 skip (13 new). TS `node --import tsx --test src/lib/demo/reference-render.test.ts` → 13 pass; `npm run typecheck` clean. Full `npm test` → 2123 tests, 2121 pass, 1 skipped, 1 fail: `scripts/score-demo.test.ts` "real run whose runner finishes without evidence…" — reproduced with my TS edits stashed, so pre-existing at base.

**Branch:** `cluster/w0-120`, commit `91b2cccf`, base `098fdf9d`; `git merge feat/meta-cascade` → already up to date.

**Merger notes:** ticket 122/126 can invoke the CLI or import `render_reference` and record `to_document()`; `transport="telnyx"` is refused by name because W0 has only the browser delivered capture. The live render remains the named key-gated step (no fabricated reference asset).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
