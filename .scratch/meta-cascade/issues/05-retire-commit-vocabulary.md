# 05: Retire commit vocabulary on the cascade

**What to build:** The cascade stops speaking of commit. The decision the orchestrator makes is to take the floor, yield or wait, and the naming follows. This is a behaviour-preserving rename across cascade code, tests and docs before the orchestrator is rebuilt, so the new vocabulary cannot be mistaken for the managed path's commit concept.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] No cascade code path, event name or test helper is named commit; a naming test fails if one is reintroduced.
- [ ] Behaviour is unchanged: the existing orchestrator and turn tests pass with only names changed.
- [ ] The managed path keeps its own vocabulary untouched.
- [ ] The project glossary records commit as not cascade vocabulary.

## Answer

05 done — commit retired from the cascade surface; decision vocabulary is now `take_floor` / `wait` / `backchannel` (`FloorAction`, `floor_decision`, `MIN_FLOOR_WORDS`); behaviour unchanged, no logic touched.
Files: `voice-pipeline/{turns,orchestrator,metrics}.py`, `voice-pipeline/{test_turns,test_orchestrator,test_metrics}.py` (renames only), new `voice-pipeline/test_naming.py` (bans the word across all `voice-pipeline/**/*.py`; exemptions pinned with reasons: `providers.py` out-of-scope prose, `server.py` git sense, `backends/`+`scripts/` vendor/dev), `voice-pipeline/README.md`, `GLOSSARY.md` (records commit as not cascade vocabulary; `CONTEXT.md` already had `_Avoid_: commit`).
Tests: `cd voice-pipeline && telephony-bot/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → Ran 94 tests, OK (92 at dispatch + 2 naming); red case proven first (naming test failed naming 4 files before the rename).
metrics.py diff surface (3 hunks, for ticket 02 rebase): docstring line 6 `final/floor_take`; `MARKS` entry `"commit"` → `"floor_take"`; `summary()` row `"commit_to_first_playout"` → `"floor_take_to_first_playout"` with `"floor_take" if "floor_take" in self._marks else "final"` — the dishonest `else "final"` fallback is untouched, 02 owns replacing it with N/A.
Merger notes: branch `ticket/05-retire-commit-vocabulary`, base 20751132, `git merge feat/meta-cascade` → "Already up to date"; ticket 02 must target `floor_take_to_first_playout`; `providers.py:12,98` still say "commit gate"/"committed messages" (out of my write scope — doc-only follow-up); upstream `backends/` docstrings, `telephony-bot/`, managed TS untouched.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
