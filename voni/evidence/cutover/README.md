# Cutover records

Committed evidence for the release and cutover gates (ticket 29). These files
are claims about the deployed demo, not run audio: never put a WAV, a trace, a
delivered capture or a PCM file here.

- `monthly-production.json` — the recorded monthly full production
  certifications. One entry per month points at a committed certificate under
  `voni/evidence/certificates/`. The record is scheduled `0 4 1 * *` UTC; an
  empty record is `pending-human` (exit 3), never a green. The dealer is
  `npm run demo:cutover -- --monthly`.
- `post-flip-<run-id>.json` — one short production confirmation after a routing
  flip. It is not a certificate and never becomes one; it is at most ten calls,
  follows one staging certificate for the same image, and records the calls and
  the evidence directory. Validate with
  `npm run demo:cutover -- --post-flip <path> --image <image> --staging <run-id>`.
- `rollback-<date>.json` — the kill-switch proof: routing value `off`, the
  refused call's `managed` code and zero new vendor sessions. The proof is
  produced by `npm run cutover:check -- --prove-off`; record it here, never type
  one by hand.

The production flip itself is the operator's human act
(`npm run cutover:check -- --set production --operator <id> --reason <text>`),
and it is gated on a clean staging certificate for the same image:

```sh
cd voni
npm run demo:cutover -- --streak --target staging
npm run demo:cutover -- --gate --image sha256:<image>
```

A production certificate never inherits a staging green. The monthly full
production certification is the backstop (RR-05).
