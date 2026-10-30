# 70: Floor arbitration while the agent holds the floor

**What to build:** While the agent speaks or thinks, a partial is a real interruption, a backchannel, or a wait. The decision uses the existing command and filler sets, so the cascade speaks the same language as the managed path.

**Blocked by:** 67 (Event rules: the final is the only reply trigger), 05 (Retire commit vocabulary on the cascade)

**Status:** resolved

- [ ] While the agent holds the floor, a partial resolves to take, backchannel or wait using the existing command and filler sets.
- [ ] Stop, wait, no, nope, repeat, again, sorry, listen, hold on, hang on and excuse me take the floor; yes and yeah take the soft-confirm path.
- [ ] Parity with the existing Python and TypeScript judges is asserted on a shared fixture.
- [ ] Unsure input waits; the decision fails closed.
- [ ] No new command list is invented.

## Answer

70 done — `cascade/floor.py` adds `FloorArbiter` (hold = silent/speaking/thinking on the injected clock) + `FloorDecision`; `arbitrate(text, barge_probability=...)` returns `take_floor|backchannel|wait` by delegating to `turns.floor_decision`, so the existing command/filler sets and the 0.65/800ms policy are reused, not re-declared.
take_floor counts `yield`, backchannel counts `backchannel` (existing ledger counters), unsure/empty/silent waits; a thinking hold is already past the talk-over window (no agent audio to echo) and `agent_speaks` is idempotent per speech segment. Vocabulary is take the floor / yield / wait — no `commit`, no cancel mechanics (ticket 88's), no prefetch (72).
A caller `speechStart` while the agent speaks is arbitrated (`arbitrate_speech_start` → wait, no words yet) and never a reply; the `speechComplete` remains the only reply trigger (composition test with EventRules: 0 model requests until the final).
Parity: one shared table `voni/src/lib/voice/floor-cases.json` (24 cases) read by `cascade/test_floor.py` and `voni/src/lib/voice/floor-parity.test.ts`; cascade action, bridge `heuristic_barge_in_score`/`classify_user_turn` and browser `judgeOverlap`/`isCommandBargeIn`/`isFillerOnly` agree, and yes/yeah are pinned soft-confirm (never command, never filler, never cut). The one deliberate divergence — a command inside 800ms waits on the cascade while the browser judge yields — is recorded in the table and the mapping test.
Tests: Python Ran 940, OK (17 new in `cascade/test_floor.py`); TS `node --import tsx --test src/lib/voice/floor-parity.test.ts` → 5 pass; `npm run typecheck` pass. Red-proofed by forcing decisions to wait (4 failures), removing the thinking window (thinking test fails) and re-arming the speech window per frame (1 failure); TS red-proofed by emptying `commands.listen` (2 failures).
Branch `cluster/orch-68-70`, base `8ff36c2a`, commit `e3de76ba`; `git merge feat/meta-cascade` → "Already up to date". Merger: new TS files under `voni/src/lib/voice/` (no existing file edited); run full `npm test`.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
