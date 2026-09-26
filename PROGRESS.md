# Progress

Current frontier for this repo. Read this at the start of a session; keep `Now` current after finishing a meaningful chunk of work.

## Now
- `button-cursor-draft-gate` — tickets 01 + 02 done (`.scratch/button-cursor-draft-gate/issues/`, both `done`; 01 committed on `redesign/minimalist-editorial-pass` as `ba2896de`, 02 pre-existing; suite green).
- `sidebar-03-brand-swap` — all tickets resolved (01/03/06 done, 02 done-superseded, 05 wontfix, 04 done with runtime loop).
- `sidebar-avatar-menugroup-fix` — spec done, no tickets needed (all stories verified shipped + test-pinned; `.scratch/sidebar-avatar-menugroup-fix/spec.md`).
- `minimalist-editorial-pass` — spec published, `ready-for-agent` (`.scratch/minimalist-editorial-pass/spec.md`; serif amendment + big-bang, seams confirmed); tickets 01–09 published (`.scratch/minimalist-editorial-pass/issues/`, 01–04 done, frontier: 05).
- `demo-prospect-capture` — tickets 01–06 published (`.scratch/demo-prospect-capture/issues/`); 01 done (Voni as itself, call-scoped demo tools, talk clock, Jev stakes ladder), 02 done (hold on page-leave: union clock pause, hold cap, context-carry rejoin), both awaiting manual test; frontier: 03.
- `voice-barge-in` — server barge-in + Voni recovers (filler/echo/aside resumes; an end-call request always yields); never send `turn_detection` (any object kills adaptive end-of-turn: replies 1–2.2s, were 3.7–4.7s); nothing heard or captioned after the goodbye, ~1s end call; evals 32/32 (`npm run eval:demo-agent`); ADR `docs/adr/0003-barge-in-recovery.md`; awaiting a manual demo call.
- `mobile-takeover` — fullscreen verifier green 3× + phone PASS (`.scratch/mobile-takeover/issues/01-verifier.md`, resolved; gate: `npm run test:mobile:takeover`).
- `mobile-takeover/02-whatsapp-layout` — hero + subtitle + dock built, verifier green 4×, awaiting phone PASS (`.scratch/mobile-takeover/issues/02-whatsapp-layout.md`).
- `transcription-accuracy` — balanced STT + final-only user captions + instant agent captions + widened filler filter + cascade soft-yield, uncommitted; suites green (voni 558, voice-pipeline 87, telephony-bot 35).
- `platform-voice` — Voni de-real-estated (per-agent listening vocabulary + mission-derived prompt + words-to-listen-for field), built-in end_call with drain-then-hangup on all paths, overlap intelligence (command bypass, overheard rows, pivot steering), phone UX (captions default-open, heard-indicator, word reveal, orb-safe layout), call-sound wiring awaiting user mp3s, orb mark removed; uncommitted.
- `platform-voice-2` — demo actually hangs up now: demo agents ship end_call + tuning with fingerprint-gated in-place refresh; dashboard agents self-heal via fingerprint compare on agents-page visits (visible jobs, one inline notice); orb core removed, state-driven tint; end_call results stripped of speakable narration + no-announcement rule; stored-agent tool bodies now REST-shaped (no `type` field) via `toRestTool` so the API registers the tool instead of dropping it; end_call carries `response_instructions` ordering post-hang-up silence so the model never narrates the ending and never repeats the goodbye; goodbye drain needs 3 consecutive settled polls + 500ms audio grace so jittery links never chop the last word; uncommitted, migration 0011 applied to dev DB directly (other envs: run db:migrate).
- `voice-gain-mic-loss` — demo/input-drop probe + mute-during-connect fix; per-voice volume match (`output.volume=100` everywhere, client gain anna 1.0 … giovanni 3.89, previews normalized to -23 LUFS); uncommitted, awaiting live demo call per voice.

## Done

- `settings-bento` tickets 01–09 committed (registry + gallery, scene rework, landing + shell, section pages, badges, animated backgrounds, hover prefetch, voice contract, cleanup + gates, image-art replate per user picks).

## Rules

- One or two lines per item; link the ticket path.
- No activity log — history lives in git, not here.
