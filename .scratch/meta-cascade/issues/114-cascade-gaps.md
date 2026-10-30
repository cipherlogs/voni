# 114: Three cascade gaps and an honest N/A

**What to build:** The cascade reports screen latency, think and the reply gap. The commit mark does not exist on the cascade, so the commit-to-playout row is N/A rather than a copy of the reply gap.

**Blocked by:** 02 (Ledger: cascade marks and an honest N/A), 108 (Every turn names the providers that served it), 107 (One event envelope and reader refusal)

**Status:** resolved

- [ ] Screen latency, think and the reply gap are reported from the ledger.
- [ ] The commit-to-playout row is N/A on the cascade.
- [ ] The reply gap is anchored by the same client mark on both engines.
- [ ] The greeting is excluded, and a cut turn is skipped by the reply-gap gate.
- [ ] Copying the reply gap into the commit row fails the test.

## Answer

# 114 — three cascade gaps from marks alone, and an honest N/A

`cascadeLatencyFromMarks()` derives screen latency (`audio_in`→`first_partial`), think (`speech_complete`→`first_token`) and reply gap (`speech_complete`→`first_playout`) from the ledger summary's marks in seconds; no ledger object and no `gaps_ms` is consulted. A missing anchor is a named N/A naming the mark; the reply gap never falls back to `final`, greeting marks are never read, and `commitToFirstPlayoutMs` is N/A (the cascade has no commit mark). A cascade artifact carrying its ledger is checked against the derivation, so a copied row is refused by field. The runner writes latency from marks, not from the ledger's precomputed `gaps_ms`.

Evidence:
- `voni/src/lib/demo/artifact-reader.ts` — `CASCADE_GAP_ROWS`, `cascadeLatencyFromMarks`, `assertCascadeLatencyFromLedger`, `parseLedger`.
- `voni/scripts/score-demo.mts` — `cascadeLatencyFromLedger(marks)` replaces the `gaps_ms` read.
- Tests: `artifact-reader.test.ts` (“three cascade gaps…”, “missing mark is a named N/A”, “greeting and a cut are excluded”, “borrowed from the final mark”, “copied reply gap in the commit row”), `score-demo.test.ts` (“derives the three gaps from marks, never from a final fallback”).
- Cut-turn skip remains pinned by `scoreboard.test.ts` “trace gaps … skip cut turns”; the greeting has no reply-gap turn.
- Commands: `npm run typecheck` OK; full `npm test` 2138 tests, 2137 pass, 1 skipped, 0 fail; Python `unittest discover` 1301 tests OK (1 skipped).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
