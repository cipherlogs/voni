# 152: All-subject readiness pack

**What to build:** Before cutover, every eligible subject is assembled with two consecutive clean runs, a clean two-capture pair, a re-audition verdict and two ballots each. All six demo voices are the minimum; tenant subjects eligible under `routing=all` are included. One failed subject blocks all of them.

**Blocked by:** 116 (Only a clean run can be green), 117 (Each subject's verdict comes from its own artifact), 133 (The cascade re-audition pack), 134 (Record the cascade audition verdict), 125 (Every audio metric is proved able to fail), 159 (BYO LLM bodies on cascade), 160 (Auto-detect Locale on cascade)

**Status:** ready-for-human

- [ ] The six demo voices are listed, each with two consecutive clean runs, no fallback and no budget stop.
- [ ] Every tenant subject eligible under `routing=all` is listed with the same evidence, or an explicit dated deferral is recorded.
- [ ] Each subject has a clean two-capture pair, a re-audition verdict and two ballots.
- [ ] One failed subject blocks the cutover; there is no waiver, no beta and no quiet omission.
- [ ] The pack names each artifact path and its code fingerprint.
- [ ] A missing subject is a block, not an omission.
