# Leadcalls agent instructions

- Keep this file as a routing index; place detailed or conditional Leadcalls guidance in `docs/agents/` and update the pointer.
- Before writing AssemblyAI code, read `docs/agents/assemblyai.md`.
- Before implementing asynchronous work, read `docs/agents/async-work.md`.
- Before writing or reviewing Voni frontend code, read `docs/agents/nextjs.md`.
- For cross-agent continuity, read `docs/agents/progress.md`.
- For voice-copilot work, read `docs/agents/voice.md`.
- For demo scoreboard, eval, gate, matrix, or live-call work, read `docs/agents/demo-scoreboard.md`.
- For the remaining Meta cascade human gates (feasibility, German, audition, readiness, rollback, signatures, decommission), read `docs/agents/meta-cascade-human-gates.md`.
- For the turn-window latency experiment, read `docs/demo-latency-ladder.md`.
- For multi-worktree implementation, run `scripts/worktree-create.sh <name>` (disk-backed root; `WORKTREE_ROOT` overrides). Use `scripts/worktree-setup.sh` only to repair an existing worktree.
- For ticket-graph work, use `python scripts/tickets.py frontier|validate|close --effort <name>`; do not re-parse `Blocked by` by hand.
- Before declaring a feature done, run `bash scripts/review-gate.sh`; `--update` only after a real review of that SHA.
- For code review, read `CODING_STANDARDS.md`.
- For issue-tracker work, read `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.
- For domain modeling or architecture work, read `docs/agents/domain.md`.
