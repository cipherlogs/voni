# One agent-body builder with profiles, one fingerprint

There were two stored-agent builders: the demo's (`stored-agents.ts`) and a tenant's (`provision.ts`). They drifted in ways nobody chose. The tenant body ships an explicit `turn_detection` object, which ADR-0003 measured at 3.6–4.7s replies and which contradicts **Turn preset** in `CONTEXT.md` ("shared by every demo call, test call, and copilot session"). The tenant PUT never sends `llm`, so a stray model override survives every self-heal forever. The two fingerprints hash different field sets, so parity between paths was never checkable.

We build every stored agent with one function and one body shape, parameterized by a profile: persona (demo or tenant) and platform (browser or phone). A profile may only choose audio format, microphone focus, tool set, whether a greeting is present, and a model override. It may not choose rules, turn-taking, speech-recognition vocabulary, or language policy.

## Considered Options

- **A shared values module imported by both builders**: rejected. Both builders stay free to add a field to only one path, which is exactly how `turn_detection` and `llm` diverged.
- **Keep both builders and test them for parity**: rejected. A parity test catches disagreement but not absence — no test would have asked why a tenant agent was the only one without the turn preset.

## Consequences

- A profile difference is now a visible, reviewable line, so the next divergence is a diff rather than a discovery.
- One fingerprint covers the whole body including the model override, so removing an override actually reverts it.
- The two refresh mechanics stay distinct (the demo refreshes on every token mint and serves stale on failure; a tenant refreshes from a queued job under the lease and version guard), but they hash the same thing.
- `CONTEXT.md`'s **Turn preset** is now the single owner of turn-taking for every agent; a body that contradicts it is a bug, not a variant.
