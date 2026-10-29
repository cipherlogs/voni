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

## Verdict

**`dead-end` — no window pair adopted; the platform door is closed for this
effort.** The ladder ran all three rungs, one full-suite run each, alone under
the timing lock:

| Rung | Pooled p50 / p95 / n | Why it failed | Decision |
| --- | --- | --- | --- |
| 1 — 400 / 640 / 0 | 981 / 2255 / 8 | `reply-gap` FAIL on the `email-invite` beat median (1893ms) | `no change` |
| 2 — 200 / 400 / 0 | 1153 / 2164 / 8 | same beat (1920ms), plus `greeting-cut` and `barge-in-cut` regressions | `no change` |
| 3 — `interruption_delay: 0` alone | 2297 / 3463 / 8 | pooled median and tail both breach; platform expanded the object to 1000 / 3000 | `dead-end` |

The fallback trigger is met on the **pooled median**: rung 3 measures 2297ms,
above the 1800ms line. Fragment risk was `clear` on all three rungs, and
interrupted turns were 6 / 5 / 6 against the baseline's 5, so no canary split.
The failure is not a fragmenting window pair but the platform's end-of-turn and
first-audio wait: rung 1 shows ordinary endpointing ~1.3s and delivery ~1.3s,
and tightening the silence windows does not move the tool/invite-shaped beat
that keeps the pooled gate red.

Consequences recorded here:

- production keeps `turn_detection: null`; no window pair was adopted, so no
  end-of-turn contract, pre-roll, budget, model, keyterm or transcription-mode
  change rides along;
- the owned-pipeline fallback is scoped as its own ticket
  (`.scratch/demo-cascade-pipeline/issues/01-owned-pipeline.md`); no pipeline
  code is written in this effort;
- no green claim exists: the pooled Reply gap gate never PASSed on a real
  artifact in this effort.

## Ledger

Median values are milliseconds, in the order **endpointing / generation /
delivery / perceived**; `perceived` is report-only. Pooled is the reply-gap
gate's `p50 / p95 / n` (the gate skips cut turns, so its `n` can be smaller
than the split band counts). `interrupted` is `adoption.interruptedTurns`.

| Row | Windows (min / max / delay) | Variant (identity / key) | Artifact id / sha256 | Pooled p50 / p95 / n | Fast | Per-band median: ordinary · post-cut | Gates | Fragment | Incomplete | Interrupted | Decision | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | production (no turn-detection object) | production / `anna` (agent `agent_d66c02a12f904b73a940a42032dbd36d`) | `score-20261029-094855-anna.json` / `6158dd6a4712ac49f0cdb77090555ff21c02d4cb4ea541e4108128cbc67d8ffd` | 1896 / 2135 / 7 | FAIL | ordinary `1859 / 1 / 1999 / 4482` (n=8) · post-cut `1545 / 2 / 1953 / 4000` (n=1) | 9 PASS / 5 INFO / 2 FAIL (`reply-gap`, `barge-in-cut`) | clear | clear | 5 | baseline | `run-20261029-094855-anna` (2026-10-29T08:48:55Z); code `8c3a8b344a99`; llm `google/gemini-2.5-flash`; end-of-turn production (null, no experiment evidence); `barge-in-cut` was an unanswered 1112ms cut — the sidecar flags it as a possible run-level flake to recheck at acceptance; run predates the 07b default-events guard but carries client marks |
| rung 1 | 400 / 640 / 0 | `turn-window` / `anna:exp` (agent `agent_3efdbb1cc314460aa458d2e87d6c0d53`, fp `f82bb830815c`) | `score-20261029-100925-anna.json` / `1d3fa6eff8ca955da5c5dbff428178b315cda6c7696d8fd5cd12807c8966bb91` | 981 / 2255 / 8 | **NO** — `reply-gap` FAIL on beat `email-invite` (median 1893ms > 1500ms) though overall p50 981ms | ordinary `1305 / 2 / 1328 / 3133` (n=7) · post-cut `1445 / 0 / 1456 / 3401` (n=1) | 10 PASS / 5 INFO / 1 FAIL (`reply-gap`) | clear | clear | 6 | `no change` | `run-20261029-101427-anna`; code `9dc06c557956`; 9/9 scenarios; end-of-turn PASS as experiment evidence (production null preserved); interrupted 6 ≥ baseline 5; failing beat's 2255ms turn is tool/invite flow, not window-shaped; 5 of 13 gapped turns carried no split sample after the strict pairing fix; an earlier attempt (`score-20261029-095132-anna`, `d46fb3b7…`) was voided by the end-of-turn guard bug and a negative split sample, both fixed before this run |
| rung 2 | 200 / 400 / 0 | `turn-window` / `anna:exp` (agent `agent_3efdbb1cc314460aa458d2e87d6c0d53`, fp `727d4126d650`) | `score-20261029-091544-anna-rung2.json` / `67f8e1de4ffb3fcdd7f782b09cedc63a9835663b901f3ff4bfa041da1dca64b1` | 1153 / 2164 / 8 | **NO** — `reply-gap` FAIL on beat `email-invite` (median 1920ms > 1500ms) | ordinary `975 / 1 / 978 / 2453` (n=7) · post-cut unmeasured (n=0) | 8 PASS / 5 INFO / 3 FAIL (`reply-gap`, `greeting-cut`, `barge-in-cut`) | clear | clear | 5 | `no change` | `run-20261029-102122-anna`; code `34d7d50ecc3f`; 9/9 scenarios; end-of-turn PASS as experiment evidence; the same tool/invite-shaped beat fails (1893 → 1920ms) and the tighter windows buy nothing there; `email-invite` INFO is `unmeasured-memory`, not a pass; run also lost `greeting-cut` and `barge-in-cut` (cut 1580ms) — safety regression relative to rung 1; 5 of 12 gapped turns carried no split sample |
| rung 3 | - / - / 0 (`interruption_delay` alone) | `turn-window` / `anna:exp` (agent `agent_3efdbb1cc314460aa458d2e87d6c0d53`, fp `c4b86a1c235b`) | `score-20261029-092239-anna-rung3.json` / `88130d18a8de2e20f2cecc1734bf802187e3db53b46a3cd8a25e1c7cd58fa5f8` | 2297 / 3463 / 8 | **NO** — pooled p50 and p95 both breach (2297 > 1500, 3463 > 2500) | ordinary `3444 / 1 / 3469 / 7413` (n=6) · post-cut unmeasured (n=0) | 7 PASS / 5 INFO / 4 FAIL (`reply-gap`, `end-of-turn`, `greeting-cut`, `barge-in-cut`) | clear | clear | 6 | `dead-end` | `run-20261029-102816-anna`; code `e73a0180d380`; 9/9 scenarios; recorded windows `{"interruption_delay":0}` but the platform expanded them to `min_silence 1000 / max_silence 3000`, so "no silence windows" is not expressible this way — the `end-of-turn` FAIL is the 10b mismatch guard correctly flagging that expansion; ordinary endpointing ≈ 3.4s and pooled 2297ms is above the 1800ms fallback trigger; 6 of 11 gapped turns carried a split sample |

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
