# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

B2B operators and teams in any field where customers resolve things by talking — insurance, banking, services, commerce — not by chatting with software. Builders are non-technical ops first (drag-and-drop workflow canvas), technical builders second (can accomplish anything with code/APIs/MCPs). End-customers reach agents by phone, video, voice note, WhatsApp, or social DMs/calls. Human agents who receive handoffs/escalations are a secondary audience.

## Product Purpose

Voni is a voice-first agent platform, not another chatbot or dialer. A company designs a smart workflow once; Voni runs it as agents that stay with the end-customer from trigger until the matter is resolved — live when it matters, background when it's smoother, proactive follow-up by callback or voice note per what was agreed.

Success means the work is already done when the session ends: a frozen account after a hack report, an ambulance dispatched after a panic video call with damage/plate captured, a claim advanced days later in the same case. Voice calls, video, and voice notes are the essence; text is welcome too.

## Positioning

A neighboring voice API, dialer, or always-on text agent (Grok Bot, Dots, Muse) could not truthfully copy this combination: trigger-agnostic entry (call/video/voice-note/text starts the same session), session persistence beyond hang-up with agreed proactive outreach, human-natural voice that never goes silent (filler + callback offer when tools take time), a non-technical builder with if-success/else branches plus full BYO tools (APIs, MCPs, LLMs throughout the session), and single-or-group agent topologies as a client design choice. One session, any channel: trigger → workflow → tools → follow-up → resolved.

## Operating Context

Any B2B workflow where the trigger can be a phone call, video call, voice note, or text on phone/WhatsApp/social (calling apps included), 24/7 instant pickup with no queue. Sessions span live + background until resolved; hang-up never kills the task. Example flows: panic video — understand accident type, damaged parts, plate, dispatch help; hack report — verify, freeze, confirm now or callback. Builders connect their own tools; Voni ships prebuilt connectors over time. Multi-user organizations with Google-only sign-in (current). Telephony via Telnyx bridge (current); AssemblyAI voice (current) evolving toward Meta Model API / open weights for orchestration and understanding.

## Capabilities and Constraints

Vision capabilities (target, not all built): trigger-agnostic sessions; live call/video/voice-note handling with natural turn-taking and callback offers; visual workflow builder (message/call, tool call, condition, wait, human handoff, callback request, close); BYO APIs/MCPs + prebuilt connectors; single/group agent design; proactive outbound call/message on consent; audit trail and approval gates for irreversible actions.

Confirmed today: agent wizard (goal, personality, voice + language with live sample, tasks); AssemblyAI-backed voice agents; campaigns with calling windows, consent policy, CSV import; leads, numbers, call history; voice copilot with confirm gate; durable job system with global status pill and `/jobs` page.

Durable constraints: Neon Postgres via Drizzle ORM; Better Auth with Google-only sign-in and organizations; Cloudflare Workers hosting target; shadcn/ui on Base UI only (`render=` composition, never `asChild`); every user-triggered async action gives immediate feedback and anything non-interactive that may exceed 3 seconds is durable background work.

Explicitly undecided: session/case data model and resolution rules; callback consent + outbound compliance model; video-understanding depth for day 1; minimal builder node set; pricing and packaging.

## Brand Commitments

Name: Voni. Voice: "An AI employee with a mission, not another chatbot." Slogan (canonical): "Every call ends with the work already done." Alternates: "One call, and everything after it.", "The work happens while it's still talking." Static brand masters in `voni/public/press/` freeze the mark's resting V; no further identity or personality constraints confirmed.

## Evidence on Hand

Real and citable: `voni/` (Next.js 16 App Router source of truth), `telephony-bot/` (Telnyx bridge + campaign runner), `docs/` (specs + plans), root `README.md` vision + current slice, `PROGRESS.md` session state, `.scratch/always-on/` (Grok Bot vs Dots vs Muse teardown, 2026-11-02). Absences future work must not fabricate: no testimonials, named customers, benchmarks, pricing, or licensing claims exist; vision capabilities above are target, not shipped.

## Product Principles

1. Session until resolved — the trigger starts it, the outcome ends it; hang-up never kills the work.
2. Trigger-agnostic — call, video, voice note, or text start the same workflow; follow up by voice (preferred) or chat per agreement.
3. Smooth over synchronous — never hold someone on-call for 3 minutes; filler, callback, and proactive updates are first-class.
4. Builder for ops, power for devs — non-technical can ship; technical can do anything with APIs/MCPs/LLMs.
5. Safety before scale — verification, approval gates for irreversible actions, consent windows, audit, and human handoff are non-negotiable.
6. Voice operates naturally — no silence, no robotic holds; sound human, act like a teammate.
