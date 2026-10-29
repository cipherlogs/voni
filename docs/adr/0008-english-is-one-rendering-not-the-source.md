# English is one rendering of six, not the source of meaning

**Status: proposed.** The decision stands on its own, but it is contingent on the Spanish content re-audition: if clean audio shows the Italian and Spanish conversation is already acceptable, the per-locale rendering layer is not needed to fix quality (it may still be needed for latency and for the English-only guardrails).

The compiled prompt for `anna` and for the other five demo voices differs by exactly one line — "Speak Spanish." Everything else the model reads is English: the agent rules, every tool description, every hidden per-turn instruction, the banned-phrase list, the speech-recognition keyterms and scene prompt, the filler pool, the barge-in token lists, the digit words, the goodbye phrases. A non-English call asks the model to translate an entire English rulebook every turn, and the English guardrails silently do nothing in the other five languages.

We therefore make the rule set structured data — each rule has an identity, a severity, and a condition under which it applies — and each locale supplies its own rendering of every rule. English is one of six renderings, not the owner of meaning. A missing rendering is a visible hole that the harness must surface per locale; it is never filled by falling back to English.

## Considered Options

- **English as the source, machine-generated into the other five**: rejected. The five locales become translations of English rather than peers, which reproduces the asymmetry under a new name, and translation drift becomes invisible.
- **Hand-author each locale from scratch**: rejected. Six independent rule sets drift apart on invariants (brevity, tool narration, steering), and there is no place to state a rule once.
- **Shrink what the model must translate per turn, keeping English**: rejected as a remediation, not a model. It reduces the tax without removing the asymmetry, and it keeps every English guardrail English-only.

## Consequences

- Adding or changing a rule means changing the structured rule and its six renderings. A ticket that edits one language is incomplete by construction.
- Speech-recognition vocabulary, filler lines, barge-in tokens, digit words, and goodbye phrases live in the same per-locale bundle as the rules: the locale owns what the agent says, what it listens for, and what it matches.
- An agent on automatic language detection (`languageCodes: []`) cannot have one locale, so it keeps the documented exception: English scaffolding plus a rule to answer in the caller's language.
- The harness needs a locale axis. A gate that passes in English proves nothing about a locale that renders.

## Re-audition (W2 gate)

**Verdict: unresolved** — 2026-10-29. No real non-English call has been assembled for lola (es): the pack is pending-live-call, so the locale-rendering decision is unresolved. A missing capture makes the pack incomplete, never a pass.

- Subject: `lola` (`es`), session unrecorded.
- Pack: `voni/reaudition-runs/lola-es-pending/pack.json`.
- Captures: reference missing (no path); platform missing (no path); delivered missing (no path).
- Transcript: 0 turns (0 agent, 0 caller).
- Counters (report-only): English leaks not scored; already-answered counter not-implemented (ticket 77).
- Content judge: not run.
- Basis: reference capture missing: no path supplied; platform capture missing: no path supplied; delivered capture missing: no path supplied; transcript missing: no turns supplied; content judgement missing: the transcript has not been scored.
- Native review: not-reviewed; the machine judge caps at 4/4, so a named native reviewer still owns the five-out-of-five sign-off.
- Operator: `cd voni && npm run voice:reaudition -- --voice lola --locale es --pending --out reaudition-runs/lola-es-pending`
