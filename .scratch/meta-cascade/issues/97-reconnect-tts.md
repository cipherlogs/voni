# 97: Voice reconnect resumes from the first unheard point

**What to build:** A dropped voice socket keeps what was already played and re-synthesizes the rest from the first unheard point. A second voice failure ends the call with a visible error, because there is no voice left for a goodbye.

**Blocked by:** 94 (One reconnect per leg, and planned reconnects are separate), 52 (Cancel semantics and the next flush id), 89 (The unheard tail is located from the played position)

**Status:** resolved

- [ ] Audio already played is kept.
- [ ] The remaining sentences are re-synthesized on a new session from the first unheard point.
- [ ] A second voice failure ends the call without a spoken goodbye, with a browser-visible error.
- [ ] The re-synthesis does not repeat a played sentence.
- [ ] A mid-reply socket kill asserts both facts.

## Answer

# 97 — Voice reconnect resumes from the first unheard point

- A dropped synthesis socket is the one failure reconnect: `speak` catches the close (websocket `.code`, a socket that ended, or a send that fails), reopens under the ticket-94 budget, and continues the same reply from its first unheard point — `_unheard_point()` maps the audio **delivered to the consumer** through ticket 89's `resume_point` (first unheard word when this session has boundaries, else the first sentence not fully played) and appends the sentences never sent. No fully played sentence is re-sent; a partly played one may repeat (spec: a short repeat is OK, a lost word is not).
- Budget is one counter: `AssemblyAIStreamingTTS(..., ledger=, budget=)` uses `ReconnectBudget` (`reconnect_budget` property); `_retry_used` is deleted and `retry_allowed` reads `counters("tts").budget_left`. A second trigger raises `SynthesisCallFailure` (visible, `call_ended`, no fallback) and opens the breaker; there is no spoken goodbye (99 owns the end message). `3008`/expiry calls `budget.planned("tts", ...)`, sets `needs_reconnect`, and does **not** reopen inside the reply: the current reply drains (unheard tail abandoned) and the next `speak` opens the session between turns — no mid-sentence reconnect. A planned reconnect leaves `budget_left` at 1, so a later outage still gets its one reconnect.
- `_reopen` now archives the old session's `requests` into `closed_sessions` (a new session restarts `flush_id`, so one map cannot hold both) and resets `flush_id`/`word_boundaries_status`. `_timeline` treats the last request without `FlushDone` as open-ended (`inf`) instead of zero-length, which is what lets a mid-request position land on the in-flight sentence; an unfinished *older* request keeps zero length so it cannot swallow a later reply.
- Tests: `cd voice-pipeline && …/.venv/bin/python -m unittest discover -s . -p 'test_*.py'` → **Ran 1465, OK (skipped=1)**; 10 new in `cascade/test_tts_reconnect.py` (mid-sentence kill, mid-reply kill, kill before any audio, no-repeat, second failure, budget identity/counters, 3008 mid-reply drain + between-turn open, planned-then-failure). Red-first shown; mutation checks (drop `budget.planned`, resume the whole reply, disable resume) each go red. `test_tts_close_policy.py` updated: a trigger after audio is now retried (97 supersedes ticket 55's "no retry after audio"), still one per call.
- Branch `cluster/tts-97`, commit `a50bea19`, base `06f9f097` (= `feat/meta-cascade`; merge says "Already up to date"). Merger notes: pass one `ReconnectBudget` per call into the TTS session (95 already does this for STT); `handle_close` gained an optional `reason=` and `CloseDecision` gained `resume`/`resume_text`; 99 should map the terminal `SynthesisCallFailure` onto the end message (`trigger` already carries leg/code/class) and must not synthesize a goodbye through the dead voice; 98 owns the call-level `seq`/epoch bump on a TTS reconnect (the adapter does not call `CallLifecycle.session_reconnected`).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
