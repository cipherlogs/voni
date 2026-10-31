# Progress

Current frontier for this repo. Read this at the start of a session; keep `Now` current after finishing a meaningful chunk of work.

## Now

**Goal:** the public demo call runs only on the cascade, with no managed fallback; tenant agent calls and test calls stay managed, in English. One build ships both surfaces.

**Demo cascade — complete on `demo-cascade` (25/25 tickets resolved):**

- **App channel:** `/api/demo/token` builds and signs the v2 demo body, delivers it to `/v1/call-body`, mints the single-use cascade token, and returns identity only (`engine: cascade`, `wsUrl`, `demo:<voice>`, call token, demo call token, tag, wall cap). No vendor token call and no managed agent on the live path.
- **Browser:** the landing demo starts the real cascade client; a refused connect is the visitor's unavailable state with no managed retry. Notes travel as hidden context; the silence check-in, invite chip, code readback, and hold return are wired for the pipeline's server-side tools.
- **Service:** v2 envelope with signed subject kind; routing reads that kind once and freezes it; `routing=demo` is production, `routing=off` is the kill switch (refused with zero vendor sessions). Five demo voices bound; traces keyed by call id with `demo:<voice>` on every line; `cost.priced` row per call; Northflank one-instance topology.
- **Latency/tools fix (2026-10-31), Meta only:** the cascade runs the Standard Spark rung (`providers.llm.provider=spark`) with Meta STT (`providers.stt.provider=meta`); no gateway/non-Meta override rides the demo body. Call control is now deterministic: Spark never called the hang-up tool on a caller request (0/20), so `cascade/end_intent.py` ends the call from the caller's words after the model's goodbye. `META_REASONING_EFFORT=minimal` measured p50 951 ms vs 1648 ms at `low` in a fast window; later samples show p50 1.99 s / p90 2.46 s / max 3.96 s, so the vendor tail remains the open latency item. Meta STT endpointing measured 633-867 ms (`real-legs` reply-gaps check). The demo browser now starts replies on a 250 ms cushion (managed stays 500 ms), and a vendor close after our own `Cancel` is a planned handover, not a failure reconnect. A demo-only hedge (`cascade/hedge.py`, `llm.hedge_delay_ms`) races two Meta requests and adopts the winner; at the fair 1 ms race real-legs counted `hedge 4/3`, but the winning stream still measured 2.9/1.9/2.8/1.5 s when both requests hit a slow Meta window, so the vendor tail is not yet capped. A demo-only spoken ack (`cascade/ack.py`, `reply.ack_delay_ms=300`) now covers the wait: real-legs caller-final→first audio is 0.47-0.51 s (one 1.03 s) while the substantive reply still takes 1.9-2.8 s; the ack is never captioned and is not the reply.
- **Evidence:** `npm test` 2618 pass / 1 skip; Python 74 bridge + 2212 pipeline; `npm run test:e2e:cascade` 2/2; cascade rig 2/2 (58.9 s, budget 120 s; the runner now installs with `npm ci --offline` so the cached esbuild platform binary is used instead of the failing registry download); `check:real-legs` 18 checks: 17 PASS + 1 INFO (three turns, consumed context note, caller hang-up with `endedBy stop`/`end_call 1`, hold return, trace, cost); `parity:check` 11/11; `cutover:check --prove-off` 13/13. ADR-0012 records the split; `docs/deploy/cutover-runbook.md` is the operator path.
- **Human gate left:** set the production Northflank switch to `demo` (operator + reason + audit), set `META_REASONING_EFFORT=minimal`, deploy outside demo hours, then run `parity:check` and a non-skipped `check:real-legs`. The local rehearsal proves the same switch/off/audit behaviour.

**Next action:** the production flip in `docs/deploy/cutover-runbook.md`. Remaining latency work: the spoken ack is in; the substantive answer still waits on Meta. The demo body no longer carries a model override at all (Vercel AI Gateway is Jev's judge key only). To benchmark Glimmer, the direct Meta catalogue for the current `META_API_KEY` (`https://api.meta.ai/v1/models`) lists only `muse-spark-1.1/1.2/1.3`, `muse-wonder-1.0`, `sam-3.1`, `muse-voice-transcribe-1.0` and `muse-image-1.0`; `muse-glimmer-30b`, `muse-glimmer-30b-contributor` and `glimmer-30b` return 404 on that key, so the exact direct-Meta model id (and base URL, if it differs) is needed before the comparison can run.

## Not current

- `voni.cc` / `app.voni.cc` domain move: owner-side Cloudflare zone, OAuth origins, deploy. Independent of the cascade.
- Managed-path reply-gap bar: open decision, superseded by the cascade; settle at cutover or drop.

## Rules

- One or two lines per item; point at the code or doc that owns it. Tickets and specs are deleted when done — the code is the source of truth.
- No activity log — history lives in git, not here.
