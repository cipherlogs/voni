# No beta tier, no dropped locale, and quality is judged on delivered audio

Three escape hatches were available while the non-English voices sounded wrong, and each would have let the product ship the defect under a different name: label the weak locales beta, stop offering them, or declare one of them good by listening to something other than what the caller hears. The owner has removed all three as choices, so this record fixes what "good" means and what may be cited as evidence for it, before any ticket in the parity work is judged against it.

The doctrine is three rules.

- **No locale is dropped, hidden, or labelled beta.** Every offered locale is either good or open work. A locale nobody can yet staff with a native reviewer stops at recognition work and stays open; it is not called done, not marked beta, and not removed. Weakness is a problem to solve, not a market to abandon.
- **No existing budget is edited to pass.** A new threshold is a new record with a stated source. Only word repertoires and the words-per-second timing used for goodbye coverage may vary per locale: milliseconds are the platform's, words are the language's.
- **A quality claim cites Delivered audio** — what reaches the caller's speaker after every stage we own. The platform's own session recording is not delivered audio; neither is a preview asset, a reference rendering, or a reconstruction of the agent body.

Good means a five-out-of-five rating from native raters on one shared recording per subject, iterated on their stated reasons until it holds. A rating below five blocks acceptance, its reason is recorded with the rating, and a reason that repeats across iterations is evidence that the fix is aimed at the wrong layer rather than a reason to re-roll the same change.

## Considered Options

- **Label the weak locales beta until they are good** — rejected. A beta label tells the visitor the worse product is expected, so it converts a defect into a policy and removes the pressure to fix it. It also makes "green" ambiguous: a passing matrix that includes a beta locale is not a passing matrix.
- **Offer fewer locales, keep the good ones** — rejected. The locales that sound worst are the ones whose speakers most need the product to work in their own language, and dropping one hides the defect from the team that owns it.
- **Accept a measured proxy instead of delivered audio** — rejected. Every claim made from a proxy failed here: the loudness leg compared a formula to the constant it came from and could not fail, the level table described clips that had been replaced with pre-gained copies, and the platform recording never contains our playback. A proxy that agrees with us is worse than no measurement, because it reads as evidence.
- **Trust the owner's ear alone, with no raters** — rejected. One listener cannot be the bar for six languages, and a single verdict cannot separate timbre from language naturalness. Raters bring stated reasons, which is what makes an iteration attributable.

## Consequences

- **Delivered audio becomes a product deliverable.** The parity work must capture what the browser played — a tap after the playout worklet — and a gate that cannot show a delivered file is not a quality gate. Audio evidence stays a gitignored working file; the event stream stays timing-only.
- **The harness needs a subject axis and a ballot.** A subject is an agent, a locale, and a transport, and each subject derives its gates from its own run. A matrix that carries the featured voice's verdict across the others is a false green under this doctrine. English passing proves nothing about a locale that renders.
- **The bar is per locale, not for the product as a whole.** "Most locales are good" is not a state this record allows to be reported as done. The reported state is which locales hold five out of five with a named reviewer and date, and the rest are open.
- **The doctrine is not a budget exception.** It adds thresholds and subjects; it never relaxes one. The budget freeze guard and shared artifact validation are untouched, and a changed threshold still fails.
- **Language detection stays the one documented exception.** An agent on automatic detection has no single locale, so it keeps English scaffolding plus the instruction to answer in the caller's language. That is a documented exception to **Locale**, not a beta tier and not a dropped locale, and the twelve locales it reaches are out of scope for rendered content.
- **ADR-0008 stays proposed.** English as one rendering among six is contingent on the clean-audio content re-audition; this record does not accept it. What this record does settle is that no verdict on that question may cite anything but delivered audio, and that a locale cannot be removed or marked beta while the question is open.
- **Terms.** **Voice binding**, **Locale**, **Session mechanics**, **Agent rules**, **Demo scenario**, and **Delivered audio** now live in `CONTEXT.md`; user-facing copy and ticket language must use them as defined there, and no locale may be described as beta or hidden anywhere.
