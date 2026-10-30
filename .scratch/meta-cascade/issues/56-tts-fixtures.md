# 56: Voice fixtures

**What to build:** Recorded voice frames replay for the opening echo, sentence scheduling, flush math, cancel ordering, keepalive, expiry and termination. A wrong echoed rate or a flush disagreement fails by name.

**Blocked by:** 48 (Begin echo is an assertion), 49 (Sentence scheduling: first sentence flushes immediately), 50 (Audio decode and loss detection), 54 (Termination and the billed character count), 55 (Voice close policy: trigger, bug, expiry)

**Status:** resolved

- [ ] Fixtures pin the opening echo, sentence scheduling, flush math, cancel ordering, keepalive, expiry and termination.
- [ ] A wrong echoed sample rate fails by name.
- [ ] A flush duration disagreement fails by name.
- [ ] The suite runs in the Python CI job with no vendor key.

## Answer

# 56 — TTS recorded fixtures and drift semantics

- Added `cascade/tts_replay.py` (replay + closed document schema) and `cascade/test_tts_fixtures.py` (30 tests); no production adapter change.
- 16 canonical fixtures in `cascade/fixtures/tts/`: Begin echo + sample-rate mismatch, sentence scheduling (first Generate+Flush before any audio), flush maths/audio loss, partial sample, cancel ordering with a skipped flush id, termination billing, close 1000/1006/1011/3005/3006/3008/3010/3011/1009.
- A changed frame fails with the fixture name and drifted field; an additive unknown frame is ignored; an unproducible fixture errors, never skips (missing file, removed Begin, or an adapter exception pinned as drift).
- Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → 942 tests OK (30 new); empty-env run OK; no keys/network.
- Branch `cluster/tts-56`, base 8ff36c2a, commit `bc20c7d2`. Keepalive frames deferred: ticket 53 has not landed, so the adapter has nothing to replay; expiry is pinned through close-3008. Merger: add a keepalive fixture + its producer to `EXERCISED` when 53 lands.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
