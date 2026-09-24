# Leadcalls

Voice-calling AI platform (Voni web app + telephony bot): users create agents, call leads, and run campaigns.

## Language

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
The public, signed-out browser call on the landing page, bound to a stored persona agent.
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
The caller speaking over the agent, which cuts the agent's reply short.
_Avoid_: interruption (unqualified), cut

**Turn preset**:
The single turn-taking setting (silence windows, barge-in delay) shared by every demo call, test call, and copilot session.
_Avoid_: VAD config, turn detection (as a noun for the setting)
