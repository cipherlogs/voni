# Demo-latency ladder: stop rule, fallback, ledger

The turn-window experiment tests explicit end-of-turn windows on a
non-production stored-agent variant (`turn-window`, key `<voice>:exp`). Each
rung is one full-suite live run on the stored path. This document is the
experiment's rulebook and its only ledger: the stop rule, the numeric fallback,
the three rung rows, and the procedure. It does not own measurement, gates,
budgets or the live path; the artifact does.

Budgets are frozen at a **1500ms pooled Reply gap median / 2500ms pooled p95**
(`scoreboard-budgets.ts`). Nothing here may edit them.

## Stop rule

Walk the rungs in order: 1 → 2 → 3. **Adopt the first rung that is both FAST
and SAFE, then stop** — later rungs are not run.

A rung is **FAST** only when its `reply-gap` gate row is PASS on the frozen
budgets: pooled median within 1500ms and pooled p95 within 2500ms, including
the gate's per-turn/per-scope tail check. A PASS is the authority; the ledger
records pooled p50/p95/n verbatim as the evidence.

A rung is **SAFE** only when all four hold in the same artifact:

1. **Fragment:** `adoption.fragmentRisk.status` is `clear` — no caller turn
   transcript ends inside the Test tag, the email address, or a number.
2. **Clause:** `adoption.incompleteClause.status` is `clear` — no turn ended on
   an incomplete clause that the next turn continues.
3. **Interruptions:** `adoption.interruptedTurns` is measured (not null) and is
   **not less than the baseline's 5**. A fall is a regression.
4. **Gates:** every required gate row is PASS — `barge-in-cut`,
   `filler-resume`, `overheard-recall`, `double-talk`, `dead-air`,
   `end-call-drain`, `email-invite`, `end-of-turn`, `plumbing`,
   `measurements`. Any other FAIL gate is named in the notes and cannot be
   reported as a pass.

Two required rows have INFO-by-construction states; they are not passes:

- `measurements` reports `INFO` with reason `measured-evidence` on any measured
  run and fails only as `FAIL` ("no measurements"). That reason satisfies item
  4; a `FAIL` does not.
- `email-invite` reports `INFO` with reason `unmeasured-memory` when the
  Hold-return pair is absent. That INFO is **not** a PASS: the rung is unsafe
  until the pair is supplied (`--email-json` with before/after memory fields).

If a rung is not both fast and safe, record it and continue to the next. If no
rung is both, the final decision is **`no change`**, unless the fallback
trigger below is met, in which case it is **`dead-end`**.

## "No change" is final

`no change` is a legitimate result and cannot be rewritten into a pass. Once a
row says `no change`, only a new artifact whose own row says `adopt` can change
the decision; no run, report, diff or commit may re-label it. There is no
"close enough" reading of the budgets or the adoption test.

## Fallback trigger

After rung 3 is recorded, if no rung was adopted, the effort **dead-ends and
stops** when any of these is true:

- the **pooled** Reply gap median is still **above 1800ms**; or
- the **post-cut** reply-gap median is still **above 1800ms** — the median of
  `endpointingMs + generationMs` over post-cut turns, the same arithmetic the
  Call trace gap uses; or
- **every rung that was otherwise safe split a canary** — fragment risk is
  `risk` on each rung that met the rest of the adoption test.

An unmeasured median is recorded as `unmeasured` and satisfies no numeric
trigger. A dead-end stops the experiment with the split, the three rung rows
and their artifact ids, and a separate ticket for a pipeline we own (ticket 17,
`.scratch/demo-latency/issues/17-dead-end-fallback.md`: streaming
speech-to-text, our own turn windows, our own model, our own speech). No
pipeline code, transport rewrite or preemption work happens in this effort.

If no rung was adopted and no trigger is met, the verdict is `no change` (not a
dead-end, not a pass); ticket 17 is closed as not needed.

## Ledger

Median values are milliseconds, in the order **endpointing / generation /
delivery / perceived**; `perceived` is report-only. Pooled is the reply-gap
gate's `p50 / p95 / n` (the gate skips cut turns, so its `n` can be smaller
than the split band counts). `interrupted` is `adoption.interruptedTurns`.

