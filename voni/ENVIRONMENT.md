# Environment variables

Copy each value into `voni/.dev.vars` for local dev (Cloudflare/OpenNext reads
`.dev.vars`, not `.env`). Never commit real values — `.dev.vars` and `.env*`
are gitignored, and this project's permission settings block writing actual
`.env*` files from an agent session as a safety measure — set these by hand.

## Database (Neon Postgres)
- `DATABASE_URL` — Neon dashboard → project → Connection Details → "Pooled connection" URI.

## Auth (Better Auth + Google OAuth)
- `BETTER_AUTH_SECRET` — generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
- `BETTER_AUTH_URL` — `http://localhost:3000` for local dev.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application). Authorized redirect URI: `{BETTER_AUTH_URL}/api/auth/callback/google`.

## Operator access and credential encryption

- `VONI_ADMIN_EMAILS` — comma-separated Google account emails allowed to see
  and change the operator-only `/operator` area. Matching is exact and
  case-insensitive.
- `VONI_CREDENTIALS_ENCRYPTION_KEY` — exactly 32 random bytes, encoded as
  base64/base64url or 64 hex characters. Generate a base64 value with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- `VONI_CREDENTIALS_KEY_VERSION` — optional positive integer stored with each
  encrypted override. Defaults to `1`; increment it when rolling to a new root
  key and re-save every database override.

These values, database/auth credentials, `VONI_API_URL`, `VONI_TOOL_SECRET`,
and `PUBLIC_HOST` are bootstrap infrastructure and remain environment-only.
An allowlisted operator can inspect credential status and non-secret defaults at
`/operator`. Rotate encrypted credentials through the server-only
`npm run operator:credential` command. Encrypted database values take
precedence over the environment fallbacks below.

## AssemblyAI (Voice Agent API + LLM Gateway)
- `ASSEMBLYAI_API_KEY` — assemblyai.com dashboard → API Keys. $50 free-tier credit covers early dev.

Saved Voni agents are created or updated in AssemblyAI after the local row is
written. If this key is missing or AssemblyAI is unavailable, the app keeps the
local save and shows a retryable deployment warning on the agent page.

## Telnyx (telephony bridge)

- `TELNYX_API_KEY` — environment fallback for the operator-managed Telnyx
  credential. The Call Control connection and caller number are selected in
  `/operator`.

## Voice judge (Jev fast judgments for test calls + PSTN bridge)

- `AI_GATEWAY_API_KEY` — Vercel dashboard → AI Gateway → API Keys. Powers live
  Jev probabilities in `/api/voice-judge`; without it the route serves the
  offline heuristic (`source: "heuristic"`), so calls work either way. Set by
  hand in `.dev.vars` (and prod Worker secrets) — never committed.
- `VOICE_JUDGE_MODEL` (optional) — defaults to `typesafe-ai/jev`.
- `VOICE_JUDGE_GATEWAY_URL` (optional) — defaults to the AI Gateway evaluate
  endpoint (`https://ai-gateway.vercel.sh/v1/evaluate`).
- The bridge needs no new config: it derives the judge URL from its existing
  `VONI_API_URL` (`{VONI_API_URL}/api/voice-judge` — local dev URL on a dev
  machine, Worker URL in prod) and authenticates with the existing
  `VONI_TOOL_SECRET` bearer. Sampling is fire-and-forget and off by default
  until the URL resolves.

## Cascade test-call client (dev slice)

`NEXT_PUBLIC_*` because the browser reads them (set in `.env.local` for
`next dev`; never secrets — the browser must never hold vendor keys):

- `NEXT_PUBLIC_VOICE_PIPELINE_URL` — pipeline service WS URL. Default
  `ws://127.0.0.1:8766/v1/browser-call` (see `voice-pipeline/README.md`).
- `NEXT_PUBLIC_CASCADE_LLM_MODEL` — gateway model id (default
  `alibaba/qwen3.5-flash`, verified live).
- `NEXT_PUBLIC_CASCADE_TTS_MODEL` — Cartesia model (default `sonic-2`).
- `NEXT_PUBLIC_CASCADE_TTS_VOICE` — Cartesia voice ID from the dashboard
  (no default — the service errors clearly without it). Distinct from the
  AssemblyAI `voiceId` on the agent; voice identity does not carry across.

The Test dialog's Managed/Cascade toggle switches engines per call;
managed stays the default and demo calls always use managed.

