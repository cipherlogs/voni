# 07: One sanitizer for both event streams

**What to build:** The forbidden-key and key-shaped-value rules that protect the eval stream are extracted into one module used by both the managed stream and the cascade stream. One denylist, one redaction routine, one place to add a rule.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Both streams call the same module; a second denylist or a local copy fails review.
- [ ] A line carrying text, transcript, audio, pcm, authorization, token, api_key or secret is rejected by name.
- [ ] A key-shaped value inside an allowed field (a URL with a credential, a bearer string) is redacted rather than dropped.
- [ ] Existing managed event lines are byte-compatible with the current output.

## Answer

One sanitizer: `voni/src/lib/demo/event-sanitizer.ts` owns `FORBIDDEN_EVENT_KEYS` (one denylist), `redactKeyShaped` (key-shaped, bearer, URL userinfo) and `sanitizeEventFields` → `{ok, value, rejectedKeys}` with dotted paths; no imports, so the cascade stream can import it without the managed types.
Managed stream: `eval-events.ts` drops its private set/regex/`sanitizeValue`, calls `sanitizeEventFields`, keeps emit order `{atMs,type,...}` and adds `onRejected({type,keys})` so a forbidden key is reported by name while the line is still written sanitized (byte-compat, not a throw).
Byte-compat is pinned by a raw-JSON line test plus the unchanged eval-events tests; `npm test` → 2065 tests, 2064 pass, 0 fail, 1 skipped; `npm run typecheck` clean; eslint clean on the three files.
Duplicate redactors left for follow-up: `scoreboard.ts:4169 redactTranscript` (PII vocabulary `[email]/[phone]/[credential]`, scoreboard.ts is out of scope), `scripts/qa-voice-session.mts:77 sanitizeTranscript` (local copy of it), `src/lib/jobs/store.ts:564` and `src/lib/llm/index.ts:111` (job/LLM error domain); `src/lib/agents/body.ts:117` is an unrelated body whitelist.
Branch `ticket/07-one-sanitizer`, commit `8ec6833f`, base `20751132`; `git merge feat/meta-cascade` → "Already up to date"; no scoreboard/budgets edits.

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
