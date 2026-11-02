# Run journal interface (next change)

`demo:usage` currently resolves a run from a terminal adapter `run.json` or a
committed certificate, and `--latest` guesses by mtime. The next change replaces
that guess with an append-only run journal. This note is the agreed interface;
the reader is **not implemented on this branch** — `readRunJournal` refuses by
name until the resume branch merges.

## File

One JSONL file per run id, e.g. `voni/.demo-runs/<runId>/journal.jsonl`.
Append-only: a row is never edited or removed. Every row is one JSON object with
`kind`, `runId`, `seq` and `atMs`.

## Kinds

| kind | carries | meaning |
| --- | --- | --- |
| `run.started` | `planCalls`, `startedAt` | the run opened; the plan is fixed |
| `call.started` | `callId`, `scenario`, `locale` | one call opened |
| `call.finished` | `callId`, `priced` (the verbatim `cost.priced` row), `endedAt` | one call's price is final |
| `run.finished` | `expectedCalls`, `aggregateUsd`, `endedAt` | the run ended; it is readable |
| `run.aborted` | `reason`, `endedAt` | the run ended without a claim; it is not readable as usage |

## Rules

- `seq` is monotonic per `runId`, starting at 1; a gap or duplicate is a torn
  journal and is refused.
- `call.finished.priced` is the row the pipeline wrote, never a recomputation.
  The ledger reads it through the same `readPricedRow` path.
- A run is selectable only when its newest terminal row is `run.finished`.
  `run.aborted` names its reason and is refused, never totalled.
- Selection is by the newest `run.finished.atMs`, not file mtime. If two runs
  have no terminal row, the reader names both ids and their paths and refuses;
  it never picks one.
- `run.finished.expectedCalls` is the plan count the ledger prints beside the
  measured calls; `aggregateUsd` is reconciled at six decimals through
  `sums.ts`.

## Seam

`evidence.ts` exports:

```ts
export function readRunJournal(runId: string, journalRoot: string): never;
```

It refuses with `run-journal-not-implemented` on this branch. The resume branch
replaces the body with a reader that returns a `UsageRun` (`kind:
"journal"`), and `resolveLatest` switches to journal selection when a journal
root is configured.
