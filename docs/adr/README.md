# Architecture decision records

One record per decision that constrains future work. A record is never rewritten to change its decision: a new record supersedes it, and the old one keeps its number. Read the records that touch the area you are working in before changing it.

| # | Decision | Scope |
| --- | --- | --- |
| [0001](0001-bento-signal-green-and-containment.md) | Scoped brand green for bento signals; containment replaces bleed | Landing visuals |
| [0002](0002-builtin-end-call.md) | Built-in `end_call` instead of opt-in call control | Session mechanics |
| [0003](0003-barge-in-recovery.md) | Barge-in: the server stops the agent, Voni recovers | Session mechanics |
| [0004](0004-test-tag-email-matching.md) | Demo email test: find the visitor's email by a Test tag, not a spoken address | Demo scenario |
| [0005](0005-tool-results-send-at-once-except-end-call.md) | Tool results go back at once; `end_call`'s waits for the goodbye to finish | Session mechanics |
| [0006](0006-one-agent-body-builder-with-profiles.md) | One agent-body builder with profiles, one fingerprint | Agent body |
| [0007](0007-pstn-bridge-stays-a-second-implementation.md) | The PSTN bridge stays a second implementation, pinned by behaviour | Phone transport |
| [0008](0008-english-is-one-rendering-not-the-source.md) | English is one rendering of six, not the source of meaning | Locale and rendering |
| [0009](0009-no-beta-no-drop-delivered-audio.md) | No beta tier, no dropped locale, and quality is judged on delivered audio | Quality doctrine |
| [0010](0010-client-never-alters-the-agents-signal.md) | The client never alters the agent's signal | Browser playback |
| [0011](0011-owned-cascade-with-meta-muse.md) | An owned cascade: Meta for ear and mind, AssemblyAI for the voice | Tenant path only |
| [0012](0012-demo-cascade-only.md) | The demo runs only on the cascade; the tenant path stays managed | Demo surface |

ADR-0011 is the standing record for the tenant path only. ADR-0012 records the demo surface split, including the withdrawal of Italian from the demo and its reason.
