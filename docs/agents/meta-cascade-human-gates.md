# Meta cascade — human gates

The code is complete. These are the only tickets that cannot be closed by an
agent: they need a vendor key, a human ear, an operator action, or a signature.
Everything below names the command and the artifact to record. Ticket 04's
values are already in `voice-pipeline/cascade/thresholds.json`.

The instruments behind these commands are on
`integration/human-gate-instruments` (`1b9719f2`): the key-gated
`spike.run --live`, `scripts/probe_voices.py`, `npm run readiness:pack`, and
`scripts/routing_switch.py`. They record evidence; they do not record a
verdict, bind a voice, sign, or flip a live switch. Exit codes are part of the
record: `2` means refused before any vendor call, `3` means the run is
incomplete and must not be read as a PASS, `1` means the instrument found a
failure, and `0` means it completed.

## 14 — M0 feasibility decision

**Resolved 2026-10-30: FAIL, with a dated owner risk acceptance.** The commands
below remain for reproducibility; do not record a PASS. See ticket 14 and
`.scratch/meta-cascade/evidence/2026-10-30-m00-and-german.md`.

**Needs:** `META_API_KEY`, `ASSEMBLYAI_API_KEY`, `AI_GATEWAY_API_KEY`.
Use the app's funded AssemblyAI key in `voni/.dev.vars`; a stale key in `.env`
returns HTTP 402 `insufficient_funds` and is not a voice or latency result.

```
cd voice-pipeline
../telephony-bot/.venv/bin/python -m spike.run --offline   # no keys: AT RISK
../telephony-bot/.venv/bin/python -m spike.run --live \
  --wav /path/caller-20s.wav --json --out /tmp/m00-live.json  # needs both keys
```

`--wav` is required: a real 24 kHz mono 16-bit PCM speech recording. The
synthetic ticket 09 fixture is a harmonic tone, the live vendor emits no
`speechEnd` for it, and it is offline-only; without `--wav`, or with a WAV of
another rate/channel count/width, the run refuses with exit `2` and names the
reason (it never resamples). The run metadata records the WAV's path, sha256
and last-sample-above-silence position.

`--offline` names every unmeasured term and its producer. `--live` measures all
five on the wire and takes the timing lock; it exits `3` if any term is still
unmeasured, so an exit `0` is the only run that can be recorded as PASS or a
complete AT RISK. Do not record a PASS from the offline report, and do not
record a PASS without all five numbers.

Record in `.scratch/meta-cascade/issues/14-feasibility-decision.md`: PASS /
AT RISK / FAIL, the five numbers, the date, and stop-or-proceed. An AT RISK
with a structurally large term needs an explicit decision, not silence.

## 130 — German voice probe and re-cast

**Needs:** `ASSEMBLYAI_API_KEY` and your ear.

The German slot is **`jorg`** in the app catalogue, the vendor's **`aai-jorg`**.
The catalogue id stays bare: the TTS path prefixes it (`voice_binding.vendor_voice_id`),
exactly as `voni/scripts/measure-voice-levels.mts` does. The pre-re-cast
`juergen` (`aai-juergen` = `422 voice_not_found`) remains a named **historical
unbound** row, so naming it is refused by name and it can never become a silent
fallback or be re-cast to another Locale.

Evidence so far (machine-recorded, not an audition): probe results in
`.scratch/meta-cascade/evidence/2026-10-30-m00-and-german.md` (`aai-gunther`,
`aai-jorg`, `aai-magdalena` render German; `juergen`/`aai-juergen` 422); native
level for `jorg` is −24.93 LUFS (`-5.96 dBTP`, volume 100) in
`voni/evidence/voice-levels/levels.json`; the product clip is
`voni/public/voices/cascade/jorg.wav` with its row in
`voni/evidence/cascade-clips/clips.json`.

