# Leadcalls

Voice-calling AI platform (Voni web app + telephony bot): users create agents, call leads, and run campaigns.

## Language

### Brand press kit

**Mark**:
The solo V stroke (`voni-mark-*`).
_Avoid_: arc (the old resting curve), logo (unqualified)

**Wordmark**:
The mark standing in for "V" directly against "oni" (`voni-wordmark-*`).
_Avoid_: logo (unqualified)

**Chip**:
The rounded-square app icon: paper square, ink mark (`voni-chip-*`, avatars).
_Avoid_: icon (unqualified), avatar (outside profile-picture context)

**Lockup**:
A wordmark plus one slogan line (`voni-lockup-{slug}-*`).
_Avoid_: banner, header image

**Slogan**:
The canonical line: "Every call ends with the work already done".
_Avoid_: tagline (retired with "It sees the lead. It seals the deal."), motto

**Alternates**:
The spare-approved slogan lines ("One call, and everything after it.", "The work happens while it's still talking.") — one per surface, never stacked.
_Avoid_: slogans (plural in a single lockup), variants (in press context)

### Settings bento

**Tile**:
The card on the settings landing linking to one settings area.
_Avoid_: grid, box, card (in settings context)

**Scene**:
The animated background miniature inside a tile that previews its destination.
_Avoid_: bg avatar, background, animation, thumbnail

**Signal**:
The brand-green touch inside a scene: traveling packets, pulse rings, and moment markers — never structure, never text.
_Avoid_: accent, highlight, glow

**Scene option**:
One of the per-tile scene alternatives (`A`/`B`/`C`) offered for review picks.
_Avoid_: variant (in per-tile context)

