# Glossary

Domain terms live in `CONTEXT.md`. This file records project-wide working
definitions on first write (per the voni-perf-sanitize spec).

- **Sanitize**: a behavior-preserving performance refactor — same pixels,
  same data, lower cost (fewer sequential roundtrips, smaller payloads /
  bundles, fewer renders). No visual, API, or schema change.

- **Managed LLM**: AssemblyAI default conversational model for voice agents.
  Undisclosed vendor/model. Used when stored agent has no `llm` field.
- **Custom LLM / bring-your-own**: stored agent with `llm: [{base_url, model, api_key}]`
  (REST create/update only, one entry, must stream). Not currently set in code.
- **Reasoning effort (`metaEffort`)**: `low|medium|high` for Meta
  `muse-spark-1.3-contributor` in `voni/src/lib/llm`. Default `high` (= max for Meta).
  Voice path has no effort knob; free-tier chain has no effort, only `temperature: 0.2`.

- **Take the floor / yield / wait** (cascade): the three outcomes of floor
  arbitration while the agent holds the floor. The caller takes the floor
  (real interruption or command overlap → cut and pivot), yields it back (the
  agent keeps speaking), or the pipeline waits. Never phrased as committing a
  turn.
- **Commit is not cascade vocabulary**: the cascade does not commit a turn —
  the speech provider owns the Turn boundary (see `CONTEXT.md` **Cascade
  pipeline**). "Commit" survives only as the managed-path concept and the git
  verb; a cascade code path, ledger mark, event or test helper named `commit`
  is a naming bug even when the behaviour is right, and
  `voice-pipeline/test_naming.py` fails if it returns.
  _Avoid_: commit gate, early commit (on the cascade)
