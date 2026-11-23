# Glossary

Domain terms live in `CONTEXT.md`. This file records project-wide working
definitions on first write (per the voni-perf-sanitize spec).

- **Sanitize**: a behavior-preserving performance refactor — same pixels,
  same data, lower cost (fewer sequential roundtrips, smaller payloads /
  bundles, fewer renders). No visual, API, or schema change.

- **Managed LLM**: AssemblyAI default conversational model for voice agents.
  Undisclosed vendor/model. Used when stored agent has no `llm` field.
- **Custom LLM / bring-your-own**: stored agent with `llm: [{base_url, model, api_key}]`
  (REST create/update only, one entry, must stream). Not currently set in code.
- **Reasoning effort (`metaEffort`)**: `low|medium|high` for Meta
  `muse-spark-1.3-contributor` in `voni/src/lib/llm`. Default `high` (= max for Meta).
  Voice path has no effort knob; free-tier chain has no effort, only `temperature: 0.2`.

- **Take the floor / yield / wait** (cascade): the three outcomes of floor
  arbitration while the agent holds the floor. The caller takes the floor
  (real interruption or command overlap → cut and pivot), yields it back (the
  agent keeps speaking), or the pipeline waits. Never phrased as committing a
  turn.
- **Commit is not cascade vocabulary**: the cascade does not commit a turn —
  the speech provider owns the Turn boundary (see `CONTEXT.md` **Cascade
  pipeline**). "Commit" survives only as the managed-path concept and the git
  verb; a cascade code path, ledger mark, event or test helper named `commit`
  is a naming bug even when the behaviour is right, and
  `voice-pipeline/test_naming.py` fails if it returns.
  _Avoid_: commit gate, early commit (on the cascade)

- **Source** (`/email` console): a mechanism that produces affiliate clicks and
  gets its own card — Grafana, GitHub or Burst. Sources are independent and
  share one target list. Not the click row's `source` column, which is the
  claimed `utm_source` (the email provider).
- **Producer**: the closed `affiliate_clicks.producer` enum naming which
  mechanism produced a click: `grafana`, `github` or `oneoff`. Absent means
  `grafana`, and the column default is the backfill for rows written before it
  existed. Burst writes `grafana` because it runs the Grafana script; the
  one-off button writes `oneoff`.
- **Target**: one row in `affiliate_targets`, shared by every source and either
  active or paused. Removing a target never rewrites the URL a recorded click
  used.
- **Click**: one append-only row in `affiliate_clicks` — one visit to one target
  by one producer. It is evidence of what was sent, not a cache of the target's
  current state.
- **Burst**: one on-demand k6 Cloud run of the Grafana click script from the US
  load zones. It is a source card but has no cadence, so it contributes no
  clicks per day.
- **Interval**: for the GitHub source, the seconds between passes, one of 15,
  30, 60, 120, 300, 600, 900, 1800 or 3600. Grafana has its own interval in
  minutes, stored in Grafana.
- **Window**: the daily active hours of a runner source — 8, 12 or 24 hours
  starting at a chosen UTC hour. Half-open: the start is inside, the end is
  outside.
- **Segment**: at most 20,000 seconds (about 5.6 hours) of a window that one
  GitHub job runs. A 12 h or 24 h window is chained segments, each started when
  the previous one's clicks stop.
