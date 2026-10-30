# Progress

Current frontier for this repo. Read this at the start of a session; keep `Now` current after finishing a meaningful chunk of work.

## Now

**Goal:** make the owned cascade the product's only real call path — a call that genuinely works in the app on this machine, then ship the same build to Northflank and delete managed once the human gates pass.

**Phase 1 — local and deploy-ready (current):**

- **App channel:** no app route mints a cascade call token or delivers the signed body to `/v1/call-body` yet. This is the missing link between the service and a browser call; build it first.
- **Real cascade calls** from the landing demo and the agent test dialog: greeting → Meta STT → Spark → AssemblyAI TTS → barge-in → tool → hang-up, with the call artifact written.
- **Voice roster:** `audrey`, `malvina`, `donatien`, `magdalena`, `benicio`, `giovanni` plus the English built-ins. Removed: `lola`, `estelle`, `juergen`, `rafael`. Clips and levels regenerated from direct TTS.
- **Local runtime:** pipeline on `:8766`, a dedicated Postgres on `:5433`, the app on `:3000`.
- **Deploy-ready repo:** topology checks the Northflank shape (one service, Postgres addon, single-read/write volume); Fly is history.
- **Managed stays** selectable as the fallback until Phase 2 retires it.

**Phase 2 — deploy and retire (blocked on Northflank being available):**

- Deploy the same build, verify `/healthz` and `/readyz`, point the app's pipeline URL at it.
- Run the human gates in `docs/agents/meta-cascade-human-gates.md`, cut over, then remove managed only after the stability window and a proved `routing=off`.

**Next action:** grilling session on the six open decisions (anonymous demo spend, subject identity, one authority, tool auth, deploy parity, cascade-default timing), then implement Phase 1.

## Not current

- `voni.cc` / `app.voni.cc` domain move: owner-side Cloudflare zone, OAuth origins, deploy. Independent of the cascade.
- Managed-path reply-gap bar: open decision, superseded by the cascade; settle at cutover or drop.

## Rules

- One or two lines per item; point at the code or doc that owns it. Tickets and specs are deleted when done — the code is the source of truth.
- No activity log — history lives in git, not here.
