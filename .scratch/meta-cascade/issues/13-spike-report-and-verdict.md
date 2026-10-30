# 13: Spike report, verdict rule and deletion test

**What to build:** The feasibility report: the five terms, their sum, and a PASS, AT RISK or FAIL verdict by the stated rules, with every term traceable to the line that produced it.

**Blocked by:** 10 (Spike: endpointing and post-processing gap), 11 (Spike: first content token from Spark), 12 (Spike: synthesis first audio and the cushion)

**Status:** resolved

- [ ] The report names all five terms in milliseconds with a producer line for each, or names the missing term.
- [ ] Every term measured and sum at or below 1500 is PASS; a sum between 1500 and 2500, or an unmeasured term whose measured terms stay under 2500, is AT RISK; a sum above 2500 is FAIL.
- [ ] An unmeasured term can never produce PASS, and a term that alone exceeds a budget is named even when the sum is inside it.
- [ ] A synthetic timeline with a known injected delay per term reproduces the expected sum.
- [ ] Deleting any term from the report makes the test fail.

## Answer

# Ticket 13 — spike report, verdict rule, deletion test

1. `voice-pipeline/spike/report.py` composes the five terms (endpointing, `speechEnd`→`speechComplete`, first content token, synthesis first audio, configured cushion) in canonical order; each line carries its ms value (or `UNMEASURED` + reason) and the producer line, and a term without a producer cannot be constructed.
2. The verdict is `PASS` only when all five are measured and the sum is `≤ reply_gap.p50_ms`; `AT RISK` when the sum is in the p50–p95 band or a term is unmeasured while measured terms stay `≤ reply_gap.p95_ms`; `FAIL` above p95 or when measured terms alone exceed it. Both budgets, and the per-term "over budget" name, are read from `cascade.thresholds` (record-backed frozen budgets), never literals.
3. Deleting any one term, duplicating one or adding an unknown one raises `MissingTermError`/`DuplicateTermError`; the deletion test iterates all five, and the guards were proved red by removing them (9 failures + 6 errors).
4. `spike/run.py --offline` is the honest no-key run: it calls the ticket 10–12 unmeasured producers with an empty env and prints/JSONs the report; observed verdict `AT RISK`, all five terms named, exit 0. `--live` is refused by name (owner-gated, ticket 151).
5. Evidence: `voice-pipeline/test_spike_report.py` (31 tests), full pipeline suite 477 tests OK (`python -m unittest discover -s voice-pipeline -p 'test_*.py'`); synthetic timeline 120+180+640+60+500 = 1500 ms reproduced; budget-boundary tests move a fixture registry to prove the rule reads it.

Branch `cluster/spike-13`, base `83ea36ed`. Files: `voice-pipeline/spike/report.py`, `voice-pipeline/spike/run.py`, `voice-pipeline/test_spike_report.py`. No ticket 10–12 module touched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