| Row | Windows (min / max / delay) | Variant (identity / key) | Artifact id / sha256 | Pooled p50 / p95 / n | Fast | Per-band median: ordinary · post-cut | Gates | Fragment | Incomplete | Interrupted | Decision | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | production (no turn-detection object) | production / `anna` (agent `agent_d66c02a12f904b73a940a42032dbd36d`) | `score-20261029-094855-anna.json` / `6158dd6a4712ac49f0cdb77090555ff21c02d4cb4ea541e4108128cbc67d8ffd` | 1896 / 2135 / 7 | FAIL | ordinary `1859 / 1 / 1999 / 4482` (n=8) · post-cut `1545 / 2 / 1953 / 4000` (n=1) | 9 PASS / 5 INFO / 2 FAIL (`reply-gap`, `barge-in-cut`) | clear | clear | 5 | baseline | `run-20261029-094855-anna` (2026-10-29T08:48:55Z); code `8c3a8b344a99`; llm `google/gemini-2.5-flash`; end-of-turn production (null, no experiment evidence); `barge-in-cut` was an unanswered 1112ms cut — the sidecar flags it as a possible run-level flake to recheck at acceptance; run predates the 07b default-events guard but carries client marks |
| rung 1 | 400 / 640 / 0 | `turn-window` / `anna:exp` | — | — | — | — | — | — | — | — | — | not run |
| rung 2 | 200 / 400 / 0 | `turn-window` / `anna:exp` | — | — | — | — | — | — | — | — | — | not run |
| rung 3 | - / - / 0 (`interruption_delay` alone) | `turn-window` / `anna:exp` | — | — | — | — | — | — | — | — | — | not run |

Filling a row:

| Slot | Read from |
| --- | --- |
| artifact id + sha256 | filename, `sha256sum <artifact>` |
| run id, recorded time, code fingerprint | `run.runId`, `run.recordedAt`, `run.code.head` (+`+dirty`) |
| variant identity / key / windows | `run.variant`, `run.variantKey`, `run.turnWindows` |
| pooled p50 / p95 / n | `artifact.replyGap` and the `reply-gap` gate row detail |
| per-band medians | `scoreboard:inspect --json` → `latency.bands[].measured.{endpointing,generation,delivery}.medianMs` and `.perceived.medianMs` |
| gates tally | `adoption.gates` (full rows in `gates`) |
| fragment / incomplete / interrupted | `adoption.fragmentRisk.status`, `adoption.incompleteClause.status`, `adoption.interruptedTurns` |

Per-rung decision is one of:

- `adopt` — fast and safe; the ladder stops here and later rows stay `not run`;
- `no change` — the rung ran and was rejected; continue to the next rung;
- `dead-end` — rung 3 was rejected and the fallback trigger above is met; this
  is the ladder's final verdict.

The baseline row's decision is `baseline`: it is the comparison point and is
never an adoption candidate.

## Procedure

**One rung = one full-suite live run, alone.** `scoreboard:demo` is the only
command that takes `/tmp/voni-demo-timing.lock`; never run `eval:demo-agent`
directly for a rung (it bypasses the lock, and parallel live runs inflate cut
latency). If the lock is held, wait for the holder. Do not delete the lock or
point `--timing-lock` elsewhere to get around it.

From `voni/` (stored transport, variant bound explicitly, events on):

```sh
# rung 1
npm run scoreboard:demo -- \
  --transport stored \
  --variant turn-window --turn-windows 400,640,0 \
  --out scoreboard-runs/score-<stamp>-anna-rung1.json

# rung 2
npm run scoreboard:demo -- \
  --transport stored \
  --variant turn-window --turn-windows 200,400,0 \
  --out scoreboard-runs/score-<stamp>-anna-rung2.json

# rung 3
npm run scoreboard:demo -- \
  --transport stored \
  --variant turn-window --turn-windows -,-,0 \
  --out scoreboard-runs/score-<stamp>-anna-rung3.json
```

`<stamp>` is the run's timestamp (e.g. `20261029-094855`). Do **not** pass
`--no-events`: the default JSONL stream carries the client marks the split
needs (07b). `--transport inline` is a debug path and is never measured. Omit
`--prior` to diff against the newest same-voice artifact in the output
directory, or pass `--prior <baseline artifact>` explicitly.

After the run, capture the row's evidence:

```sh
npm run --silent scoreboard:inspect -- --artifact <artifact> --json
sha256sum <artifact>
```

`scoreboard:inspect` text mode prints `adoption inputs (evidence only, never a
verdict)` and the per-band `latency split (perceived is report-only, never
gated)`; `--json` carries `run`, `gates`, `latency.bands`, `adoption.gates`,
`adoption.fragmentRisk`, `adoption.incompleteClause`,
`adoption.interruptedTurns` and `adoption.endOfTurn`. Record the row, then apply
the stop rule; the decision is made from the artifact, not from the console
narrative.

Artifacts and event streams are gitignored working files under
`voni/scoreboard-runs/`; reference them by filename + sha256 and never commit
one.

## Hard stop

There is no fourth rung. No window value outside the three rows above may be
run for this experiment, and tuning cannot continue past rung 3 without a
recorded verdict in this ledger (`adopt`, `no change`, or `dead-end` + ticket
17). Changing a rung, a window or the trigger is a spec change, not a ladder
run.
