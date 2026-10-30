# 130: German: probe, re-cast and audition

**What to build:** The German voice is resolved rather than dropped. Probe for a valid voice id; if one exists, bind and audition it; if not, re-cast to a catalogue voice declared German and audition it; if no voice can be bound, German stays open and blocks cutover.

**Blocked by:** 46 (Voice binding table), 128 (Clips rendered from the same endpoint and binding table), 129 (Clip regeneration and vendor determinism)

**Status:** ready-for-human

- [ ] A probe for a valid German voice id is recorded: slug, UUID or account-cloned slug.
- [ ] If a valid id exists it is bound, and the owner auditions it.
- [ ] If none exists, German is re-cast to a catalogue voice whose declared Locale is German, auditioned by the owner, with reviewer and date recorded.
- [ ] If no catalogue voice can be bound, German stays open, is not re-cast to another Locale and is not dropped.
- [ ] The old clip is retired, not kept as a silent fallback.

## Comments

**2026-10-30 — machine probe, no binding or audition.** With the funded
AssemblyAI key from `voni/.dev.vars` (the `.env` key is a different, unfunded
key): `juergen` and `aai-juergen` return `422 voice_not_found`; the German
catalogue voices `aai-gunther`, `aai-jorg` and `aai-magdalena` return `200`
with `X-TTS-Language: german`, and their clips were saved for audition. German
is therefore bindable to a catalogue voice. The owner auditions and chooses;
the probe does not edit `voice_binding.py`. Details:
`.scratch/meta-cascade/evidence/2026-10-30-m00-and-german.md`. Status stays
`ready-for-human`.

### 2026-10-30 — agent implementation note (binding/catalogue/level/clip; no audition, no verdict)

Chosen product id: **`jorg`** in the app catalogue (bare id), vendor **`aai-jorg`**.

- Catalogue: `voni/src/lib/agents/voices.ts` DE row is now `{ id: "jorg", accent: "DE", … }`. The catalogue id stays bare; `voice-pipeline/cascade/voice_binding.py` owns the `aai-` vendor mapping (`vendor_voice_id`), which the synthesis socket now sends. The old TTS path was sending the bare id and was refused (`Error 3012: voice not found`), which is how `jorg`'s first live render found the gap.
- Binding: `jorg` is bound to `LOCALES["de"]`. `juergen` is kept as a named **historical unbound** row (`422 voice_not_found`, `historical=True`/`historical: true`), so naming it is refused by name with its Locale and reason; it is not a demo subject and cannot become a silent fallback.
- Demo roster: `DEMO_VOICE_IDS` now reads `anna, lola, estelle, jorg, giovanni, rafael` in both `voni/src/lib/demo/voni-agent.ts` and `voice-pipeline/cascade/clips.py`; the readiness/re-audition fixtures follow.
- Level: measured `jorg` with the funded key (`npm run voice:levels -- --voice jorg --force`): **−24.93 LUFS median, −5.96 dBTP worst true peak, `output.volume` 100**. `voni/evidence/voice-levels/levels.json` and `voni/src/lib/agents/voice-levels.ts` now carry it (16 measured, 0 unmeasured; the `juergen` unmeasured row is removed). The `--voice` run now merges one voice into the committed evidence instead of deleting the other rows.
- Product clip: **`voni/public/voices/cascade/jorg.wav`** (sha256 `4a80ac4e191f4213ed4f2c49d8e003d0f4a29540cb420856e4d018a6fab99330`, 8160 ms, sample peak −5.24 dBFS), rendered by `voice-pipeline/scripts/render_clips.py --voice jorg`; its row is in `voni/evidence/cascade-clips/clips.json`. The other five cascade clips are named blockers in that manifest (no full run on this branch).
- Retired: `voni/public/voices/juergen.mp3` and its reviewer pack/index row are removed. The managed audition clip for `jorg` is **pending** in `voni/evidence/audition-clips/clips.json` with the exact command (`npm run voice:clips -- --voice jorg`); no audition was recorded.
- Left for the owner: audition `jorg` (cascade clip above and the managed audition clip once rendered), then record reviewer + date on this ticket. The audition checklist item and the `ready-for-human` status are unchanged.
