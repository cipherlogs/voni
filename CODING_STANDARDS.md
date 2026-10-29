# Coding standards

Reviewer-facing rules that are judgment calls. Mechanical rules belong in the
linter, tests, or CI, not here. Read this with the diff, not during exploration.

## Gates and measured evidence

- One gate owns one section/function. Do not add a second threshold or a second
  verdict path inside another gate's section.
- Every measured value names its producer (runner line, trace row, evidence
  flag, PCM analysis). Never infer a measured value from prose, a gate detail
  string, or a default.
- An unmeasured input is `INFO`, never `PASS`. A dry run may be `INFO` or
  `PASS` only where the gate explicitly says it was skipped.
- Every `FAIL` cites the session/turn (or says "no Call trace turn merged").
  A failure without a pointer is incomplete triage.
- Thresholds are single-source (`scoreboard-budgets.ts` + its JSON record).
  Any change needs a matching spec change; a test must fail on drift.
- Small-sample scopes are judged against the tail budget, not their own
  median. Do not turn a one-sample scope into a p50 gate.
- Evidence artifacts stay gitignored working files. Do not commit them, and do
  not fabricate them to make a streak green.

## Live demo-call code

- The stored-agent path is the product path; inline is a debug surface. A
  behavior claim must be measured on the stored path.
- Keep the end-of-turn meaning-based: no `turn_detection` object on the managed
  path. Every stored body ships `turn_detection: null` (the Turn preset); the
  tenant's pre-64 object is deleted, not merely unused. The one sensitive-field
  override stays narrow and scoped.
- The end-call result is a pure signal. Nothing speakable follows it; the
  closing line is spoken before the signal.
- Fast-model and prompt changes are product changes: prove them on all required
  gates, not just reply latency.

## Tests

- Assert external behavior: what the caller heard, wall-clock timings, ledger
  counts, Call trace rows. Do not assert internals unless the internal is the
  contract (e.g. a wire payload).
- A test that can pass with the feature deleted is not a test. Prove the red
  case first for gates and failure paths.
- Prefer a shared validator over a second copy of the same shape check.

## Navigation and docs

- Put a map in `docs/agents/demo-scoreboard.md` when a subsystem spans more
  than two large files; link it from `AGENTS.md` instead of inlining it.
- Put conditional reference behind a pointer. Keep `AGENTS.md` a routing index.
