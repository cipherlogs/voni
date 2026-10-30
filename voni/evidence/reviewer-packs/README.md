# Reviewer packs

One pack per **Locale**: the one shared recording the reviewer hears, the
ballot, the place for written reasons, and the verdict record that names the
reviewer and the date.

These files are **generated, never hand-assembled**, by
`scripts/reviewer-pack.mts` (`npm run voice:packs`). The recording is the
committed audition clip (`public/voices/<voice>.mp3`, tickets 38/39), referenced
by its sha256, so the parity proof runs while a Locale is still being judged on
its content.

```bash
cd voni
npm run voice:packs                       # build every pack from the audition clips
npm run voice:packs -- --voice lola       # rebuild one pack
npm run voice:packs -- --check            # verify packs against clips.json and the bytes
npm run voice:packs -- --strict           # exit non-zero until every pack is complete
npm run voice:packs -- --verdict ballot.json --voice lola
```

## What a pack is

- **One shared recording.** `public/voices/<voice>.mp3`, the picker's preview
  at native level, identified by `sha256`. Every ballot for a Locale judges the
  same bytes, so two reviews are comparable. The sheet also names how the
  native audio was made: `cascade-clip` means the managed Voice Agent API does
  not serve the voice, so the committed cascade clip supplied it and the
  managed audition path is a visible gap, not a verdict.
- **The ballot.** Timbre, accent and language naturalness, each `1–5`, five is
  the bar. Language naturalness is the third axis from ticket 75; the weighted
  result and the report wiring belong to that ticket.
- **Written reasons.** A score below five **must** record the rater's reason on
  that axis. The reason is stored with the score — doctrine: a rating below
  five blocks, and a reason that repeats across iterations means the fix is at
  the wrong layer.
- **The verdict record.** A named native reviewer and the date they judged are
  required. A pack without them is `pending`, never a pass, and is neither
  labelled beta nor dropped (spec, *Open dependency: named reviewers*).

`<voice>.json` is the record; `<voice>.md` is the hand-off sheet a reviewer can
be given as-is. `packs.json` is the index of every pack's status and recording
hash.

## Filing a verdict

A reviewer fills the sheet, or an operator saves the same fields as JSON:

```json
{
  "reviewer": "the named native reviewer",
  "reviewedOn": "2026-11-03",
  "locale": "es",
  "scores": { "timbre": 5, "accent": 4, "languageNaturalness": 5 },
  "reasons": { "accent": "the final vowel is reduced where a Spanish speaker would open it" }
}
```

```bash
npm run voice:packs -- --verdict ballot.json --voice lola
npm run voice:packs -- --check
```

The script refuses, by name: a missing `reviewer`, a missing or malformed
`reviewedOn`, a missing axis, a score outside 1–5, a score below five without a
written reason, a verdict whose `locale` is not the pack's Locale, a package
whose recording is missing or whose sha256 does not match the committed bytes.

## Regeneration

`npm run voice:packs` rebuilds from `evidence/audition-clips/clips.json`. A
filed verdict is carried over only while the recording is the same bytes the
reviewer heard; when a clip is re-rendered, the old verdict is dropped — it
described audio nobody can hear now. `--force` rebuilds the pack blank.

The owners of reviewer names and dates are the owners of the Locales: which
Locales can be staffed is owner input, and the work cannot produce it itself.
