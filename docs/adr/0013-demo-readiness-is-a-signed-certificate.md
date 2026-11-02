# Demo readiness is a signed certificate, not a promise of perfection

**Status: accepted. Decided 2026-10-31 (grilling session; the decisions recorded here were agreed, not proposed).**

**Amendment, 2026-11-02 (owner).** Voni ships English only. A certificate's
Locale set is now a declared scope and an input, never inferred from what ran:
the English-only certificate names `en` and records es, fr, de and pt as
`out-of-scope` by this decision (RR-09), never as gaps and never as passes. A
five-Locale full run remains possible and declares all five. This narrows what
a certificate claims; it does not make an unmeasured Locale green, and any
shortfall inside the declared scope still yields `not-demo-ready`.

The demo call is the product's sales asset, and the owner's question about it is binary: is the demo ready to show? The repository cannot answer it. The cascade trace records operational rows only — no turns, no end reason — and the call's final `end` message is not persisted, so a failure cannot cite the turn that produced it. The managed scoreboard measures a different engine and a fake caller, and the browser rig fakes the service. A change that makes one number better can make the caller's experience worse, and no artifact says which. So "fixed" and "ready" are opinions, and the only way to form one is to press Start call and hope.

This record chooses to certify a contract instead. The demo runs only on the cascade ([ADR-0012](0012-demo-cascade-only.md)); this record says how that surface is judged. `demo:verify` plays a curated caller corpus of 43 scenarios through the real landing page, the real app, the real cascade pipeline and the real vendor legs, in all five demo Locales, and measures 82 properties in ten families from independent evidence. Each certification run writes exactly one certificate — bound to the code fingerprint, the corpus hash and the recorded vendor build ids — or a set of replayable defect cards that name the turn, the audio excerpt, the expected bar and where to look. A certificate's verdict is `certified`, `not-demo-ready`, `pending-human` or `ineligible`; only `certified` may be called a pass. The guarantee is narrow and honest: no false green inside the stated envelope, with every gap named as a residual risk. It is not a promise that no call can disappoint a visitor.

The instrument has one seam — the call boundary: caller PCM in, agent PCM out, and the call's evidence (the end message, the turn ledger, the delivered WAV, the browser marks). The quality claim is measured on delivered audio, as [ADR-0009](0009-no-beta-no-drop-delivered-audio.md) requires. Two adapters sit on it. The browser adapter is the only one that certifies, because it is the only one that sees what the visitor sees: the real page, a synthetic microphone at `getUserMedia`, the real client, pipeline and vendors, and the delivered audio. The protocol adapter reuses the existing live-call socket for fast diagnosis and can never certify. One scenario runtime runs both, so a scenario cannot mean two different things.

## The decisions this record fixes

- **The human panel is the authority.** The owner rates a blind sample of every certification in a local-only Studio; those ratings become gold labels that calibrate the machine judge and set the human reference. The panel's signature completes a certificate — until then the verdict is `pending-human` and the command exits 3. Ratings never silently retune the agent: a fix is an explicit change, re-measured by the contract, never a quiet prompt edit behind a green.
- **The judge is independent of the agent's vendor.** Two transcript-grounded judges score independently; a disagreement above one point escalates to a third judge, then to the panel. The judge model is never the vendor of the agent it judges. A judge may gate only at weighted κ ≥ 0.65 against panel gold labels; below that its verdict is `unverified`, and unverified is a failure.
- **Anything unmeasured fails.** An unmeasured property is a failure, never a pass, and there is no cosmetic class. A missing key, corpus, vendor build id or panel signature is a named refusal (exit 2), never a skip that reads green. Any fallback-contaminated or budget-stopped call makes the certificate ineligible, because the stack that produced the number is not the stack being judged.
- **Cutover is gated on a staging certificate.** A clean staging certificate for the same image gates the production routing flip. A certificate is true only for its own target; a green never inherits. Production then runs a short post-flip confirmation, and a monthly full production certification keeps the deployed claim from rotting. Rollback is the routing kill switch, not a deploy.
- **Three clean runs, not one lucky night.** A single clean certification reports nightly health; three consecutive clean certifications on the same code fingerprint support a release or cutover claim.

## Considered Options

- **Fix the demo first and trust the result.** Rejected. The reported symptoms — silence after the ringback, a chime seven seconds late, a greeting read like a paragraph, a call that ends by itself — are invisible to every instrument the repository has, so "it feels better" would be the only evidence, and the next change could undo it without anyone noticing.
- **Use the managed scoreboard's number as the readiness answer.** Rejected. It judges a different engine and a fake playout clock, and its thresholds do not carry over; a green there would describe a product the demo does not run.
- **Certify from the protocol adapter.** Rejected. It is faster and it is where a server bug is cheapest to find, but the connect sequence, the ringback, the chime and the delivered audio live in the browser. A protocol certificate would be a claim about a path the visitor never takes.
- **Let a machine judge decide alone.** Rejected. The judge has no reference until a human supplies one, and a judge grading a rubric it invented can agree with itself. The panel rates first; kappa is the permission the judge earns, not a formality.
- **Retry until green, and quarantine what stays red.** Rejected as a pass route. Retrying hides flakes and learns to tolerate real defects; this record makes a retry only confirm a failure, keeps quarantine red until explained, and lets no retry change a verdict.
- **Promise the demo is perfect once every test is green.** Rejected. The contract has 82 properties and a bounded corpus; the honest claim is "no false green inside this envelope, with these risks named", not that no visitor can be disappointed.
- **Certify English and infer the other Locales.** Rejected. The contract's bars are not language-neutral — conduct, timing and comprehension all change with the Locale — so a Locale that is not measured is not covered. The full set runs per Locale at cutover.

## Consequences

- **Unmeasured is failure, and coverage gaps are explicit rows.** Absent evidence, a Locale that did not run, a property with no evaluator and a call refused before it started all read as gaps on the certificate. None may be omitted into a pass, and a certificate with an unmeasured property is `not-demo-ready`.
- **There is no retry-to-green.** A retry only confirms a failure, a flaky check is quarantined, and quarantine is red until it is explained. A run either produces a clean certificate or does not produce one.
- **Held-out scenarios are process-sealed, not machine-sealed.** Eight scenarios are never used while fixing; a held-out failure may not justify a fix, and to fix one it must be retired and a replacement promoted from the reserve. Nothing technical stops an engineer from reading them, so the seal is discipline, and the residual-risk register says so.
- **The certificate is the claim; the account of it is not.** Certificates are committed; audio and event artifacts stay gitignored. A readiness statement that cannot cite a certificate for the same code fingerprint, corpus hash and target is an opinion, however well it is written.
- **A vendor change requires a new certificate, not a spec change.** A changed model, voice or build id invalidates the old green rather than reinterpreting it.
- **The demo can be certified and still disappoint.** The register carries the accepted gaps — TTS-only accent coverage, translated non-English understanding, vendor drift, a small human baseline and a one-rater panel, staging-to-production drift, the deploy-window refusal, and the process-sealed held-out set. They are named on every certificate; an unnamed risk is the only one that may not exist.
- **The instrument is not the fix.** This record builds the contract, the certificate and the panel; repairing the demo is the next effort, driven by the defect cards. A ticket that closes by changing the agent without a re-measured certification has not closed.
