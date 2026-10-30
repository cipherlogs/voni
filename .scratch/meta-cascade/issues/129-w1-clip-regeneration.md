# 129: Clip regeneration and vendor determinism

**What to build:** The PR test replays a recorded synthesis fixture and compares the clip's binding, Locale, text, format and measured level. Byte identity is required only if this ticket measures the vendor render as deterministic.

**Blocked by:** 128 (Clips rendered from the same endpoint and binding table), 127 (Native level, and no gain stage anywhere)

**Status:** resolved

- [ ] The PR test compares binding, Locale, text, format and measured level against the recorded fixture.
- [ ] Byte identity is required only if the determinism measurement in this ticket shows the render is deterministic.
- [ ] A live regeneration is key-gated and recorded as evidence, never a silent asset swap.
- [ ] A deliberate voice, locale, level or format mismatch fails.
- [ ] A byte difference with matching binding and level is not a failure.

## Answer

# 129 — Clip regeneration and vendor determinism

**Status: done.** Branch `cluster/w1-127-132` @ `d4b3da15`, base `a8112b65`.

- New `voice-pipeline/cascade/clip_regeneration.py` replays a **recorded
  synthesis fixture** through the call's own client (`render_reference` over
  `AssemblyAIStreamingTTS`) and binding table over the ticket-01 scripted socket
  — no key, no network, no sleep. `regeneration_problems` compares binding,
  Locale, vendor language, text, endpoint, model, format and the measured level;
  a changed voice/locale/endpoint/text/format/level fails **by name**.
- Committed fixture `cascade/fixtures/clips/anna-en.json`: Begin echo + audio
  frames + FlushDone maths for anna's English greeting. Its PCM hash, WAV hash,
  byte count and measured level are re-derived by `load_fixture`, so a changed
  frame, an unknown field, a stale hash or a voice that disagrees with the file
  name fails by fixture name. The audio payloads are repeated-sample tokens, not
  speech (the contract is regeneration identity; timbre is W2/ticket 133).
- Determinism is **measured, never assumed**: `measure_determinism` needs ≥2
  renders and only a byte-identical set sets `byteIdentityRequired`; a byte
  difference with matching binding and level is explicitly not a failure. A live
  regeneration is key-gated (`live_regeneration_blocker`, `regenerate_live`
  raises before touching a file) and records a `clip-regeneration` evidence
  document, never an asset swap.

**Tests:** `cascade/test_clip_regeneration.py` 21 tests (red-first: module import;
deleting the byte-pin check fails the determinism test). Full Python suite
**1653, OK, 1 skipped**; full `npm test` **2300 / 2299 pass / 1 skipped / 0
fail**; `npm run typecheck` clean.

**Evidence:** `cascade/clip_regeneration.py`, `cascade/test_clip_regeneration.py`,
`cascade/fixtures/clips/anna-en.json`, `voni/evidence/cascade-clips/README.md`.

**Merger notes:** all new Python paths; no shared Python/TS file touched. No
`clips.json`/WAV committed yet: producing them still needs the keyed run, which
is the same named blocker ticket 128 recorded. `--check` still fails in-repo
with "clips.json is missing" until that run.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
