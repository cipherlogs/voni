# 96: Model reconnect retries only before speech

**What to build:** A model failure before the first content token may retry once. A failure mid-reply finishes what was already queued and closes at the last complete sentence, so the caller never hears a sentence twice.

**Blocked by:** 94 (One reconnect per leg, and planned reconnects are separate), 42 (Model failure policy by phase)

**Status:** resolved

- [ ] A failure before the first content token retries once.
- [ ] A mid-reply failure drains queued sentences and closes at the last complete sentence, never mid-word.
- [ ] History records the spoken prefix, not the unspoken tail.
- [ ] The next turn sees exactly what the caller heard.
- [ ] A test asserts no repeated speech after the retry.

## Answer

# 96 — Model reconnect retries only before speech

- `_apply_policy` asks ticket 94's `ReconnectBudget`: RECONNECT before the first content token, DRAIN after it, END when the leg's one reconnect is spent; the local `_leg_failures` counter is gone.
- On a reply-phase failure the turn records `spoken_text = last_complete_sentence(content_text)`, so the drain closes at a whole sentence and never mid-word; `unspoken_text` is the dropped tail.
- `assistant_reply_message`/`MessageHistory.append_reply` default to `turn.spoken_text`, so history (and the next request) carries only what the caller heard.
- Retry still yields the reply exactly once; a second failure raises `MetaLLMLegExhausted`, a spoken failure raises `MetaLLMReplyInterrupted` with one POST.
- Evidence: `voice-pipeline/cascade/test_llm_reconnect.py` (6 tests), including the once-only retry and the two-turn history check.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
