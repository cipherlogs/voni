# 155: Cutover to all eligible subjects

**What to build:** Cutover happens only when the readiness pack, rehearsal and signatures exist and the kill criterion has been applied. Routing becomes `all` for every eligible subject, tenant calls included; ineligible bodies route managed with a reason, and managed remains the `off` fallback until the decommission decision.

**Blocked by:** 154 (Two signatures, two people), 119 (Small samples, rounds and the kill criterion), 04 (Open-value decisions with a stated source), 159 (BYO LLM bodies on cascade), 160 (Auto-detect Locale on cascade)

**Status:** ready-for-human

- [ ] Routing is set to `all` at cutover; every eligible subject, demo or tenant, runs cascade.
- [ ] An ineligible body still routes managed with a named refusal reason; no silent fallback.
- [ ] A tenant with a bring-your-own model runs cascade once ticket 159 lands; it is not left on managed by default.
- [ ] An auto-detect tenant runs cascade once ticket 160 lands; it is not left on managed by default.
- [ ] The artifact path and run ids are cited in the decision record.
- [ ] The kill criterion has been applied: three measured rounds passed, or an explicit dated risk acceptance with the evidence attached. Silence is not an acceptance.
- [ ] `routing=off` still routes a working managed product; managed is not removed at cutover.
- [ ] A fourth measurement attempt is not authorised by this ticket; it needs a new decision record and a new mechanism.
