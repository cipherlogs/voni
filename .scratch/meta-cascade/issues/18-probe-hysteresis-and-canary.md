# 18: Probe hysteresis and the real-call canary

**What to build:** A leg is not declared healthy on one lucky request. Three probe successes, each at least 30 s apart, close it; the first real call after a close is watched, and one failure reopens immediately.

**Blocked by:** 17 (Breaker transitions on a fake clock)

**Status:** resolved

- [ ] Three probe successes each at least 30 s apart close the leg; two successes, or three in a row too soon, do not.
- [ ] One probe failure at any point reopens the leg.
- [ ] The first real call after a close is the canary: one failure reopens immediately without the probe ritual.
- [ ] Removing the hysteresis rule makes the leg close on one success and the test fails.

## Answer

18 done — `cascade/breaker.py` gains `probe_interval_s()` (reads `breaker.probe_interval_ms` from `thresholds.json`), `Breaker.from_registry(store, now=)`, `CANARY_FAILURE_KIND`, `canary_pending(record)` and a canary branch in `record_failure`; `cascade/test_probe_hysteresis.py` is new (11 tests).
Machine: ticket 17's `BreakerTransitions` is reused unchanged — no second state machine. Three probe successes each ≥ the registry interval (30 s, spec-sourced, one number for both the due interval and the spacing) close; two, or three too soon, do not; one probe failure at any point reopens; the first real call after a probe close is the canary: a trigger failure reopens in the next second, emits `trigger.kind == "canary_failure"` and says so in `reason`; a real-call success ends the window; a routine probe does not re-arm it (derived from `lastProbeAt`/`lastSuccessAt`/probe window — no record field added); a bug-class 1008 in the canary still writes nothing (the closed trigger set stays narrow).
Judgments: the canary is derived, not stored, so it survives a restart without changing the v1 record shape (one ambiguity: a routine probe in the same clock second as a real success re-arms it; behaviour is identical, only the trigger kind differs). An unset interval bound raises `UnsetBoundError` by name.
Evidence: `test_probe_hysteresis` 11 tests; red-first (ImportError), then mutations: spacing ignored → 5 fail, canary disabled → 2, interval hardcoded → 1. Full suite 511 OK. Branch `cluster/breaker-18-23`, base 83ea36ed, `git merge feat/meta-cascade` → "Already up to date".
Merger notes: `thresholds.json` gained `breaker.probe_interval_ms` (additive data, ticket 18's own bound); 22/23 read rungs through ticket 19's `choose_rung`, so this file must land before them.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
