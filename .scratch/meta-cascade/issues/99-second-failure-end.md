# 99: A second failure ends with a drain and a goodbye

**What to build:** When a second speech or model failure ends the call, the caller hears a localized goodbye through the still-healthy voice and the end message names the leg and reason. A voice second failure ends without one.

**Blocked by:** 94 (One reconnect per leg, and planned reconnects are separate), 95 (Speech reconnect replays the turn's audio), 96 (Model reconnect retries only before speech), 97 (Voice reconnect resumes from the first unheard point), 98 (Call-level sequence numbers survive reconnect), 77 (The greeting is spoken before any user audio)

**Status:** resolved

- [ ] A second speech or model failure ends the call with a drain and a localized goodbye through the healthy voice.
- [ ] A second voice failure ends without a spoken goodbye.
- [ ] The end message names the failure leg and reason.
- [ ] A planned speech reconnect at 60 minutes mid-turn uses the failure path: new session, replayed audio, mapped turn.
- [ ] A planned voice reconnect at expiry happens between turns, never mid-sentence.

## Answer

# 99 — a second failure ends the call cleanly

- **What changed.** `cascade/call.py`: an exception escaping the event pump is now
  a call-ending leg failure (`_leg_failure`, named `LegFailure` with the provider
  trigger); the supervisor wakes on a `failure_event` instead of waiting for
  browser input, so a spent reconnect no longer hangs the line. The drain runs,
  then `_speak_goodbye` speaks `GOODBYE_LINES[locale]` through the voice only when
  the failing leg is not `tts` and the session is open; tts leg/closed session is
  recorded as `GoodbyeOutcome(spoken=False, reason=...)`. The goodbye is bounded
  by the existing `tts.idle_timeout_ms` (`GoodbyeTimedOut`) and cannot block the
  end message. `CallEnd` now carries `reconnect` (the ticket-94 budget document)
  and `goodbye`; the one end message still carries ledger, provider table, cost,
  eligibility, bounds and the named trigger.
- **Budget.** The lifecycle takes an optional `reconnect_budget` and shares it
  with the adapters; it only *reports* `budget.to_document()` and never counts a
  failure itself. `session_reconnected()` was already the epoch seam; no second
  counter was added. A planned reconnect is recorded by the adapter that owns the
  leg (tickets 94/95/97) and never ends the call.
- **Tests.** `cascade/test_second_failure.py` (12 tests): hang/red proof, localized
  goodbye, model leg, tts leg without goodbye, one end message with every fact
  group, planned reconnect on stt+tts, failure during the greeting, closed voice,
  hanging goodbye, failing goodbye, catalogue. Command: `cd voice-pipeline &&
  .../.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → **1596 tests,
  OK (skipped=1)** (base 1584).
- **Branch / base.** `cluster/end-99` @ `f79ef1de` (base `43f0d427`, merge
  `feat/meta-cascade` = already up to date).
- **Merger notes.** (1) `GOODBYE_LINES`/`goodbye_line` live in `cascade/call.py`
  as the one localized-goodbye source; ticket 105's ceiling goodbye and ticket
  87's cap line should import it rather than add a second table. (2)
  `test_greeting_timing.py`'s fake speech session was `object()` (no `events()`);
  it now yields nothing, because a pump exception is a call-ending failure by
  contract — no assertion changed. (3) Turn layer (M06) must drain its own
  turn-level failures (400 turn bug, interrupted reply) and let only call-ending
  failures escape `CallStream.event`/`start`. (4) Ticket-95 replay/turn-mapping
  and ticket-97 between-turns expiry are unchanged and already covered there.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
