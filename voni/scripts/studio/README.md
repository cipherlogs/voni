# Studio — Record (ticket 23)

The local-only Record surface where the owner records caller takes. It is a
script process, not a Next route: nothing under `voni/src/` imports it, so a
deployed build cannot contain it.

## Run it

```sh
cd voni
npm run demo:studio
# demo:studio: recording at http://127.0.0.1:4317
```

Flags passed after `--`: `--port <n>`, `--host <loopback>`, `--root <dir>`,
`--dialogues <dir>`. Hosts other than `localhost`, `127.0.0.1` and `::1` are
refused. `NODE_ENV=production`, `VONI_STUDIO_TARGET=production` and
`STUDIO_TARGET=production` refuse to start (exit 2, `studio-not-local`).

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
  labels. Saving creates a new take; the old one is untouched.

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

## What is deliberately not here

- No Rate or Corpus surface (ticket 24).
- No take editing, renaming or deletion; promotion into a committed corpus is a
  deliberate human act, not a Studio button.
- No network reachability: loopback only, and a non-loopback `Host` is refused
  by name (`studio-not-local`).

## Tests

`npm test` discovers `scripts/studio/*.test.ts`:

- `take-store.test.ts` — hashing against a pinned worked example, label
  storage, one-shot/dialogue/upload landing, re-record lineage and drift
  refusal.
- `server.test.ts` — the loopback routes, production-host refusal, label
  refusal and dialogue loading.
- `build-exclusion.test.ts` — no Studio route, no `src/` import, no Next config
  entry, production-environment refusal.
