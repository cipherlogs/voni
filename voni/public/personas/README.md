# Persona portraits — PLACEHOLDERS, swap before shipping

AI-generated / stock placeholder faces from `xsgames.co/randomusers`, used to
build and judge the demo UI. They are **not** licensed for a public launch.

Replace each file with a properly licensed or commissioned portrait before the
landing page goes live. Keep the filenames — `Persona.portrait` in
`src/lib/agents/personas.ts` points at them by name, and the picker falls back
to a monogram if a file is missing, so removing one is safe.
