# Blind human ballots: one shared recording per subject, measured timbre first

Human likeness is judged by ears, but only after the measured timbre result has
passed. This is the operator protocol behind the `accent-human` gate and the
`humanRatings`/`humanReview` blocks in the scoreboard artifact. A ballot below
five blocks; it is a delivered judgement, not a matter of taste that can be
waived.

## Rules

1. **The measured timbre result gates first.** `timbre-probes` must PASS its
   six measured axes — level against the measured reference, true peak,
   distortion residual, crest factor, spectral balance and breakups — before the
   weighted ballot counts. When the measurement is `FAIL`, the `accent-human`
   gate stays `INFO`: the ballots are recorded in the artifact with `reported,
   not counted` and the run cannot go green on them. When the measurement is
   `INFO` (a dry run, or captured audio that could not be measured), the ballot
   is still reported but the timbre gate is never a machine-only `PASS`.
2. **One shared recording per subject.** Every ballot judges the same recording,
   identified by its sha256, for the subject it names. A ballot filed without a
   recording is rejected, and ballots that disagree about the recording are
   rejected.
3. **Two independent raters.** `TIMBRE_BALLOT_RATERS_REQUIRED` (2) is the count
   that makes the gate complete. One ballot per rater; a second ballot from the
   same name is a protocol violation, not a second opinion. One ballot is
   reported, never counted.
4. **Five out of five, weighted, on three axes.** Each ballot scores **timbre,
   accent and language naturalness**, weighted 0.5 / 0.25 / 0.25 (budget
   records `timbreBallotWeight*`); the two raters' weighted scores are averaged.
   The gate PASSes only at 5.00/5; any axis below five blocks, and the rater's
   stated reason is recorded with the score. A reason that repeats across
   iterations is evidence that the fix is at the wrong layer.
5. **Every ballot carries all three axes.** A ballot that is missing an axis the
   subject's Locale requires is **incomplete**: it is rejected at filing time,
   and the gate reports `incomplete ballot` rather than weighting the axes that
   happen to be present. A missing axis is never defaulted and its weight is
   never silently dropped.
6. **English is the one named N/A.** English is the featured baseline Locale, so
   a native English rater has no second language to judge the voice against: the
   naturalness axis is N/A for English and its 0.25 renormalises over timbre and
   accent, with that reason recorded (`humanRatings.notApplicable`,
   `humanReview.axes[].status = "na"`). Two scores stay valid for English and
   only for English; every other Locale must supply the third. An unbound or
   unknown Locale counts as applying, so a missing Locale cannot excuse the axis.
7. **A ballot is per subject.** The artifact binds the ballots to the
   `{agent, Locale, transport}` subject it measured (`humanRatings.subject`,
   restated as `humanReview.subject`). A ballot filed for one subject never
   passes another.

## Supply the shared recording's sha256

The harness can hash the recording for you, so the operator never retypes a
64-character digest:

```sh
npm run scoreboard:demo -- \
  --voice lola --scenario greeting-cut \
  --recording-file runs/golden-call.ogg \
  --rate ana:5,5,5 --rate bob:5,5,5
```

`--rate` takes `rater:timbre,accent[,naturalness]`. The third score is required
for every non-English subject (rule 5); for English the two-score form
`rater:timbre,accent` remains valid (rule 6).

`--recording-file` computes the sha256 of the file and binds every ballot to
it. The same value is printed in the console and stored in
`artifact.humanRatings.recordingSha256` and `artifact.humanReview.recordingSha256`.

If the recording's hash already came from the session QA evidence, pass it
directly; both flags are accepted and must agree:

```sh
# qa-voice-session writes recording.sha256 into its evidence JSON
npm run qa:voice-session -- --session sess_... --evidence-out evidence.json
jq -r .recording.sha256 evidence.json

npm run scoreboard:demo -- \
  --voice lola --scenario greeting-cut \
  --recording "$(jq -r .recording.sha256 evidence.json)" \
  --rate ana:5,5,5 --rate bob:5,5,5
```

Using both `--recording` and `--recording-file` is checked: a mismatch fails
fast with no artifact. The recording file itself never enters git; only its
sha256 is recorded.

## Load a reviewer's filed verdict

A reviewer fills the pack's ballot (`evidence/reviewer-packs/<voice>.json`) and
an operator files the verdict with `npm run voice:packs -- --verdict <file>
--voice <id>`. The scoreboard reads that pack directly, so the ballot the gate
judges is the ballot the reviewer filled — all three axes, on the pack's one
shared cut:

```sh
npm run scoreboard:demo -- \
  --voice lola --scenario greeting-cut \
  --reviewer-pack evidence/reviewer-packs/lola.json \
  --rate bob:5,5,5   # the second ear, on the same cut
```

A pending pack loads as an empty ballot (reported, never counted); a pack whose
verdict drops an axis, or whose Locale is not the subject's, is refused by name.

## What the artifact keeps

`artifact.humanRatings` holds the ballots, their running means (timbre, accent
and language naturalness), the weighted score, the recording sha256 and any axis
the Locale excuses with its reason. `artifact.humanReview` restates the binding
so a stored run explains its own human slot:

```json
{
  "subject": "demo lola (es, browser)",
  "recordingSha256": "…",
  "raterCount": 2,
  "requiredRaters": 2,
  "raters": ["nuria", "bob"],
  "weighted": 5,
  "requiredScore": 5,
  "axes": [
    { "axis": "timbre", "weight": 0.5, "mean": 5, "status": "required", "reason": null },
    { "axis": "accent", "weight": 0.25, "mean": 5, "status": "required", "reason": null },
    { "axis": "languageNaturalness", "weight": 0.25, "mean": 5, "status": "required", "reason": null }
  ],
  "autoTimbrePassed": true,
  "counted": true,
  "protocol": "blind: one shared recording per subject, two independent raters, one ballot per rater (weighted 1-5: timbre 0.5, accent 0.25, language naturalness 0.25); every ballot carries all three axes, and language naturalness is required wherever the subject's Locale is not the English baseline (missing = incomplete, never renormalised), while English is N/A with that named reason and its weight renormalises over timbre and accent; a measured timbre result must pass first; five out of five passes, and a ballot below five blocks with the rater's stated reason"
}
```

For an English subject the naturalness axis carries `"status": "na"` and the
named reason, and the console prints `languageNaturalness: N/A ×0.25 — English
is the featured baseline Locale, …`.

`counted` is true only when the measured timbre gate passed and the weighted
ballot reached five out of five from two independent raters. The console prints
the same block under
`blind human ballots (one shared recording per subject, measured timbre first)`.
