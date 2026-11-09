# Voni

Voni runs voice agents that answer and place calls for a business. You design
the workflow once, and the agent handles the conversation, books slots, updates
records, and sends follow-ups. Every call ends with the work already done.

This directory holds the Next.js application: dashboard, API routes, tool
dispatch, and the job system. It runs against two sibling services in this
monorepo, `telephony-bot/` (a Python bridge to Telnyx media streams) and
`voice-pipeline/` (the streaming voice service).

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16.3 with React 19, App Router |
| UI | shadcn on Base UI, Tailwind CSS 4, lucide icons |
| Data | PostgreSQL via Neon serverless driver and Drizzle ORM |
| Auth | Better Auth with Google OAuth |
| Voice | AssemblyAI for speech to text, Cartesia for text to speech, Telnyx for telephony |
| Models | OpenAI-compatible provider through the AI SDK |
| Background work | Durable jobs in Postgres, delivered with Cloudflare Queues |
| Hosting | Cloudflare Workers through OpenNext |
| Tests | `node:test` for unit tests, Playwright for end to end |

## Getting started

You need Node 20.9 or newer, a Postgres database (Neon works), and Google OAuth
credentials.

```bash
npm install
# create .env.local and fill in the variables listed below
npm run db:migrate
npm run dev
```

The app is at http://localhost:3000. `npm run dev:all` also starts the cascade
service on port 8766 and the Telnyx bridge on port 8765, which you need for
live phone calls.

## Environment variables

All values belong in `.env.local`. `ENVIRONMENT.md` documents each one,
including which are optional.

Database:

- `DATABASE_URL`

Authentication and access:

- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `LANDING_HOST`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `VONI_ADMIN_EMAILS`, which also acts as the signup allowlist
- `VONI_CREDENTIALS_ENCRYPTION_KEY`, `VONI_CREDENTIALS_KEY_VERSION`

Voice and telephony:

- `ASSEMBLYAI_API_KEY`, `CARTESIA_API_KEY`, `TELNYX_API_KEY`
- `META_API_KEY` for the language model, `AI_GATEWAY_API_KEY` for the call judge

Jobs and Cloudflare:

- `JOB_WORKER_SECRET`
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`

Demo limits and integrations:

- `DEMO_MAX_PER_IP_PER_HOUR`, `DEMO_MAX_PER_DAY`, `DEMO_INBOX_REFRESH_TOKEN`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`

Google refuses automated browsers, so you can set `DEV_BYPASS_AUTH=true` on a
non-production environment to skip OAuth during development.

## Database

The schema lives in `src/lib/db/schema.ts` and migrations in `drizzle/`.

```bash
npm run db:generate   # author a migration after changing the schema
npm run db:migrate    # apply migrations
npm run db:studio     # browse the data
```

`npm run db:seed` fills a development database with sample property listings.
It requires `VONI_ORG_ID` and refuses to run without it, since it never picks an
organization for you.

## Authentication

Better Auth handles sign in with Google. Add `{BETTER_AUTH_URL}/api/auth/callback/google`
as an authorized redirect URI in the Google console. Locally that is
`http://localhost:3000/api/auth/callback/google`.

## Project layout

- `src/app/` holds the public pages (`login`, `signup`, `privacy`, `terms`) and
  the authenticated dashboard group: agents, calls, campaigns, leads, jobs,
  numbers, operator, and settings.
- `src/app/api/` holds route handlers for auth, jobs, tools, the copilot, the
  demo, voice preview, and the voice judge.
- `src/lib/` holds the domain code. `voice/` covers the session, playout, and
  barge-in handling, `jobs/` the durable queue, `tools/` the agent tool
  dispatch, and the rest is grouped by feature.
- `src/components/` holds the UI, including the shadcn primitives in `ui/`.
- `worker.ts` is the Cloudflare entry point and `open-next.config.ts` configures
  the deployment.

Long running work survives navigation, reload, and a closed tab. Anything that
may take more than a few seconds becomes a row in `background_jobs` and reports
progress through the job center in the header.

## Checks

```bash
npm run typecheck   # next typegen, then tsc --noEmit
npm test            # discovers every *.test.ts and *.test.tsx under src/ and scripts/
npm run lint
npm run test:e2e    # Playwright against a production build
```

Add a test file and the runner picks it up. There is no path list to update.
Integration suites that need a live database or vendor keys run separately, for
example `npm run test:jobs:integration` and `npm run test:dispatch:integration`.

## Deployment

Voni deploys to Cloudflare Workers with OpenNext.

```bash
npm run preview   # build and preview locally in workerd
npm run deploy    # build and publish
```

`wrangler.jsonc` declares the routes, the `voni-background-jobs` queue and its
dead letter queue, the R2 buckets, and a one minute cron that sweeps stuck
jobs.

## Further reading

- `../README.md` for the monorepo overview and the other services
- `ENVIRONMENT.md` for every variable and its default
- `DESIGN.md` for the visual language
- `../CODING_STANDARDS.md` before opening a pull request
- `../docs/adr/` for architecture decisions
