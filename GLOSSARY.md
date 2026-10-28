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
