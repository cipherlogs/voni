# Studio — Record, Rate, Corpus and Baseline (tickets 23–25)

The local-only Studio where the owner records caller takes, rates a certification
blind, and browses the corpus. It is a script process, not a Next route: nothing
under `voni/src/` imports it, so a deployed build cannot contain it.

## Run it

```sh
cd voni
npm run demo:studio
# demo:studio: recording at http://127.0.0.1:4317
```

Flags passed after `--`: `--port <n>`, `--host <loopback>`, `--root <dir>`,
`--dialogues <dir>`, `--evidence-root <dir>`, `--rating-root <dir>`. Hosts
other than `localhost`, `127.0.0.1` and `::1` are refused. `NODE_ENV=production`,
`VONI_STUDIO_TARGET=production` and `STUDIO_TARGET=production` refuse to start
(exit 2, `studio-not-local`).

The four surfaces are `/` (Record), `/rate` (Rate), `/corpus` (Corpus) and
`/baseline` (the zero-typing human-baseline flow).

Takes land in `voni/.studio/` (gitignored): `takes/take-000001/take.json` and
content-addressed audio in `blobs/<sha256>.<format>`. The audio is hashed on
arrival with the digest ticket 10's corpus loader uses and is never edited in
place. Re-record appends a new take that names the one it supersedes; the
earlier record and hash stay readable.

## Record modes

- **One-shot line** — type the prompt card, record, then label and save.
- **Dialogue** — load an authored script (`dialogues/*.json`) or paste one;
  each turn is a prompt card, recorded in order. Every landed take cites the
  dialogue, line id, turn number and card text.
- **Upload** — choose an existing WAV, WebM, Ogg, MP3 or M4A file; it lands like
  any recorded take.
- **Re-record** — from the takes list, "Re-record this take" loads its prompt and
  labels. Saving creates a new take; the old one is untouched. The chain is
  linear: a superseded take shows "superseded by take-00000N" instead of a
  re-record button, so the latest take is the one in use.

Every take requires the three labels (`intent`, `emotion`, `accent`) supplied
by the owner. There is no default and no inferred value: a missing label is a
named refusal, never a guessed one.

## Dialogue script format

```json
{
  "schemaVersion": 1,
  "name": "booking-basic",
  "locale": "en",
  "turns": [
    { "line": "open", "text": "Hi, I'd like to book a table." },
    { "line": "time", "text": "Friday at seven, please." }
  ]
}
```

No dialogue scripts are committed yet: the spec does not define a caller
script vocabulary, so the owner authors them. A malformed script is refused by
file name.

## Rate

Load a certification pack (JSON: `{ certificate, calls }`) with a reviewer and
an optional seed. `calls` entries carry `callId`, `scenario`, `locale`,
`transcript`, `timeline`, and `audio` (`path` relative to `--evidence-root`,
`sha256`); an optional `baseline` adds the blind A/B pair.

- **Blind.** The payload the page receives has no verdict, model/vendor
  identity, call or scenario id, hash, or answer key. Playback names the pair
  only `A` and `B`.
- **Queue.** Every call in a certificate scenario with a failing property is
  queued; all failing calls come ahead of the clean sample. Each group is
  shuffled with the session seed, so the order is not the evidence order and is
  reproducible from the seed.
- **Seven axes.** `stayOnCall`, `soundsHuman`, `turnTaking`, `understanding`,
  `languageNaturalness`, `warmth`, `pacing` — each 1–5. A missing or unknown
  axis is a named refusal.
- **Free text and defect tags** are stored with the rating. Tags are
  lowercase kebab-case; the vocabulary is the owner's, and an empty tag is
  refused.
- **Attribution.** Every rating names its `sessionId`, `reviewer`, `ratedAt`
  and the call it judged. The session records the reviewer and date the
  certificate signature (ticket 27) needs; `/export` returns the gold-label
  document.

A session is written once under `<root>/rating/sessions/<session-id>/`; a
rating is written once per item under `ratings/`. Evidence is rehashed on
creation and again on every serving; a changed file is `audio-drift`, and a
path outside `--evidence-root` is refused.

### Panel sample and the owner's signature (ticket 27)

`POST /api/rate/sessions` with `"panel": true` builds the panel sample instead
of the plain Rate sample: twelve calls total, two per Locale as the base, the
two worst remaining failing calls in the extra slots, and every failing call
mandatory (a run with more than two remaining failures grows past twelve rather
than dropping one). A missing Locale, a Locale with fewer than two calls, a
failing call with no evidence, a duplicate call, or a run with fewer than
twelve calls is a named refusal. The seven axes are `stayOnCall`, `soundsHuman`,
`turnTaking`, `understanding`, `languageNaturalness`, `warmth`, `pacing`,
verbatim.

After the owner rates the blind session,
`npm run demo:certificate -- --panel <session-id> --reviewer <name>` exports the
gold labels, signs the certificate, completes H7 and writes the certificate
back. Signing refuses a different run or target, a missing or different
reviewer, a missing or different date, an incomplete panel and an already-signed
certificate by name. `npm run demo:certificate -- --certificate <path>` reports
an unsigned certificate as `pending-human` and exits 3; it is never a pass.