## Async TTS (WhatsApp voice-note replies — AssemblyAI has no standalone TTS API, plan Section I)
- `CARTESIA_API_KEY` — cartesia.ai → sign up → dashboard → API Keys. Free plan
  (20K credits/mo, ~27 min TTS) is fine for dev/testing but explicitly
  excludes commercial use per Cartesia's own pricing page — upgrade to Pro
  ($5/mo, 100K credits, commercial-use license included) before sending
  voice notes to real leads.
- Known limitation, not yet resolved (see conversation): the phone-call voice
  (AssemblyAI's managed Voice Agent API, closed voice catalog) and the
  Cartesia WhatsApp voice-note voice will NOT be the same voice — no way to
  reuse AssemblyAI's call voice in a third-party TTS. For now, pick a
  Cartesia voice that's a stylistic match (gender/accent/tone) to whichever
  AssemblyAI call voice is chosen. Revisit after MVP if true voice-identity
  matching across channels becomes a priority (would require moving off the
  managed Voice Agent API to a cascading LiveKit/Pipecat stack using Cartesia
  for both channels).

## LLM providers (agent compiler + post-call extraction)

Plan Days 3-4 and 9-10 both need an LLM. Voni tries the premium Meta Model API
first when `META_API_KEY` is set. Meta uses the Responses API with the fixed
`muse-spark-1.3-contributor` model. Its endpoint, model, reasoning settings, and
limits are hardcoded. It does not appear in Settings and cannot be reordered.

If Meta is not configured, times out, returns an error, or produces invalid
JSON, `generateJSON` continues through the free-provider chain. The fallback
chain skips providers with no usable account and falls through on rate limits,
errors, and malformed JSON.

`META_API_KEY` is the one environment-backed LLM credential. Put it in
`.dev.vars` for local development and configure it as a Worker secret in
production. Do not commit its value.

Free-provider keys are not environment variables. Each free provider supports
several operator-owned accounts, such as five separate Groq accounts, so a
rate-limited or failing account cools down and the next one takes over. Add
accounts through the server-side operator workflow. `/operator` shows account
health and sanitized connection-test results; keys never enter browser props.

| Provider | Sign up |
| --- | --- |
| Groq | console.groq.com — fastest inference; generous free tier |
| Cerebras | cloud.cerebras.ai — fast; smaller free quota |
| Google Gemini | aistudio.google.com — largest free tier; best at strict JSON |
| OpenRouter | openrouter.ai — aggregator backstop, widest free model pool |

Optional model/order overrides (`GROQ_MODEL`, `CEREBRAS_MODEL`, `GEMINI_MODEL`,
`OPENROUTER_MODEL`, and the fallback order) live in `/operator`, under
"Provider and bridge defaults". `GROQ_MODEL` and the other environment values
still act as defaults when no database override is saved.

**With no Meta key or free-provider accounts configured the app still works.**
`/agents/new` offers the pre-built real estate template instead of generation,
which is the Section T fallback.

The four free providers expose an OpenAI-compatible `/chat/completions`, which
is also the shape AssemblyAI's Voice Agent `llm` field accepts. This same chain
is the candidate for attacking the 1.26s in-call think time measured in HANDOFF
(1x).

## Telephony bridge (telephony-bot/server.py)

The bridge now persists calls, so it needs database access of its own:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Same Neon database the app reads. Without it the bridge runs exactly as before, logging a warning and persisting nothing. |
| `VONI_API_URL` | Public or bridge-reachable Voni origin, with no trailing slash. The bridge posts client-side AssemblyAI tool calls to this server. |
| `VONI_TOOL_SECRET` | Long random shared secret used only for bridge-to-Voni tool requests. Set the same value in Voni and the bridge. |
| `PUBLIC_HOST` | Current public media tunnel hostname, without a scheme. |

Before each new call, the bridge fetches a short-lived internal configuration
containing the resolved AssemblyAI and Telnyx credentials plus the temporary
workspace, deployed agent, Call Control connection, and caller number selected
in `/operator`. Human transfer always uses the destination saved on
that call's workspace; there is no global transfer-number fallback.

## Development property inventory

After applying migrations, seed the 12 labelled Abu Dhabi and Dubai sample
listings into one explicit organization:

```bash
VONI_ORG_ID=<organization-id> npm run db:seed
```

The command refuses to run without `VONI_ORG_ID`. It upserts deterministic
references, so running it twice updates the same 12 rows and creates no
duplicates. It never seeds every organization or chooses one automatically.

## Where env vars actually live (read this first)

Two files, and they do **not** overlap:

| File | Written by | Loaded into | Holds |
| --- | --- | --- | --- |
| `.env.local` | the Neon CLI | `process.env`, by Next | `DATABASE_URL` only |
| `.dev.vars` | us | the Cloudflare context | everything else |

`.dev.vars` is Cloudflare's convention, and `initOpenNextCloudflareForDev()`
exposes it through the Cloudflare context — **not** through `process.env`. So a
plain `process.env.ASSEMBLYAI_API_KEY` read `undefined` under `next dev` and
every feature that needed it reported itself "not configured", while the
database kept working and made the environment look healthy. Google sign-in was
broken this way too.

`next.config.ts` now mirrors `.dev.vars` into `process.env` in development
(existing values always win, so CI and the deployed Worker are untouched). It
has to happen there because `src/lib/auth.ts` reads its secrets at module scope.
`src/lib/env.ts` provides `secret()` as a request-time fallback that also reads
the Cloudflare context directly.

**Put new secrets in `.dev.vars`.** Nothing needs to be duplicated.

## Public demo limits

The landing-page live demo is unauthenticated, so it is bounded on four sides
(see `src/app/api/demo/token/route.ts`). Two of them are tunable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEMO_MAX_PER_IP_PER_HOUR` | `3` | Stops one person hammering it. |
| `DEMO_MAX_PER_DAY` | `60` | Global daily ceiling — the one that actually bounds the bill against a crowd. |

Setting **either to `0` turns the public demo off entirely**, which is the
kill switch if the credit starts draining.

Cost math: demo sessions are capped at 120s by AssemblyAI itself, so at
$0.075/min one demo costs at most $0.15 and the default daily ceiling is about
$9/day worst case.

## Cloudflare (deploy target + R2 storage)
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` — only needed for `npm run deploy` / R2 access, not local dev.

## Background jobs (Cloudflare Queues + R2 staging + cron)

Slow work (agent generation, agent deployment, connection tests, CSV
imports) runs as durable jobs: Postgres (`background_jobs`) is the source of
truth, queue messages carry only `{ jobId, kind }`, and a custom worker
(`voni/worker.ts`, wired as `main` in `wrangler.jsonc`) adds the queue and
scheduled handlers to the generated fetch handler.

Local dev needs nothing: with no queue binding, `enqueueJobMessage` runs the
same processor in-process, and CSV bytes ride inline in the job input (still
capped at 2 MB). Production needs the infrastructure below, created **before**
switching traffic (migrations first, then queues, then app code):

```bash
# One-time production setup (needs CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN)
npx wrangler queues create voni-background-jobs
npx wrangler queues create voni-background-jobs-dlq
npx wrangler r2 bucket create voni-csv-staging
```

`JOB_WORKER_SECRET` is the one new secret this system needs: any long random
string, shared between the worker and the server (same environment, so one
value). Put it in `.dev.vars` locally and configure it as a Worker secret in
production. The queue/scheduled handlers prove it on every internal call
(`x-voni-worker-secret`); without it the internal consume/sweep routes 403.

The custom worker re-dispatches through internal routes
(`POST /api/internal/jobs/consume`, `POST /api/internal/jobs/sweep`) instead
of importing job code into a second bundle — the OpenNext server already
resolves @/ aliases, next/cache, and the AI SDK with its workerd patches,
while a hand-bundled copy fails to resolve them (seen with
`@opentelemetry/api` via the Next server trace).

`wrangler.jsonc` already binds them:

| Binding | Resource | Used by |
| --- | --- | --- |
| `JOB_QUEUE` (producer + consumer) | queue `voni-background-jobs` | `src/lib/jobs/queue.ts`, `worker.ts` |
| dead-letter queue | `voni-background-jobs-dlq` | 3 infra retries, 60s backoff, batch size 1, max 5 concurrent |
| `CSV_STAGING` | R2 bucket `voni-csv-staging` | private CSV staging in `src/lib/jobs/queue.ts` |
| `triggers.crons` | `*/5 * * * *` | republish missed messages, recover abandoned leases, delete terminal jobs after 30 days |

Generated binding types: `npx wrangler types` refreshes the `CloudflareEnv`
declarations after any binding change; `secret()` in `src/lib/env.ts` keeps
reading `.dev.vars` first so local secrets behave the same.

```bash
npm run preview  # opennext build + local preview (queue/R2 emulated locally)
npm run deploy   # opennext build + deploy the custom worker
npx wrangler queues consumer ... # not needed; consumers are config-declared
npm run test:jobs:integration  # queue-consumer smoke test + store transitions
```

## WhatsApp Business (Meta Cloud API, via Twilio)
- `WHATSAPP_BUSINESS_ACCOUNT_ID` — verification/template approval takes real calendar time (up to ~48h). Start this in parallel with everything else, not after the build is done.
