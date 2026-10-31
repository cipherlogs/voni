# Human baseline — session plan and owner runbook (ticket 25)

**Status: prepared, not captured.** This is a human gate. An agent prepared this
plan and the verifier; the owner and three to five consenting participants
record the calls. Until `npm run demo:baseline:verify` passes on a pinned list,
the axis "preference against the human baseline" (H5) is unverified, and the
residual-risk register records the baseline as absent (RR-04).

The baseline is **three to five people, two calls of four to six minutes each**,
consented and hashed. It is used **only as blind comparison audio** for the
preference property. It is never a certification input, never selected by a
scenario, and never committed: takes and consent stay in `voni/.studio/`
(gitignored).

## What the owner needs

- A quiet room, one microphone, and the same setup for both calls of a person.
- The Studio running locally: `cd voni && npm run demo:studio` (record/corpus at
  <http://127.0.0.1:4317>; the one-button baseline flow is at
  <http://127.0.0.1:4317/baseline>, and the Corpus surface keeps the manual
  baseline capture form).
- `ffmpeg`/`ffprobe` on `PATH` if a baseline take is WebM, Ogg, MP3 or M4A. WAV
  is measured from its header and needs nothing else.
- A pseudonym per participant (`participant-01` … `participant-05`). The repo
  records no participant name, email or phone number anywhere.

## Consent, filed beside the takes

For each participant, before recording:

1. Have the participant read and sign the study consent. Keep the signed
   original in the owner's own filing system, outside the repository.
2. Write a short text pointer beside the takes at
   `voni/.studio/consent/<participantId>/consent.md`. It must contain the
   participant pseudonym and the consent date, and where the signed original
   lives. The `/baseline` setup screen writes this pointer for every participant
   from the owner's one-tap attestation, using the server clock's date; the
   pointer is written once and never re-dated. Example:

   ```text
   participant-01 consented on 2026-11-02 for baseline comparison audio.
   Signed original: owner filing cabinet, study 2026-11.
   ```

3. Enter that path (`<participantId>/consent.md`) as the **consent reference**
   in the Corpus baseline form, with the same consent date. The reference and
   the file must agree; a reference with no file is refused.

Do not put the participant's real name in the repository, in a filename, or in
the consent pointer. The verifier checks the pointer names the pseudonym and
the date, not the person.

## Recording order and script

Run two sessions of two people, with an optional fifth person in either:

| Session | Participant | Call 1 (4–6 min) | Break | Call 2 (4–6 min) |
| --- | --- | --- | --- | --- |
| A | `participant-01` | scripted booking inquiry | 5 min | unscripted service problem |
| A | `participant-02` | scripted booking inquiry | 5 min | unscripted service problem |
| B | `participant-03` | scripted booking inquiry | 5 min | unscripted service problem |
| B | `participant-04` (optional) | scripted booking inquiry | 5 min | unscripted service problem |
| B | `participant-05` (optional) | scripted booking inquiry | 5 min | unscripted service problem |

- **Call 1** uses one authored dialogue script or a one-shot prompt card: a
  caller booking a table or a viewing, speaking at a natural pace.
- **Call 2** is unscripted: the caller describes a real service problem in their
  own words. No agent speaks on either call; this is human reference audio.
- Land each call through the **`/baseline`** one-button flow: tap the
  participant count, tap each participant's accent, tick the consent
  attestation, then press Record and speak. Stop lands the take with the plan's
  labels and the participant's consent block. The manual **Corpus → Human
  baseline capture** form remains for a take recorded outside the flow; both
  paths use the same take store. Never default or guess a label.
- Record call 1, then take the break, then call 2. A tired or rushed call is
  outside the band or unusable; stop and reschedule rather than speed up.
- If a call is bad (clipping, wrong length, interruption), record it again (the
  new take names the one it supersedes) and **retire** the old take with the
  reviewer and a reason before pinning. Do not edit or delete either take.

## What must not be edited after hashing

The take store writes each take once. After a call lands, and again after the
hash list is pinned, these are immutable:

- `voni/.studio/takes/<take-id>/take.json` — including its `audioSha256`,
  `audioBytes`, `baseline` consent block and `recordedAt`;
- `voni/.studio/blobs/<sha256>.<format>` — the exact bytes that were hashed;
- `voni/.studio/consent/<participantId>/consent.md` — the consent reference;
- `voni/.studio/baseline-hashes.json` — the pinned hash list.

No rename, move, re-encode, trim, normalize or "fix the metadata" pass. A
changed take is `edited-take` or `manifest-drift`, and the fix is a new take
plus a deliberate decision, never an in-place edit. Retirement is a mark beside
the take and is allowed only before pinning.

## Owner runbook

1. Start the Studio: `cd voni && npm run demo:studio`.
2. Open <http://127.0.0.1:4317/baseline>. There is no text field in this flow: tap
   the participant count, tap each participant's accent, tick "Signed consent
   for every participant is filed outside the repo", then Start. Start writes
   `voni/.studio/consent/<id>/consent.md` for every participant.
3. Record both calls per participant, in the order above, one participant at a
   time. Call 1 is the scripted booking, then a five-minute break with Next,
   then the unscripted service problem. Each call has one Record/Stop button and
   a live timer; Stop saves through the same take store and refuses a call
   shorter than 4:00 or longer than 6:00 by name (`wrong-duration-band`). Stop
   with a little margin (about 4:10–5:50) so the measured audio is comfortably
   inside the band. Use `participant-01`…`participant-05`; the flow never asks
   for a real name.
4. When the last call lands, press **Pin baseline** on the finish screen. It
   pins the list once and re-verifies it: exit 0 prints the hash list, a refusal
   is shown with its code. The equivalent command is:

   ```sh
   cd voni
   npm run demo:baseline:verify -- --record
   ```

5. Verify the pin reproduces the list:

   ```sh
   npm run demo:baseline:verify
   ```

   Exit 0 is a complete, unedited baseline. Exit 2 is a named refusal; fix the
   cause with a new take, never by editing files. `--record` refuses to
   overwrite an existing pin.

Use `--root <dir>` if the Studio was started with a different `--root`, and
`--manifest <file>` to pin somewhere else. Additional committed artifact roots
can be scanned with `--certification-root <dir>`; the default scan covers the
scenario corpus and `voni/evidence/certificates`.

## What the verifier proves

- Three to five participants, each with exactly one active call 1 and call 2.
- Every call is 4:00–6:00 inclusive, measured from the audio (WAV header, or
  audio packet timestamps via `ffprobe`).
- Every take rehashes to the digest in its record and to the digest pinned in
  `baseline-hashes.json`; an edited blob or a rehashed record is refused.
- Every participant has a consent reference beside the takes, and the file
  names the pseudonym and consent date.
- No baseline take is selectable by a scenario, and no baseline take id or
  digest appears in a committed certification artifact.
- The printed list, in `(participantId, call)` order, is the reproducible hash
  list.

## What remains human

The recording, the consent, the labels and the decision that the take is
usable. The verifier cannot make a call sound human, cannot judge consent, and
cannot widen a three-to-five-person sample. RR-04 stays open after capture: the
baseline is small and the panel is one rater, so taste bias is real.