## Corpus

Browse every take with its sha256, labels, audio, baseline consent and
retirement state. **Retire** writes `retired.json` beside the untouched
`take.json`: the take and its bytes stay readable, but `selectable()` excludes
it, so a new scenario cannot choose it. A retirement needs a reviewer and a
reason, and a second retirement is refused.

The **human-baseline capture** form records a participant pseudonym, consent
reference, consent date, call number, labels and audio (recorded or uploaded).
The consent block is written into the take at landing; a baseline take without
complete consent is refused by name. Baseline takes are blind comparison audio,
never a certification input, so they are never selectable by a scenario.

## One-button baseline flow (`/baseline`)

The owner only presses record, speaks and presses stop. The flow has no text
field anywhere, asks for no date and no path, and never asks for a real name.

1. **Setup.** Tap 3, 4 or 5 participants. Each row shows its pseudonym
   (`participant-01` …) and a one-tap accent selector (`en-US`, `en-GB`,
   `en-IN`, `en-NG`, `en-IE`, `en-AU`, `other`, `unspecified`; default
   `unspecified`). Tick "Signed consent for every participant is filed outside
   the repo", then Start.
2. **Consent.** Start writes `voni/.studio/consent/<participantId>/consent.md`
   from that attestation: the pseudonym, the server clock's date and "signed
   original filed by the owner outside the repository". The pointer is written
   once; a later session reuses the date already filed instead of re-dating it.
3. **Recording.** One participant at a time: call 1 (scripted booking), a
   five-minute break with a Next button, then call 2 (unscripted service
   problem). The screen has one Record/Stop button, a live mm:ss timer and the
   fixed labels. Stop lands the take through the same MediaRecorder →
   `/api/takes` upload path as the other surfaces: the take store hashes it and
   writes the baseline consent block. A call shorter than 4:00 or longer than
   6:00 is refused by name (`wrong-duration-band`) before it is stored — the
   page refuses on its timer, and the server measures the bytes with the
   verifier's own durater. Stop with a little margin (about 4:10–5:50) so the
   measured audio, not the wall clock, is comfortably inside the band.
4. **Finish.** **Pin baseline** runs the existing `baseline.ts` pin
   (`--record` semantics) and then the ordinary verification. Exit 0 prints the
   hash list; a refusal is shown with its code (`manifest-exists` for a second
   pin, `wrong-duration-band`, `missing-consent-reference`, …). Nothing is
   reimplemented: hashing belongs to `take-store.ts` and the checks to
   `baseline.ts`.

Labels are fixed by the plan, not guessed from the audio:

| Call | Intent | Emotion |
| --- | --- | --- |
| 1 | `booking-inquiry` | `neutral` |
| 2 | `service-problem` | `frustrated` |

The accent label is the participant's selector value, verbatim. A baseline take
still carries `participantId`, `call` 1|2, `consentRef` `<id>/consent.md` and the
consent date; the take store refuses an incomplete consent block.

The `/corpus` **human-baseline capture** form still exists for a take recorded
outside this flow; both paths land through the same store and the same verifier.

## Human baseline verification

The baseline is three to five consenting people, two calls of four to six
minutes each, used only as blind comparison audio. The owner records it; the
verifier proves it is complete and unchanged:

```sh
cd voni
npm run demo:baseline:verify -- --record   # pin the hash list once, after capture
npm run demo:baseline:verify               # reproduce the pinned list
```

It rehashes every baseline take, measures each call's length, checks the consent
reference beside the takes, requires exactly calls 1 and 2 for each participant,
and refuses a baseline take that is selectable or appears in a committed
certification artifact. Exit 0 pass, 2 named refusal. `--record` never
overwrites a pin. The session plan and owner runbook are in
[`docs/demo-human-baseline.md`](../../../docs/demo-human-baseline.md).

## What is deliberately not here

- No take editing, renaming or deletion; retirement is a mark, and promotion
  into a committed corpus is a deliberate human act.
- No automatic promotion from a Studio take into `scenarios/corpus/`; the
  corpus loader verifies committed takes and the Studio never edits it.
- No network reachability: loopback only, and a non-loopback `Host` is refused
  by name (`studio-not-local`).

## Tests

`npm test` discovers `scripts/studio/*.test.ts`:

- `take-store.test.ts` — hashing against a pinned worked example, label
  storage, one-shot/dialogue/upload landing, re-record lineage, drift refusal,
  retirement without mutation, baseline consent.
- `rate.test.ts` — blinding, randomized order, queue completeness, the blind
  A/B pair, the seven axes and attributable ratings.
- `rating-store.test.ts` — session persistence, evidence hashing and drift,
  opaque A/B serving, one-rating-per-item and gold-label export.
- `server.test.ts` — the loopback routes, production-host refusal, label
  refusal, dialogue loading, retirement, baseline consent and the Rate routes.
- `baseline-flow.test.ts` — the zero-typing flow: the plan for 3/4/5
  participants, the 3:59/6:01 refusals, per-participant consent files, the
  prefilled labels, a page with no text input and a pin that refuses a second
  pin.
- `build-exclusion.test.ts` — no Studio route, no `src/` import, no Next config
  entry, production-environment refusal.
