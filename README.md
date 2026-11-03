# Voni

Voice-first agent platform for B2B. Deploy agents that resolve real work over calls, video, voice notes, and text — in one persistent session from trigger until resolved.

## Vision

Voni is where a company designs a workflow once and serves customers everywhere they already talk:

- **Any trigger** — phone call, video call, voice note, WhatsApp, Instagram DMs/calls, social messaging. The trigger only starts the session.
- **One session until resolved** — live + background in the same case. Hang up doesn't kill it. If a task takes 3 minutes, the customer goes on with their day; the agent follows up with a callback or voice note (voice preferred, feels personal) per what was agreed on-call.
- **Voice in any form** — live calls, video, voice notes. Text welcome too. 24/7 instant pickup, no queue. Example: accident panic video call — understand damage live, plate, type, dispatch ambulance, keep following up for days in the same session.
- **Customer-designed workflows** — non-technical ops build with a cold-email-builder-like canvas: do this, if success do X else Y, escalate, wait, hand off to human, request callback, close session. Technical builders can do anything with code.
- **Any tool** — BYO APIs, MCPs, LLMs during the call and across the whole session. Prebuilt connectors ship over time.
- **Single or group** — one voice talking + silent specialists, or handoffs between voices. Client's design choice.

Bank-freeze and accident are the same loop: `verify → act → confirm`, live if possible, background if better, always smooth.

## What exists now (current slice)

The repo currently proves a narrow slice of this: phone + WhatsApp voice agents for qualification/booking/follow-up, agent wizard, campaigns + Telnyx dialer, leads/numbers/calls, in-app voice copilot, durable background jobs. The vision above is the target; the slice is the starting point.

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
PROGRESS.md     # current progress + frontier
```

## Quickstart

```bash
cd voni
npm install
npm run dev        # http://localhost:3000
```

Environment (never committed — see `voni/ENVIRONMENT.md` for the full list):

- `voni/.env.local` — every local value: provider keys, auth secrets, `DATABASE_URL`
- `voni/.dev.vars` — Worker-runtime overrides only: `NEXTJS_ENV`, `LANDING_HOST=`

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
