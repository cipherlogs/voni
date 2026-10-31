# Caller corpus provenance

The committed English fast corpus (`corpus/`) is real synthesized caller audio,
not fixtures. This file records how it was produced and how it may change.

## Recorded takes

- Voice: **Kurt - Phone Support**, Cartesia voice id
  `efa653e5-314d-46ca-9f90-70ac7d6ca71e`.
- Model: `sonic-3.6`, Cartesia API version `2024-06-10`; the request's
  `language` is the scenario's own Locale (`en`, `es`, `fr`, `de` or `pt`), so
  the Locale core is real speech in its target language.
- Format: 24 kHz mono PCM16 WAV, the pipeline's ingress format.
- Corpus version **1**: seventy-six scenarios, 189 takes, recorded **2026-10-31**
  with `npm run corpus:takes` and the local `CARTESIA_API_KEY`. Ticket 12's ten
  fast-contract scenarios carry twenty takes; ticket 13's five comprehension and
  five emotion scenarios carry thirty; ticket 14's soundscape, connectivity and
  meta-security scenarios carry nineteen; ticket 16's forty-eight Locale-core
  scenarios carry 120 takes (twelve behaviours on es, fr, de and pt, thirty per
  Locale). Adding a scenario directory does not move the version; only a
  deliberate retake does.
- Every take's exact bytes are pinned by its `sha256` in `scenario.json`. The
  loader hashes the file on every load; a mismatch is a named `take-drift`
  refusal with exit 2.

## Changing a take

- Re-running the generator over a recorded take is a no-op.
- Replacing one is deliberate: `npm run corpus:takes -- --retake <scenario>/<take>`.
  That rewrites the take, records its new digest and bumps `corpus/manifest.json`
  by one, because comparability moved.
- Never hand-edit a WAV or a declared digest to make a run pass.
- Synthesis is not byte-deterministic: the same words recorded twice are two
  different takes. The corpus pins each take separately, so do not assume two
  scenarios that speak the same line share the same bytes.

## Known gaps

- RR-01 still applies: this is a TTS-only corpus. Indian, Nigerian, Irish,
  Australian and East-Asian English accents await hashed Studio takes, and no
  certificate may imply accent coverage from these files.
- RR-02 still applies: the es, fr, de and pt lines were authored for the
  Locale core but no named native reviewer has signed that Locale's
  understanding sample. The Locale matrix reports those rows `pending-human`
  with RR-02; it never claims native-certified comprehension from these takes.
  The English translation proxy in the text evaluators is a recorded limitation,
  not a substitute for the reviewer.
- The four `locale-television-*` scenarios name the `television` bed, the same
  gap ticket 14 records in `SOUNDSCAPES.md`: until a real bed is committed the
  adapters refuse that soundscape by name rather than mixing digital silence.
