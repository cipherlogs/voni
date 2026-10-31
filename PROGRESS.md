# Progress

Current frontier for this repo. Read this at the start of a session; keep `Now` current after finishing a meaningful chunk of work.

## Now

**Goal:** the public demo call runs only on the cascade, with no managed fallback; tenant agent calls and test calls stay managed, in English. One build ships both surfaces.

**Demo cascade — complete on `demo-cascade` (25/25 tickets resolved):**

- **App channel:** `/api/demo/token` builds and signs the v2 demo body, delivers it to `/v1/call-body`, mints the single-use cascade token, and returns identity only (`engine: cascade`, `wsUrl`, `demo:<voice>`, call token, demo call token, tag, wall cap). No vendor token call and no managed agent on the live path.
- **Browser:** the landing demo starts the real cascade client; a refused connect is the visitor's unavailable state with no managed retry. Notes travel as hidden context; the silence check-in, invite chip, code readback, and hold return are wired for the pipeline's server-side tools.
- **Service:** v2 envelope with signed subject kind; routing reads that kind once and freezes it; `routing=demo` is production, `routing=off` is the kill switch (refused with zero vendor sessions). Five demo voices bound; traces keyed by call id with `demo:<voice>` on every line; `cost.priced` row per call; Northflank one-instance topology.
- **Latency/tools fix (2026-10-31):** the signed demo body now carries the gateway model override the provisioning path already used (`google/gemini-2.5-flash`, thinking off). Warm browser turns measure `final_to_first_token` ~0.98 s and `final_to_first_playout` ~1.20 s (Spark was 1.4-4.2 s). Call control is `hang_up`: Spark ignored an identically shaped `end_call` and never hung up. A clean voice close now reopens before the next reply, so a barge-in during the greeting no longer kills the call with "the synthesis session is not open". Live browser: "please hang up" ends `endedBy stop` with one goodbye and `end_call: 1`.
- **Evidence:** `npm test` 2616 pass / 1 skip; Python 74 bridge + 2207 pipeline; `npm run test:e2e:cascade` 2/2; `check:real-legs` 15 PASS + 1 INFO (two turns, consumed context note, hold return, trace, cost); `parity:check` 11/11; `cutover:check --prove-off` 13/13. ADR-0012 records the split; `docs/deploy/cutover-runbook.md` is the operator path.
- **Human gate left:** set the production Northflank switch to `demo` (operator + reason + audit), deploy outside demo hours, then run `parity:check` and a non-skipped `check:real-legs`. The local rehearsal proves the same switch/off/audit behaviour.

**Next action:** the production flip in `docs/deploy/cutover-runbook.md`; no code work is open on the demo cascade.

## Not current

- `voni.cc` / `app.voni.cc` domain move: owner-side Cloudflare zone, OAuth origins, deploy. Independent of the cascade.
- Managed-path reply-gap bar: open decision, superseded by the cascade; settle at cutover or drop.

## Rules

- One or two lines per item; point at the code or doc that owns it. Tickets and specs are deleted when done — the code is the source of truth.
- No activity log — history lives in git, not here.
