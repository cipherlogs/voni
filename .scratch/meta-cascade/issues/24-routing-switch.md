# 24: Routing switch: off, demo, all

**What to build:** A durable routing switch read before the first frame. Off produces zero cascade connections; demo makes stored demo subjects eligible; all makes every eligible subject eligible. The switch governs new calls only, and every change has an audit trail.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Off produces zero cascade connections for every new call.
- [ ] Demo makes stored demo subjects eligible and routes tenant calls managed.
- [ ] All makes eligible subjects eligible, and a refused body still routes managed with a reason.
- [ ] A live call is never moved by a change; the switch is read before the first frame only.
- [ ] Every change is durable and records who, when, from and to.

## Answer

Shipped `cascade/routing.py`: `RoutingMode` off|demo|all, `RoutingRecord` v1 (mode + append-only audit trail of who/when/from/to), CAS writes over `cascade.store.DurableStore` (`MemoryStore`/`SqliteStore`) at key `routing:switch`.
`RoutingSwitch.decide(subject, refusal=)` performs exactly one durable read and returns a frozen `RoutingDecision` (mode, subject, disposition cascade|managed, reason, recordVersion, decidedAt, `opens_cascade_connections` 0|1) — the snapshot the call carries, so a later flip cannot move a live call.
off routes every subject managed; demo cascades only `CallSubject(kind="demo")` and routes tenant calls managed; all cascades every subject unless a caller refusal (body/voice/counter) is passed, which routes managed and keeps that reason; routing's own refusal wins.
Fail-safe: missing switch = off/managed, unreadable or corrupt switch = mode None/managed with an honest reason; a managed decision must name its reason and a cascade decision cannot carry one.
Evidence: `cascade/test_routing.py` 30 tests, red-first (ModuleNotFoundError, then two validation assertions red before the guard); full suite 280 tests OK. Ticket 25 can use pure `routing_refusal()`/`decide()`; 103/147/148/153 assert on `RoutingDecision` with no call (147 still owns the real socket count; `opens_cascade_connections` is the contract).

_Implemented on `feat/meta-cascade` (ticket commit merged)._ 
