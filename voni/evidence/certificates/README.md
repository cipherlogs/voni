# Committed certificates

One certificate per certification run, named `<run-id>.json`. These files are
committed: a readiness statement that cannot cite a certificate for the same
code fingerprint, corpus hash and target is an opinion, however well it is
written. This directory lives under `voni/evidence/` because it is committed
evidence; `voni/certificates/` is the gitignored dev-TLS directory and is not
this one.

Do not put audio, event traces, delivered WAVs or their sidecars here. Those are
gitignored working files (`voni/.captures/`, `voice-pipeline/.events/`,
`voni/.voice-references/`, `voni/scoreboard-runs/`). A certificate records
evidence by path and hash, never by bytes.

Write with the builder and reader in
`voni/src/lib/demo/verification/certificate/`:

- `buildCertificate` creates the claim from one verdict-core run; it refuses a
  pass with no citation, an unknown or omitted residual risk, an unrecorded
  vendor build, and an attempt outside the corpus.
- `validateCertificate` / `readCertificate` refuse an unknown schema version, a
  target or run that does not match, a different code fingerprint or corpus
  hash, a coverage omission or an uncited verdict. A `certified` verdict with
  no panel signature is refused by name; an unsigned clean run is
  `pending-human`, not an error.
- `serializeCertificate` validates before writing, so an invalid claim is never
  committed.

`certificateFile(runId)` resolves a run id to this directory and refuses an id
that is not a safe single path component. Ticket 28 owns the `demo:certificate`
CLI that signs and writes these files.
