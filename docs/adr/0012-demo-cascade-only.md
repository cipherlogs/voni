# The demo runs only on the cascade; the tenant path stays managed

**Status: accepted (demo surface).**

The demo call is the product's sales asset, and it is the one surface where the visitor sees what we built. It therefore runs on the cascade pipeline, and only on the cascade pipeline. The tenant product does not change: tenant agent calls and test calls stay on the managed path, in English.

This record narrows ADR-0011 rather than replacing it. ADR-0011 remains the standing record for the tenant path only; its rule that "the managed path stays the routing default until the cascade is proven on the frozen budgets" is reversed for the demo, not for tenants. The demo no longer waits for that proof because the demo is the proof being shown: a managed fallback would replace the stack on display with the one that measures 1923 ms p50 against a 1500 ms budget.

## The split

- **The demo is cascade, with no managed fallback.** A refused, draining, or unavailable cascade connect ends in the visitor-facing unavailable state. The existing single managed retry is removed for demo mode, and it is kept nowhere else because no other surface uses the cascade. A visitor never receives a call on an engine we did not choose to show.
- **The tenant path is managed, in English.** Tenant agent calls and test calls do not change. No route mints a cascade call for a tenant subject; the signed body declares the subject kind (`demo` or `tenant`) explicitly, and routing never infers the kind from an id or a name. The dashboard's Cascade toggle is removed, because there is no tenant cascade to select.
- **The app has no engine flag.** There is nothing to choose: the demo is cascade, the app is managed. One build ships both surfaces; local and production differ only in the pipeline URL and the envelope secret.
- **`routing=demo` is the demo's permanent production value.** The durable `routing:switch` row is the one authority on whether a new call may open a cascade connection. It is read once per call and frozen, so a flip never moves a live call.
- **`routing=off` is the kill switch.** Every new demo call is refused, zero vendor sessions open, and the visitor sees the unavailable state. It is never a silent engine change: a refusal is a routing decision, not a fallback event, and the refusal happens before the first vendor-facing leg is built. The proof is the routing decision's `opens_cascade_connection` count, not a log line.
- **`routing=all` is unused by this product.** It would make tenant calls eligible on the same service, widening the surface this record deliberately splits.

The producers are `cascade/routing.py` (`RoutingMode`, `RoutingDecision`) and the transport that freezes the decision before the first frame. `cascade/test_routing.py` pins that `off` routes every new call — demo and tenant — managed with `opens_cascade_connection` false.

## The Locale conflict with ADR-0009

ADR-0009 rejected "offer fewer locales" as a way to hide a weak locale. Withdrawing Italian from the demo is exactly that shape, so this record states its reason rather than leaving it inferred.

**Italian is withdrawn from the demo because it is not a target market for the demo.** The demo's audience is English, Spanish, French, German, and Portuguese; adding Italian would add a Locale to staff, audition, and review for a market the demo does not address. The reason is market scope, not audio quality.

This is not ADR-0009's objection for a second reason: the Italian renderings and the `giovanni` catalogue entry remain in the code, unused. Nothing that shipped is being hidden. A stored tenant agent on Italian still resolves its voice; the demo picker simply does not offer it. The demo offers five voices, one per Locale: `audrey` (en), `malvina` (es), `donatien` (fr), `jorg` (de), `benicio` (pt). If any offered Locale is weak, ADR-0009 still governs: it is fixed, not dropped. This record makes no quality claim about Italian in either direction; it removes it from a demo whose audience is five markets.

## Evidence, by producer

- **Trace.** `EventWriter(pipeline="cascade", call_id=…)` and `CallEventLog(events_dir(), call_id=…)` (in `voice-pipeline/server.py`, events in `voice-pipeline/cascade/events.py`) write one JSONL artifact keyed by the demo call id. A demo `EventStream` is constructed with `subject_kind="demo"` and refuses any line whose subject is not `demo:<voice>` at construction and again at the one write boundary. Every call-scoped line carries `subject: "demo:<voice>"`; operational lines (breaker transitions, budget crossings) carry a `leg` instead of a subject by design and still carry the call id. A hold return appends to the same artifact. This is ticket 17's producer, not the prose describing it.
- **Cost.** One `cost.priced` row is emitted at end of call from the single pricing answer used for both the trace and the end message. The row is produced by `cascade.cost.cost_call` and carries `producer: "cascade.cost.cost_call"`, `measured`, `totalUsd`, the measured `legs` units, and `rateTableVersion` (`cascade-vendor-rates v1`, read from `voice-pipeline/cascade/rates/v1.json`). A price change is a new version file, never an edit; an unmeasured leg makes the row unmeasured with a named reason, never a silent zero. This is ticket 18's producer.
- **The real legs, key-gated.** `npm run check:real-legs` (`voni/scripts/real-legs.mts`, pure surface in `voni/scripts/lib/real-legs.ts`) starts a two-turn call through the app's own `buildDemoCascadeBody` and `deliverCallBody`, then asserts that every trace line binds to the call id and `demo:<voice>` and that the `cost.priced` row is measured or says why it is not. It skips by name without `META_API_KEY` and `ASSEMBLYAI_API_KEY`, never runs in the pull-request path, and is the pre-demo and post-deploy proof. This is ticket 22's check.

## Considered Options

- **Keep the managed demo and prove the cascade later.** Rejected. The demo is the sales asset; the managed path is the one that fails the reply-gap budget, and waiting for a tenant cutover would keep the demo on the wrong stack for the whole proof period.
- **Keep the single managed retry as a safety net.** Rejected. A refused or draining cascade would silently become a managed call, which is the one engine change the visitor must never see. It would also make the trace and the cost row ambiguous about which stack produced the demo.
- **A tenant cascade behind the same durable switch.** Rejected for this record. Tenant and test calls stay managed in English; that is the product split, and the switch's `all` mode is left unused.
- **Use `routing=all` as the production value.** Rejected. It would make tenant calls eligible on the demo service and turn a demo control into a tenant engine decision.
- **Reinstate Italian before cutover.** Rejected. Italian is not a target market for the demo, so reinstating it would add a Locale to staff and audit for no demo audience; the renderings stay in the code unused.
- **Keep the dashboard's Cascade toggle.** Rejected. There is no tenant cascade to toggle, and a control that cannot change the engine is a false affordance. The app has no engine flag.

## Consequences

- **ADR-0011's default sentence is narrowed to the tenant path.** ADR-0011 still governs the cascade design, the budgets, the kill criterion, and the tenant cutover decision. It no longer describes what the demo runs.
- **A cascade outage means no demo.** The deploy window refuses new demo calls for up to the drain bound, and a vendor outage means no demo until it clears. That is the accepted cost of one instance; deploying outside demo hours is the runbook mitigation.
- **Demo evidence is cascade-only.** A scoreboard or readiness read that still comes from the managed demo body must say so; the cascade and managed body sources stay labelled rather than blended.
- **Rollback is one durable value.** Turning the demo off is `routing=off` with no rebuild and no deploy, and it refuses every new call while opening zero vendor sessions.
- **The trace and the price are the demo's evidence form.** A call is readable by call id, attributable to `demo:<voice>`, and priced with the rate-table version it was priced with; a claim that cannot cite those producers is not evidence for this surface.
