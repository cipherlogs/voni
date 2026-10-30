# 160: Auto-detect Locale on cascade

**What to build:** A tenant body with no fixed `language_codes` is no longer refused. Speech recognition runs without `languageBias` (Meta auto-detect) while synthesis uses the bound voice's own Locale, which is the only authority for the TTS language. An unbound voice is still refused by name.

**Blocked by:** 46 (Voice binding table), 57 (Stored-body field map), 61 (Body eligibility refusals), 26 (Meta speech handshake), 47 (Synthesis connect)

**Status:** resolved

**Owns:** voice-pipeline/cascade/meta_stt.py, voice-pipeline/cascade/body_map.py, voice-pipeline/cascade/eligibility.py

- [ ] An empty or absent `language_codes` omits `languageBias` from the Meta handshake; it does not invent a language or send an empty list.
- [ ] Synthesis language still comes from the bound voice's Locale, never from the detection result and never from a request field.
- [ ] The call records that auto-detect was used, so the artifact can distinguish it from a fixed-Locale subject.
- [ ] A body with an unbound voice is still refused by name and is not a cascade subject.
- [ ] A mismatch between the `Begin` synthesis language and the bound Locale still fails visibly.
- [ ] Tests: the handshake has no `languageBias`; the Begin echo uses the voice Locale; a fixed-Locale body still sends its bias list; an unbound voice still refuses; deleting the auto-detect branch fails the test.

## Answer

160 Auto-detect Locale on cascade: done, green — 1690 tests on Python 3.14 venv; 14 new in `cascade/test_auto_detect.py`, plus updated eligibility/call/fixture pins.
Files: `cascade/{meta_stt.py,eligibility.py,body_map.py,call.py,test_auto_detect.py,test_eligibility.py,test_call.py,test_body_map.py}` and 15 `cascade/fixtures/stt/*.json` expect pins @ `da1ad91f`, branch `cluster/all-159-160`, base `fa4d1971`; `feat/meta-cascade` merge "Already up to date".
Handshake: `languageBias` is added only when the frozen bias is non-empty, so absent/empty `language_codes` sends no key (no invented `[]`); `MetaStreamingSTT.auto_detect` records the fact once with the bias, so a reconnect cannot switch subjects.
Eligibility: the `locale` predicate is deleted (auto-detect is a fact, not a refusal); `EligibilityDecision.auto_detect` is computed from the raw body and `CallEligibility` writes `autoDetect` on the end message (decision or verified body, whichever the call has); unbound voice still refuses by name.
Synthesis: language still comes from `VoiceBinding.locale` (`lola` auto-detect body → `Spanish`), and a mismatched `Begin` echo still raises `SynthesisEchoError` with nothing sent; fixed-Locale bodies keep `["Spanish"]`.
Red: `test_auto_detect` on base `fa4d1971` ran 14 with 6 failures + 4 errors; merger note: the STT fixtures were deliberately re-pinned to the amended handshake (only `languageBias: []` lines removed).

_Implemented on `feat/meta-cascade`._
