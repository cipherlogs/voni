# Ticket 03 — Bounded English acknowledgement palette (owner-veto draft)

Decision record only. No prod behavior changed. Wiring (ticket 04) is blocked until the owner records a veto pass on this ticket.

## Existing seams (grep-only, per ticket)

- `voice-pipeline/cascade/ack.py` — tone groups `thinking / sympathetic / acknowledging / surprise`, per-locale table (this pass: English only).
- `voice-pipeline/cascade/greeting.py` — greeting spoken before caller audio; skipped when caller speaks first.
- `voice-pipeline/cascade/hedge.py` — one bounded hedge on the model turn (loser cancelled, never spoken).
- `voice-pipeline/cascade/floor.py` — filler-only caller turns never take the floor.

## Proposed bounded English palette (13 lines, en only)

Grouped by the existing tone groups, plus one short statement-cover group.
Fast judge picks tone-or-none; pipeline rotates inside the tone without repeating the previous line.

- **thinking** — question / unreadable final only (3):
  `Let's see.` · `One moment.` · `Let me think.`
- **sympathetic** — caller complaint only, never cheerful (2):
  `Ah, I see.` · `Sorry to hear that.`
- **acknowledging** — neutral / positive final only (3):
  `Okay.` · `Yeah.` · `Got it.`
- **surprise** — mild, interested only, sparing use (2):
  `Oh.` · `Oh, nice.`
- **statement covers** — bridge to a substantive reply, max ~4 words (3):
  `Got it, one moment.` · `Let me check that.` · `Good question, one sec.`

Deliberately excluded: bare `Mm.` / `Hmm.` / `Uh-huh.` (the penitential "Hi → Mm" feeling named in the spec), any multi-sentence cover, any non-English line.

## Silence-always rules (unchanged, restated for veto)

Silence wins over any line on: greeting turns (`Hi`, `hello`), filler-only caller turns, or when reply speech already started. Ack stays demo-only: same voice, never captioned, never in call memory, never counted as the reply.

## Other locales

Ship **no new lines** for any non-English locale in this pass. Existing per-locale tables stay in code unoffered.

## Explicitly rejected

An unbounded / exhaustive English list is **rejected**: synthesis cost, caption-leak risk, judge state size.

## Owner veto (record on ticket 03)

- [ ] Approved as-is (list above is the ship list for ticket 04 wiring)
- [ ] Approved with changes (owner writes the exact replacement lines below)
- [ ] Rejected (owner names the still-wrong feeling; next draft addresses that feeling)

Owner changes / notes:


Signed: ______________  Date: ______________