**Grid variant**:
A full-gallery composition alternative (ticket 01's `V01`–`V10`).
_Avoid_: scene option (in full-grid context)

### Voice calls

**Demo call**:
The public, signed-out browser call on the landing page, where Voni talks as itself through a stored agent (one per voice).
_Avoid_: landing call, trial call

**Test call**:
A signed-in browser call against the agent being edited in the dashboard.
_Avoid_: preview call, inline call

**Copilot**:
The signed-in voice assistant that operates the Voni app itself; it is not a call to a lead.
_Avoid_: voice assistant, agent (in copilot context)

**Reply gap**:
Silence between the end of the caller's speech and the first sound of the agent's reply.
_Avoid_: latency (unqualified), lag

**Barge-in**:
The caller speaking over the agent. The speech service decides when the agent stops; Voni then judges the caller's words: steering or a real point is answered, while filler, a back-channel, or the agent's own echo makes it pick up where it was cut.
_Avoid_: interruption (unqualified), cut

**Overheard speech**:
Caller speech that lands while the agent holds the floor. It renders marked in the transcript and counts in the call ledger; once it cuts the agent, it is answered or resumed from as a barge-in.
_Avoid_: lost audio, missed interruption

**End call**:
The agent ending the call itself: it speaks a closing line, then a built-in tool closes the session. Refused while another tool is still running.
_Avoid_: hangup (as a noun for the agent's action), drop

**Words to listen for**:
Owner-supplied vocabulary on the agent (jargon, product and place names) merged with the words the agent derives from its own name, fields, and tools for speech recognition.
_Avoid_: keywords (SEO connotation), keyterms (STT parameter name)

**Turn preset**:
The single turn-taking setting shared by every demo call, test call, tenant agent call, and copilot session: meaning-based end-of-turn, and a barge-in delay that holds out while the agent explains and drops while it asks something.
_Avoid_: VAD config, turn detection (as a noun for the setting)

**Call trace**:
The post-call record of one call, turn by turn: what the speech service heard and did, with Voni's own decisions alongside.
_Avoid_: session dump, call log

**Input mute**:
Microphone-only mute for a connected demo call or test call. It drops outbound microphone frames, keeps the call and agent playback alive, and sends hidden system context on mute and unmute; it never creates an automatic reply or transcript row.
_Avoid_: call mute (when the agent audio is still playing), pause

**Context message**:
Hidden system instruction attached to the next generated turn. Managed sessions serialize it as AssemblyAI `conversation.message`; cascade browser sessions serialize `{ type: "context", role: "system", content }`. Context is not a caption and does not interrupt current playback.
_Avoid_: transcript message, system caption

**Prospect**:
A demo-call visitor who has shared at least one contact channel; Voni's own potential customer.
_Avoid_: lead (a customer's pipeline record), visitor (once contact is shared)

**Work-email gate**:
The rule that a demo call continues only with a business-domain email address.
_Avoid_: filter, qualification

**Code check**:
The short code in Voni's reply email that the visitor reads back to prove they own the inbox, framed as a test rather than a security step.
_Avoid_: OTP (in visitor-facing copy, until the reveal after it passes names it on purpose)

**Test tag**:
The short word-and-number a visitor puts in their email (asked for in the subject; the body counts too) so Voni can find their email in the shared inbox; kept for a day and across calls from the same browser.
_Avoid_: code, OTP, subject code (confused with the code check)

**Provisional extension**:
Extra demo-call time unlocked when the visitor's email arrives from a business address, before the code check.
_Avoid_: trial time

**Verified extension**:
The full demo-call time unlocked by a passed code check.
_Avoid_: unlock, upgrade

**Hold**:
The paused state of a demo call after the browser stops the page or the connection drops while the visitor is away; the talk clock stops and the call memory is kept for the return.
_Avoid_: mute (the visitor's own mic toggle), pause

**Flap**:
An absence from the page where the connection survives; the call stays live and it never becomes a hold.
_Avoid_: blip, quick switch

**Call memory**:
The turns of a demo call that Voni keeps across a hold return, so it continues where it stopped instead of starting over.
_Avoid_: carryover, context (overloaded with context message)

**Talk clock**:
Demo-call time that counts only while the visitor is present and unmuted.
_Avoid_: timer, duration

### Voice and language

**Voice binding**:
A voice speaks exactly one language natively, and a call's language follows from its voice. We do not offer one voice speaking several languages.
_Avoid_: language switching (for changing voice), multilingual voice

**Locale**:
The single language a call is conducted in: what the agent speaks, what speech recognition listens for, and the language every word it reads or matches is written in. Not just the greeting. A call's locale follows from its voice, except for an agent on automatic language detection, which has no locale and is the one documented exception (English scaffolding, answering in the caller's language).
_Avoid_: language setting, language code (the wire value), translation

**Session mechanics**:
How a call behaves regardless of persona or locale: turn-taking, barge-in and pickup, captions, goodbye drain, playback level. Shared by every call of every agent.
_Avoid_: pipeline, latency work, "the Anna fixes"

**Delivered audio**:
What actually reaches the caller's speaker, after every stage we own. The only signal a quality claim may be based on; the platform's own recording is not it.
_Avoid_: output, stream, recording (when meaning what the caller heard)

**Agent rules**:
The persona-neutral rules every agent follows about how to talk — brevity, steering instead of obeying a passing remark, no corporate filler, never narrating a tool call. Distinct from a tenant's own mission and house rules, and from the demo scenario.
_Avoid_: system prompt (the whole artifact), compiler rules

**Demo scenario**:
The demo-only business flow: test tag, invite-once, work-email gate, code check, stakes ladder, talk clock. Composes on top of agent rules and session mechanics; never applies to a tenant agent.
_Avoid_: demo rules, demo prompt

### Cascade pipeline

**Managed path**:
The AssemblyAI Voice Agent call path, where the vendor owns turn-taking, model choice and tool dispatch. The routing default, and it stays live until the cascade is proven.
_Avoid_: old path, legacy, default engine

**Cascade pipeline**:
Our own speech-to-text → language-model → speech-synthesis path: one core, two transports. The vendor supplies components; it does not orchestrate the call. A specific engine, not a synonym for Session mechanics.
_Avoid_: pipeline (unqualified), new engine

**Turn boundary**:
The moment the caller has finished speaking. Owned by the speech recogniser's endpointing, because Meta exposes no per-turn commit; we never decide it.
_Avoid_: commit, end-of-turn (the managed Turn preset's word)

**Floor arbitration**:
Our decision, while the agent holds the floor, whether an utterance is an interruption (take the floor), a backchannel (counted, answered with nothing), or a wait. It arbitrates the floor; it does not commit a turn.
_Avoid_: commit gate, barge-in (the caller's action, not our decision)

**Provider breaker**:
The durable per-leg switch that sends a leg's traffic to its fallback rung after a rejected request, and returns it once a probe proves the provider healthy. Shared, persisted, visible; never a per-call decision.
_Avoid_: fallback (the rung it selects), circuit breaker (unqualified)

**Fallback-contaminated run**:
A measured run in which any leg used its fallback, or the budget stopped the call. Ineligible for a green, because the stack that produced the number is not the stack being judged.
_Avoid_: degraded run, flaky run
