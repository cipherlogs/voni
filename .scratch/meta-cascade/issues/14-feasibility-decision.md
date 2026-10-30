# 14: Feasibility decision: proceed or stop

**What to build:** The owner records the feasibility verdict and either authorises the foundations or stops the work with the evidence. The spike is a gate, not a cutover claim.

**Blocked by:** 13 (Spike report, verdict rule and deletion test)

**Status:** resolved

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

## Answer

**Verdict: FAIL.** Nine complete live rounds on 2026-10-30 measured all five
terms; eight were FAIL and one was AT RISK.

- `endpointing_ms`: 455–656 ms (wall-clock; vendor cross-check -165 to -245 ms,
  both reported, not averaged)
- `post_processing_ms`: 0.016–0.049 ms
- `first_content_token_ms`: 1192–2593 ms at `META_REASONING_EFFORT=low`
  (M03-configured, not probed)
- `synthesis.first_audio_ms`: 148–204 ms
- `playout.cushion_ms`: 500 ms, configured
- sum: 2334–3952 ms. The best round is 2334 ms, above the 1500 ms pass budget;
  eight of nine are above the 2500 ms fail bound. First content token plus the
  configured cushion alone is 1692 ms at best.

**Decision (owner, 2026-10-30): proceed with this dated risk acceptance.** The
cascade does not meet the 1500 ms reply budget; the first content token alone
exceeds it in eight of nine rounds. The programme continues to the next stage
with the risk accepted on this evidence. This is not a PASS, and it does not
authorise cutover, a fourth measurement, or a claim that the budget is met;
cutover still requires 152, 153, 154 and 155. The acceptance is recorded from
the owner's session decision of 2026-10-30 and is not a ticket 154 signature.

Evidence: `.scratch/meta-cascade/evidence/2026-10-30-m00-and-german.md`.
