# .impeccable/ — project-local impeccable wiring

> **Agents (Claude / Codex / OpenCode):** image generation in this project
> goes through the **global** `muse-image` command (on PATH —
> versioned at `~/.config/bin/muse-image`, symlinked from `~/.local/bin/`;
> Meta Muse `muse-image-1.0`, auth `$MODEL_API_KEY`). The installed
> impeccable launcher has NO
> `generate-image` / `embed-prompt` verbs (only `detect` / `ignores` /
> `help` / `install` / `link` / `update` / `check` as of 2026-09-11) —
> wherever the playbook says `impeccable generate-image --ref …`, run
> `muse-image generate` / `muse-image edit --ref …` instead.

## Why the engine lives outside this repo

Like the impeccable skill itself (`~/.agents/skills/impeccable`), the image
engine is user-global: it works from any project and `npx skills update`
replaces only the skill directory, never `~/.local/bin/`. Per-project state
(comps under `.impeccable/mocks/`, approvals in sidecars) still lives here.

## After updating the skill, re-check one thing

A future impeccable version may add its own `generate-image` verb. After
any update, run `impeccable --help` (via the skill's launcher): if
`generate-image` appears, the wrapper is redundant — prefer the native verb
going forward and either retire `muse-image` or keep it only as the
Meta-Muse engine behind the same flags. If it doesn't appear, nothing
changes.
