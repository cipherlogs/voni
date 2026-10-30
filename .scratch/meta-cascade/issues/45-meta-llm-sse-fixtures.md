# 45: Model stream fixtures

**What to build:** Recorded streams replay for a normal reply, a reasoning-first reply, a tool-call reply, a split tool delta, a length stop and an interrupted stream, with usage and finish reasons pinned.

**Blocked by:** 36 (Chat Completions request contract), 39 (Tool-call deltas accumulate by index), 43 (Finish reasons and empty replies)

**Status:** resolved

- [ ] Recorded streams replay for a normal reply, a reasoning-first reply, a tool-call reply, a split tool delta, a length stop and an interrupted stream.
- [ ] Usage and finish reasons are pinned per fixture.
- [ ] A changed known field fails by name; an unknown additive field is ignored.
- [ ] The suite runs in the Python CI job with no vendor key.

## Answer

Ticket 45 done: six committed text fixtures under `voice-pipeline/cascade/fixtures/meta_llm/` replay end-to-end through `MetaLLM` + the scripted session factory: normal reply, reasoning-first, tool-call, split tool delta, length stop, interrupted stream.
Each fixture pins `spoken` deltas, content, reasoning, finish reason, outcome/speak/retry/truncated/filtered/hold-line, accumulated tool calls and every usage unit (`measured` included), so usage and finish reasons are pinned per fixture; the interrupted stream pins `finish_reason: null` and `usage.measured: false`, never zero.
Drift is by name: `assert_parity` reports every moved field as `fixture '<name>' drifted at <field> ...`; an edited stop→length recording fails `test_normal_reply_replays` with the fixture name, and the fixture loader refuses unknown/unpinned document fields by name. Unknown additive SSE fields (`service_tier`, `system_fingerprint`, per-delta `vendor_extension`) are ignored by the projection.
Tests: `cd voice-pipeline && .../python -m unittest cascade.test_meta_llm_fixtures` = 14 OK; full discover = 826 OK; a replay with `os.environ` cleared proves no vendor key is needed. Guard test fails if a fixture file is added without a test.
Files: `voice-pipeline/cascade/fixtures/meta_llm/*.json`, `voice-pipeline/cascade/test_meta_llm_fixtures.py`; branch `cluster/llm-40-45`, base 03ad6476.
Merger notes: `cascade/fixtures/` is data (no `__init__.py`), committed and discovery-safe; re-record by updating `chunks` + `expect` together — changing only one fails by fixture name.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
