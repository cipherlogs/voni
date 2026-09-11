# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Operators and small-to-mid teams who sell to or serve customers over the phone and messaging, in any field — the platform is deliberately vertical-flexible, not bound to one industry. The current proof vertical is property (qualifying inquiries, booking viewings, handling follow-ups). Human agents who receive handoffs when the AI gets stuck are a secondary audience.

## Product Purpose

Voni is an AI employee with a mission, not another chatbot. It runs phone and WhatsApp voice agents that qualify leads, run outbound campaigns, handle follow-ups, and hand off to humans when stuck. Success means leads converted into real customers and deals closed — voice agents, calls, and campaigns are the essence, conversion is the outcome.

## Positioning

A neighboring voice API, dialer, or chatbot could not truthfully copy this combination: a guided wizard builds agents equipped with real business tools (search, availability, booking, lead update, human transfer); every slow step runs as a durable, consent-aware background job (dry-run dialer by default, review-before-save); and an in-app voice copilot operates the product itself — navigating, filling the wizard, driving jobs — through a confirm gate. One loop, any field: agents → calls → campaigns → customers.

## Operating Context

Inbound qualification plus outbound campaigns with calling windows and consent policy. Leads managed as pipeline records, imported from CSV. Telephony via the Telnyx bridge (dry-run preview by default; real calls require an explicit live action). Phone-number-to-agent binding for inbound calls, call history retained. Multi-user organizations with Google-only sign-in. Slow work (generation, imports, deployments, connection tests) runs as creator-scoped durable jobs with global status, retry/cancel, and survival across reloads. Hosted on Cloudflare Workers via OpenNext.

## Capabilities and Constraints

Confirmed functionality: agent wizard (goal, personality, voice + language with live sample, tasks); AssemblyAI-backed voice agents; campaigns with calling windows, consent policy, CSV import; leads, numbers, call history; voice copilot with confirm gate; durable job system with global status pill and `/jobs` page.

Durable constraints: AssemblyAI voice + Telnyx telephony; Neon Postgres via Drizzle ORM; Better Auth with Google-only sign-in and organizations; Cloudflare Workers hosting target; shadcn/ui on Base UI only (`render=` composition, never `asChild`); every user-triggered async action gives immediate feedback and anything non-interactive that may exceed 3 seconds is durable background work.

Explicitly undecided: which vertical to prove next after property; pricing and packaging.

## Brand Commitments

Name: Voni. Voice: "An AI employee with a mission, not another chatbot." No further identity, asset, or personality constraints confirmed.

## Evidence on Hand

Real and citable: `voni/` (Next.js 16 App Router source of truth), `telephony-bot/` (Telnyx bridge + campaign runner), `docs/` (specs + plans), root `README.md` product claims, `HANDOFF.md` session state. Absences future work must not fabricate: no testimonials, named customers, benchmarks, pricing, or licensing claims exist.

## Product Principles

1. Conversion is the essence — agents, calls, and campaigns exist to turn leads into real customers.
2. Vertical-flexible by design — prove in property, apply to any field without rebuilding the loop.
3. Slow work is durable — anything that can exceed a few seconds survives navigation, reload, and closure.
4. Safety before scale — consent windows, dry-run defaults, review gates, and human handoff are non-negotiable.
5. Voice operates the product — the copilot does real work, with confirmation before anything mutates.
