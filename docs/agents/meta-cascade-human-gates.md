# Meta cascade — human gates

The code is complete. These are the only tickets that cannot be closed by an
agent: they need a vendor key, a human ear, an operator action, or a signature.
Everything below names the command and the artifact to record. Ticket 04's
values are already in `voice-pipeline/cascade/thresholds.json`.

## 14 — M0 feasibility decision

**Needs:** `META_API_KEY`, `ASSEMBLYAI_API_KEY`, `AI_GATEWAY_API_KEY`.

```
cd voice-pipeline
../telephony-bot/.venv/bin/python -m spike.run --offline   # works now, AT RISK
# Live terms are the remaining harness work; the offline report names each
# unmeasured term and its producer. Do not record a PASS without all five.
```

Record in `.scratch/meta-cascade/issues/14-feasibility-decision.md`: PASS /
AT RISK / FAIL, the five numbers, the date, and stop-or-proceed. An AT RISK
with a structurally large term needs an explicit decision, not silence.

## 130 — German voice probe and re-cast

**Needs:** `ASSEMBLYAI_API_KEY` and your ear.

Probe candidates against `POST https://tts.us.assemblyai.com/v1/speech` (or
`voni/scripts/measure-voice-levels.mts`) using `voice_id` candidates:
`juergen`, `aai-juergen`, the account-cloned slug, and any catalogue `de`
voice. `juergen` currently returns `422 voice_not_found`.

If one renders: bind it in `voice-pipeline/cascade/voice_binding.py`, render its
clip (`voice-pipeline/scripts/render_clips.py`), and audition it.
If none: re-cast to a catalogue voice declared German, audition, record the
reviewer and date. If no German voice can be bound, German stays **open** —
not beta, not dropped, not re-cast to another Locale.

Record in ticket 130: candidate ids, HTTP results, the bound id, reviewer,
date, and the retired old clip.

## 134 — Cascade audition verdict

**Needs:** your ear on the W2 pack (ticket 133). `cascade-reaudition.ts` builds
the pack; `readyForOwner` says whether every input exists.

Record **accept / withdraw / unresolved**, with date and reasons, separate from
the two ballots. Accept means the content did not hold up; withdraw means it
did. An unresolved pack blocks the Locale and is not a pass.

## 152 — All-subject readiness pack

**Needs:** live clean runs and two ballots per subject.

Minimum: the six demo voices, two consecutive clean runs each, no fallback and
no budget stop, a clean reference+delivered pair, a W2 verdict and two
ballots. Under `routing=all`, every eligible tenant subject must appear too, or
be an explicit dated deferral. One failed subject blocks all.

Every row names the artifact path and its code fingerprint. A missing subject
is a block, not an omission.

## 153 — Rollback rehearsal

**Needs:** an operator and a running deployment.

1. Set the durable routing switch to `off`.
2. Start a new call: it must route managed, with zero cascade sockets.
3. Let a live cascade call finish; confirm it was not moved.
4. Set routing back to `all`.

Record the date, operator, the switch record version, the call ids and the
socket count. The rollback is a runtime switch, not a deploy. A memory is not
a record.

## 154 — Two signatures

**Needs:** two different people. The owner signs quality; one named engineer
signs the system. Each names the artifact it covers and the date. The same
person twice is invalid; an unsigned half blocks cutover.

## 155 — Cutover to all eligible subjects

Preconditions: 152, 153, 154 and 119 complete; 04 values recorded.

1. Set `routing=all`.
2. Confirm every eligible subject runs cascade and every ineligible body
   routes managed with a named reason.
3. Confirm `routing=off` still routes a working managed product.
4. Cite the artifact path and run ids in the decision record.
5. If the kill criterion fired, attach the explicit dated risk acceptance —
   silence is not an acceptance.

## 161 — Managed decommission

Do not do this at cutover. After a recorded stability window with no rollback:

1. Prove `off` routes a working managed product; record it.
2. Name a deployable previous version as the real rollback.
3. Record the window, the date, the owner and the engineer.
4. Remove managed only then. If the window is incomplete or a rollback
   occurred, managed stays.

## 156–158 — Phone

Still blocked behind 155 and a phone delivered-audio instrument that does not
exist. Do not claim phone parity before the instrument measures what the
caller hears.
