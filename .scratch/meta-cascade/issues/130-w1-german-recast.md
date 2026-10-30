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
