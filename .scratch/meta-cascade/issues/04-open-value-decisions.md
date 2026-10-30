# 04: Open-value decisions with a stated source

**What to build:** The owner and operator record each open threshold and external decision with a stated source, so no ticket invents a number: turn stall guard, tool-call loop cap, daily spend cap, per-call ceiling, deploy drain maximum wait, TTS keepalive interval, UTC day boundary, container host and browser E2E runtime budget.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Each value is recorded with its unit, the gate it feeds, its source and the date it was taken.
- [ ] A value that cannot be sourced is recorded as open, and the tickets that need it stay blocked rather than shipping a guess.
- [ ] The threshold registry loads every recorded value without a code edit.
- [ ] The container-host decision names one host that supports long-lived WebSockets and rolling deploys, and explicitly excludes Cloudflare Workers with the reason.

## Answer

Ticket 04 resolved by direct owner decision, 2026-10-30.

All open bounds are recorded in `voice-pipeline/cascade/thresholds.json` with
unit, gate, owning ticket, source and date:

- daily cap 25 USD; per-call ceiling 0.25 USD; day boundary UTC
- drain max wait 30,000 ms; turn stall guard 2,500 ms; tool loop cap 3
- TTS keepalive 30,000 ms; browser E2E budget 120 s
- reply task 10,000 ms; tool timeout 5,000 ms; reconnect handshake 10,000 ms
- signed-envelope TTL 60,000 ms; probe completion cap 16 tokens
- playout cushion 500 ms (from `playout-processor.js`, recorded by this ticket)

Container host: Fly.io, recorded in `docs/deploy/meta-cascade-host.md`, with
Cloudflare Workers explicitly excluded (no long-lived WebSocket execution
model, CPU/connection limits, no persistent process for probes/drain/store).

The registry loads every value without a code edit; `test_thresholds.py` pins
each supplied value and asserts no production bound is left open. The two
spike-report tests that pinned the cushion as unmeasured were updated to the
supplied 500 ms and still assert AT RISK, never PASS.

_Owner decision recorded on `feat/meta-cascade`._
