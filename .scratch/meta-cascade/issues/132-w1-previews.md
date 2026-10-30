# 132: Previews come from the synthesis endpoint

**What to build:** Previews are generated from the synthesis endpoint at native level and covered by the clip test. The route's claim that the vendor offers no standalone synthesis is corrected with the route's real rationale.

**Blocked by:** 128 (Clips rendered from the same endpoint and binding table), 127 (Native level, and no gain stage anywhere)

**Status:** resolved

- [ ] Previews are generated from the synthesis endpoint at native level.
- [ ] Previews are covered by the clip test; a preview whose Locale or level disagrees fails.
- [ ] The preview route no longer claims the vendor offers no standalone synthesis; its rationale is corrected.
- [ ] The preview's voice, locale and level are pinned by a test.

## Answer

# 132 — Previews come from the synthesis endpoint

**Status: done.** Branch `cluster/w1-127-132` @ `689f3b49`, base `a8112b65`.

- A preview **is** the clip: `PREVIEW_URL_PREFIX = "/voices/cascade"`, each
  bound plan/record carries its preview URL, and `clips.json` records
  `previewBase` plus a `preview` per row. The preview is the same native render
  from the same endpoint/binding, audited by the same `audit_manifest` — there
  is no second renderer and no second audio path.
- The clip gate now covers previews by name: a preview file on disk with no
  manifest row ("not in the manifest"), a stale preview ("sha256 … edited or
  swapped"), a preview in another Locale, a preview URL pointing at another
  voice, and a gained preview ("a level stage moved it") all fail. An open Locale
  (`juergen`/de) has no preview URL and keeps no asset. The managed
  `public/voices/<voice>.mp3` stays untouched.
- `voni/src/app/api/voice-preview/route.ts` no longer claims the vendor offers
  no standalone synthesis. The comment now states that AssemblyAI does offer
  streaming TTS (`wss://tts.us.assemblyai.com/v1/ws`) and that Voni renders these
  native clips from it; the route's real rationale is that it is not a second
  renderer (per-tap synthesis would bypass the committed, hash-pinned clip and
  the native-level promise). `preview.ts` gains `CASCADE_PREVIEW_PREFIX` and
  `cascadePreviewUrl`, which returns `null` for an unbound voice.

**Tests:** `cascade/test_previews.py` 11 tests (red-first: deleting the orphan
sweep fails "a preview not in the manifest fails by name"). `preview.test.ts`
+3 tests (reverting the route comment fails the rationale test) — the file is
8/8. Full Python suite **1653, OK, 1 skipped**; full `npm test` **2300 / 2299
pass / 1 skipped / 0 fail**; `npm run typecheck` clean; eslint clean.

**Evidence:** `cascade/clips.py`, `cascade/test_previews.py`,
`voni/src/lib/voice/preview.ts` + test, `voni/src/app/api/voice-preview/route.ts`,
`voni/evidence/cascade-clips/README.md`.

**Merger notes:** `clips.py` changes the manifest document shape (adds
`previewBase` and a per-clip `preview`) — no committed `clips.json` exists yet, so
nothing to migrate. `preview.ts` imports `isCascadeSubjectVoice` from
`src/lib/demo/subject.ts` (no cycle). The picker is not rewired to the new URL
here; that is the client change the route comment points at. German stays open
(ticket 130 untouched).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
