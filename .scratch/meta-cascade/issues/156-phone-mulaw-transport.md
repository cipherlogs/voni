# 156: Phone transport: 8 kHz mu-law in, native mu-law out

**What to build:** The phone adapter carries 8 kHz mu-law in 20 ms frames, decodes to 24 kHz mono for speech recognition, and synthesizes native mu-law at 8 kHz. It is paced at 8,000 bytes per second and never forwards audio as fast as it arrives.

**Blocked by:** 155 (Cutover, or close with the evidence)

**Status:** ready-for-agent

- [ ] Phone audio arrives as 8 kHz mu-law in 20 ms frames and is decoded to 24 kHz 16-bit mono for recognition.
- [ ] Synthesis is native mu-law at 8 kHz, not resampled from 24 kHz.
- [ ] Mu-law is paced at 8,000 bytes per second and never forwarded as fast as it arrives.
- [ ] A recorded frame sequence asserts the decoded rate and length.
- [ ] The phone transport does not change a browser budget.
