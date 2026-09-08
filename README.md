# Voni

An AI employee with a mission, not another chatbot. Voni runs phone and WhatsApp voice agents that qualify leads, book viewings, handle follow-ups, and hand off to humans when stuck.

## What it does

- **Voice agents** — build phone agents through a guided wizard (goal, personality, voice + language with live sample, tasks), backed by AssemblyAI voice agents with business tools (property search, availability, booking, lead update, human transfer).
- **Campaigns + dialer** — create campaigns with calling windows and consent policy, import leads from CSV, and dial through the Telnyx bridge (dry-run preview by default, explicit `--live --yes` for real calls).
- **Leads, numbers, calls** — lead records with pipeline state, phone-number to agent binding for inbound calls, call history.
- **Voice copilot** — global in-app voice assistant (header mic) that can navigate, fill the agent wizard, and operate jobs through a confirm gate.
- **Durable background jobs** — anything slow (agent generation, CSV import, deployments, connection tests) runs as a job with a global status pill, a `/jobs` page, retry/cancel, and survival across reloads.

## Stack

- App: Next.js 16 (App Router) + React 19, shadcn/ui on Base UI, Tailwind — in `voni/`
- Voice: AssemblyAI voice agents · Telephony: Telnyx via the Python bridge in `telephony-bot/`
- Data: Neon Postgres via Drizzle ORM (`voni/drizzle/`, `voni/src/lib/db/`)
- Auth: Better Auth, Google-only sign-in with organizations
- Hosting: Cloudflare Workers via OpenNext (`npm run deploy` in `voni/`)

## Layout

```
voni/            # Next.js app (source of truth for product work)
telephony-bot/   # Telnyx media-stream bridge + campaign runner (Python)
docs/            # design specs + implementation plans
HANDOFF.md       # session handoff notes (status lives here)
```

## Quickstart

```bash
cd voni
npm install
npm run dev        # http://localhost:3000
```

Environment (never committed — see `voni/ENVIRONMENT.md` for the full list):

- `voni/.dev.vars` — local Worker-style secrets (LLM keys via Settings UI, `VONI_TOOL_SECRET`, `JOB_WORKER_SECRET`, …)
- `voni/.env.local` — local-only env for dev/test scripts

Database:

```bash
npm run db:generate
npm run db:migrate
npm run db:seed     # 12 deterministic dev property listings (explicit org only)
```

Checks:

```bash
npm test            # unit suite
npm run lint
npx tsc --noEmit
```

Before writing frontend code, read `AGENTS.md` — it defines the async-work protocol, visual-feedback protocol, and the `next-dev-loop` runtime verification step.

## License

Private. All rights reserved.