Probe candidates against `POST https://tts.us.assemblyai.com/v1/speech` with
`voice-pipeline/scripts/probe_voices.py` (or `voni/scripts/measure-voice-levels.mts`).
It defaults to `juergen`/`aai-juergen` (the historical 422 pair), any
`--voice-id` you add, and the catalogue `de` ids via `--catalogue-de`:

```
cd voni && npm run voice:catalogue > /tmp/de-voices.json
cd ../voice-pipeline
../telephony-bot/.venv/bin/python scripts/probe_voices.py \
  --catalogue-de /tmp/de-voices.json \
  --voice-id aai-gunther --voice-id aai-jorg --voice-id aai-magdalena \
  --out /tmp/german-probe
```

The script records the HTTP result per candidate and saves any rendered WAV for
audition; it prints a suggested binding but never edits `voice_binding.py`.

The remaining human work on 130 is **the owner's audition** of
`/voices/cascade/jorg.wav` and the managed preview `/voices/jorg.mp3` (rendered
from jorg's committed cascade clip, because the Voice Agent API does not serve
`jorg`; its evidence row records `source: "cascade-clip"`), plus reviewer and
date. Do not record an audition, verdict or signature on the owner's behalf. If
the owner rejects `jorg`, German returns to an open Locale — not beta, not
dropped, not re-cast to another Locale.

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

```
cd voni
npm run readiness:pack -- \
  --manifest /tmp/readiness.json \
  --tenants /tmp/eligible-tenants.json        # under routing=all
```

Exit `0` means ready; `1` means blocked with the subject named; `2` means the
manifest itself is invalid. The pack verifies the two runs are the last two
consecutive runs from the supplied run history; no history is a blocker, not a
pass. The manifest contract and file map are in
`docs/agents/demo-scoreboard.md`.

## 153 — Rollback rehearsal

**Needs:** an operator and a running deployment.

1. Set the durable routing switch to `off`.
2. Start a new call: it must route managed, with zero cascade sockets.
3. Let a live cascade call finish; confirm it was not moved.
4. Set routing back to `all`.

```
cd voice-pipeline
../telephony-bot/.venv/bin/python scripts/routing_switch.py show
../telephony-bot/.venv/bin/python scripts/routing_switch.py set \
  --mode off --operator "NAME" --reason "153 rollback rehearsal"
# ... run the calls, then:
../telephony-bot/.venv/bin/python scripts/routing_switch.py set \
  --mode all --operator "NAME" --reason "153 rehearsal complete"
```

The command reads one store: `CASCADE_STORE_PATH` (sqlite) or `DATABASE_URL`
(Fly Postgres), never a hidden default. Record the date, operator, the switch
record version from `show`, the call ids and the socket count. The rollback is
a runtime switch, not a deploy. A memory is not a record.

## 154 — Two signatures

**Needs:** two different people. The owner signs quality; one named engineer
signs the system. Each names the artifact it covers and the date. The same
person twice is invalid; an unsigned half blocks cutover.

## 155 — Cutover to all eligible subjects

Preconditions: 152, 153, 154 and 119 complete; 04 values recorded.

1. Set `routing=all` with `scripts/routing_switch.py set --mode all
   --operator NAME --reason "155 cutover"`.
2. Confirm every eligible subject runs cascade and every ineligible body
   routes managed with a named reason.
3. Confirm `routing=off` still routes a working managed product (`set --mode
   off`, place a call, then return to `all`).
4. Cite the artifact path and run ids in the decision record.
5. If the kill criterion fired, attach the explicit dated risk acceptance —
   silence is not an acceptance.

## 161 — Managed decommission

Do not do this at cutover. After a recorded stability window with no rollback:

1. Prove `off` routes a working managed product; record it (`set --mode off`,
   place a call, `show` the switch record, then return to `all`).
2. Name a deployable previous version as the real rollback.
3. Record the window, the date, the owner and the engineer.
4. Remove managed only then. If the window is incomplete or a rollback
   occurred, managed stays.

## 156–158 — Phone

Still blocked behind 155 and a phone delivered-audio instrument that does not
exist. Do not claim phone parity before the instrument measures what the
caller hears.
