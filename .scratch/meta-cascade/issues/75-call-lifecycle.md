# 75: Call lifecycle and the end message

**What to build:** A call opens speech and voice, verifies the body and bindings, then streams. A stop or a dropped socket drains and ends, and the end message carries the ledger, the provider table, the cost and the eligibility facts.

**Blocked by:** 67 (Event rules: the final is the only reply trigger), 22 (Speech ladder: Meta, AssemblyAI, then fail), 23 (Model ladder: Spark, gateway, then fail), 47 (Synthesis connect per transport)

**Status:** resolved

- [ ] A call opens speech and voice, verifies the body and bindings, then streams.
- [ ] A browser stop or a dropped socket drains and ends; neither hangs.
- [ ] The end message carries the ledger, call-level provider table, cost and eligibility facts.
- [ ] A call that cannot verify the body or binding ends with a named error before any vendor socket.
- [ ] The lifecycle is tested with fakes and the injected clock.

## Answer

75 done — new `cascade/call.py` fixes the call order: verify the signed body (`verify_envelope`) and its binding (`adapt_body`) first, then open speech, voice and optional model through injected factories, then `CallStream.start()` and the audio/event pump, then drain under the named `deploy.drain_max_wait_ms` bound, then send the end message. A body/envelope/binding/eligibility failure opens zero vendor sockets and returns a named `CallRefused` (`stage` + real exception name). End message carries `metrics`, the call-level `{stt,llm,tts}` provider table (missing leg is `null`), `cost` (unmeasured = `quantity: null`, `totalUsd: null`), `eligibility` facts, `turns`, `endedBy`, `drain`.
Drain, every close and the event-pump wait are bounded; a hanging fake yields `DrainTimedOut` and still sends the end message. While the drain bound is open the call ends with `UnsetBoundError` rather than an invented number.
Wiring seam for ticket 65: implement `CallTransport` (`async receive()` → `cascade.call.AudioFrame|BrowserStop|ContextUpdate` or `None` on drop, `async send(dict)`, `async close()`) and `CallStream` (`start/event/context/drain/turn_count`), then `await CallLifecycle(message=<signed {envelope,body}>, secret=…, call_id=…, transport=…, open_speech=…, open_voice=…, open_model=…, stream=…, drain_bound_ms=<registry value>, cost_meter=…, eligibility=…).run()`. Do not send a second end message from transport.
Tests: `cd voice-pipeline && …/python -m unittest discover -s . -p 'test_*.py'` → Ran 935, OK (16 new in `cascade/test_call.py`; fakes + `FakeClock`). Branch `cluster/turn-74-75`, base `8ff36c2a`, commits `fc7c730c` (74), `3f8b9927` (75); merge with `feat/meta-cascade` up to date.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
