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
4. **Five out of five, weighted.** Each ballot is weighted: timbre 0.5, accent
   0.25, language naturalness 0.25 (budget records `timbreBallotWeight*`); the
   two raters' weighted scores are averaged. The gate PASSes only at 5.00/5;
   any axis below five blocks, and the rater's stated reason is recorded with
   the score. A reason that repeats across iterations is evidence that the fix
   is at the wrong layer.
5. **A ballot is per subject.** The artifact binds the ballots to the
   `{agent, Locale, transport}` subject it measured (`humanRatings.subject`,
   restated as `humanReview.subject`). A ballot filed for one subject never
   passes another.

## Supply the shared recording's sha256

The harness can hash the recording for you, so the operator never retypes a
64-character digest:

```sh
npm run scoreboard:demo -- \
  --voice anna --scenario greeting-cut \
  --recording-file runs/golden-call.ogg \
  --rate ana:5,5 --rate bob:5,5
```

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
  --voice anna --scenario greeting-cut \
  --recording "$(jq -r .recording.sha256 evidence.json)" \
  --rate ana:5,5 --rate bob:5,5
```

Using both `--recording` and `--recording-file` is checked: a mismatch fails
fast with no artifact. The recording file itself never enters git; only its
sha256 is recorded.

## What the artifact keeps

`artifact.humanRatings` holds the ballots, their running means, the weighted
score and the recording sha256. `artifact.humanReview` restates the binding so
a stored run explains its own human slot:

```json
{
  "subject": "demo anna (en, browser)",
  "recordingSha256": "…",
  "raterCount": 2,
  "requiredRaters": 2,
  "raters": ["ana", "bob"],
  "weighted": 5,
  "requiredScore": 5,
  "autoTimbrePassed": true,
  "counted": true,
  "protocol": "blind: one shared recording per subject, two independent raters, one ballot per rater (weighted 1-5: timbre 0.5, accent 0.25, language naturalness 0.25); a measured timbre result must pass first; five out of five passes, and a ballot below five blocks with the rater's stated reason"
}
```

`counted` is true only when the measured timbre gate passed and the weighted
ballot reached five out of five from two independent raters. The console prints
the same block under
`blind human ballots (one shared recording per subject, measured timbre first)`.
