# Blind human ballots: one shared recording, auto gate first

Human likeness is judged by ears, but only after the automatic timbre checks
have passed. This is the operator protocol behind the `accent-human` gate and
the `humanRatings`/`humanReview` blocks in the scoreboard artifact. Taste is
informational: a low score never fails a run.

## Rules

1. **Automatic timbre checks gate first.** `timbre-probes` (zero clip/pop/
   jump/underrun/input-drop probes, clean agent-channel PCM, loudness within
   tolerance of the registry reference) must be `PASS` before any ballot
   counts. When it is `FAIL` or `INFO`, the `accent-human` gate stays `INFO`:
   the ballots are recorded in the artifact with `reported, not counted` and
   the run cannot go green on them.
2. **One shared recording.** Every ballot judges the same golden recording,
   identified by its sha256. A ballot filed without a recording is rejected,
   and ballots that disagree about the recording are rejected.
3. **At least two independent raters.** `HUMAN_RATERS_REQUIRED` (2) is the
   count that makes the gate `PASS`. One ballot per rater; a second ballot
   from the same name is a protocol violation, not a second opinion.
4. **Taste never fails a run.** The gate counts ballots, it does not score
   them. `1/1` across two raters is still `PASS`; missing ballots are `INFO`;
   only measured defects fail required gates.

## Supply the shared recording's sha256

The harness can hash the recording for you, so the operator never retypes a
64-character digest:

```sh
npm run scoreboard:demo -- \
  --voice anna --scenario greeting-cut \
  --recording-file runs/golden-call.ogg \
  --rate ana:5,4 --rate bob:4,4
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
  --rate ana:5,4 --rate bob:4,4
```

Using both `--recording` and `--recording-file` is checked: a mismatch fails
fast with no artifact. The recording file itself never enters git; only its
sha256 is recorded.

## What the artifact keeps

`artifact.humanRatings` holds the ballots, their running means, and the
recording sha256. `artifact.humanReview` restates the binding so a stored run
explains its own human slot:

```json
{
  "recordingSha256": "…",
  "raterCount": 2,
  "requiredRaters": 2,
  "raters": ["ana", "bob"],
  "autoTimbrePassed": true,
  "counted": true,
  "protocol": "blind: one shared golden recording, at least 2 independent raters, one ballot per rater (1-5 timbre and accent); auto timbre checks must pass first; taste is informational and never fails a run"
}
```

`counted` is true only when the auto timbre gate passed and enough
independent raters filed. The console prints the same block under
`blind human ballots (one shared recording, auto timbre first)`.
