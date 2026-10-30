# 14: Feasibility decision: proceed or stop

**What to build:** The owner records the feasibility verdict and either authorises the foundations or stops the work with the evidence. The spike is a gate, not a cutover claim.

**Blocked by:** 13 (Spike report, verdict rule and deletion test)

**Status:** ready-for-human

- [ ] The owner records PASS, AT RISK or FAIL with the measured numbers and the date.
- [ ] A FAIL, or AT RISK caused by a structurally large term, results in an explicit stop or an explicit decision to proceed; silence is not an authorisation.
- [ ] If the decision is stop, no foundations ticket is started and the evidence is linked from the spec.
- [ ] The decision is written where the next reader finds it, not left in a chat log.

## Comments

**2026-10-30 — machine evidence, no verdict.** The owner-gated live run now
measures all five terms. Eight complete rounds on a single-utterance 20 s clip
produced seven FAIL and one AT RISK: sums 2334–3952 ms; first content token
1192–2593 ms (median ~1.84 s); synthesis 148–204 ms; cushion 500 ms. The
endpointing wall/vendor cross-check disagrees and both numbers are reported.
The updated Meta key and the funded AssemblyAI key from `voni/.dev.vars` were
used; `META_REASONING_EFFORT=low` is M03-configured, not probed. Full table:
`.scratch/meta-cascade/evidence/2026-10-30-m00-and-german.md`. The owner still
records PASS/AT RISK/FAIL and stop-or-proceed; status stays `ready-for-human`.
