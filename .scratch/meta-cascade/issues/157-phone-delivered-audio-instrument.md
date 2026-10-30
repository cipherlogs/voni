# 157: A phone instrument that measures what the caller hears

**What to build:** The phone path is blocked until a call is measurable as delivered audio through a carrier-side or bot-side capture, not the platform's recording. Without it, no phone quality claim can be made.

**Blocked by:** 156 (Phone transport: 8 kHz mu-law in, native mu-law out), 155 (Cutover, or close with the evidence)

**Status:** ready-for-agent

- [ ] The instrument captures what the caller actually hears, not the platform's recording.
- [ ] It is a carrier-side or bot-side capture with a named provenance.
- [ ] A phone call is measurable as delivered audio before any cutover claim.
- [ ] A missing instrument blocks the phone path with a named reason.
- [ ] The browser's delivered capture is never reused as a phone claim.
