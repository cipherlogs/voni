# Disposition of open voice-parity tickets

Reference for the Meta cascade spec (`.scratch/meta-cascade/spec.md`). Tracker state at time of writing: **70 resolved, 10 `needs-info` (49–57, 59), 1 `ready-for-human` (81).** Nothing here reopens a resolved ticket; two resolved tickets keep their tests and gain a successor.

Three verdicts only: **keep** (stands, possibly extended), **re-scope** (substance stands, its blocker or its subject changes), **supersede** (its premise no longer holds).

## Open tickets

| # | Title | Verdict | Reason |
|---|---|---|---|
| 49 | Structured rule set and English rendering | **re-scope** | Substance unchanged; `Blocked by: 41` is a resolved managed-path gate, so the ticket is currently *unblocked* in the tracker and must point at **M16** instead. |
| 50 | Rule completeness per Locale | **re-scope** | Same blocker correction; the no-silent-English-fallback rule is engine-independent. |
| 51 | Spanish rendering | **re-scope** | Same; `lola`/es is the first cascade subject, so this is the first rendering a re-audition can actually judge. |
| 52 | French rendering | **re-scope** | Same blocker correction. |
| 53 | German rendering | **re-scope** | Same, plus its audition subject changes: the German voice is re-cast under M15 because `juergen` returns `422 voice_not_found` from the synthesis endpoint. |
| 54 | Italian rendering | **re-scope** | Same blocker correction; `giovanni` renders, so no re-cast. |
| 55 | Portuguese rendering | **re-scope** | Same blocker correction. |
| 56 | Tool descriptions per Locale | **re-scope** | Same, plus scope grows: descriptions now feed the store body *and* the cascade's `tools` array, and the narration rule becomes structural (M08). |
| 57 | Hidden instructions and banned phrases per Locale | **re-scope** | The *set* of hidden instructions changes on the cascade — the `reply.create` steer message and the pre-tool hold line replace managed-only hidden context. Re-enumerate before rendering. |
| 59 | Judge calibration harness | **re-scope** | Calibration is against reviewer baselines, so it survives any engine; blocker moves to **M16**. |
| 64 | Turn preset on every agent | **keep** | Resolved and still true for the managed path while it lives. The cascade has no turn preset to set, so this closes with the managed path at **M19** rather than being superseded. |
| 65 | Remove the tenant turn-detection object | **keep** | Same: its contract test still protects the managed path during the A/B, and `turn_detection` is in the cascade adapter's ignore set (M05). |
| 81 | Owner audition and final sign-off | **re-scope** | Becomes the human half of **M19**: six subjects instead of one verdict, the German re-cast in the set, and the W2 re-audition (M16) recorded before it can be signed. |

## W4 set (one product)

| # | Title | Verdict | Reason |
|---|---|---|---|
| 60 | One agent-body builder | **keep** | The cascade reads the same body through one adapter (M05); no second builder is introduced. |
| 61 | Profile whitelist rejection | **keep, extend** | Gains a cascade row: a body key in neither the field map nor the ignore set must fail. |
| 62 | One fingerprint over the whole body | **keep, extend** | M05 requires the served fingerprint to equal the minted one, which is a stronger assertion than the current test. |
| 63 | Override removal path | **keep, extend** | Its consequence becomes explicit: a body carrying an `llm` override is constructed from the stored body and runs cascade (ticket 159 replaces the refusal); `llm: []` is the documented revert to the default rung. |
| 66 | Persona-neutral quality floor module | **keep** | Unchanged; one module, persona-independent. |
| 67 | Quality floor on every agent | **keep, extend** | The cascade must splice the same floor through the M05 map, and the floor now also governs the pre-tool hold line. |
| 68 | Tenant/demo mechanics parity assertion | **keep, extend** | Turn-preset parity is meaningless on the cascade and is replaced there by floor + recognition-policy parity; the assertion gains a cascade row. |
| 69 | Phone goodbye drain | **keep** | The phone stays on the managed bridge. Its cascade analogue is parked in M20. |
| 70 | Phone unheard-tail barge-in recovery | **keep** | Same, and its recorded case table is reused verbatim as M09's cross-engine proof. |
| 71 | Phone capture windows | **keep** | Managed phone behaviour is unchanged and out of this slice. |

## W5 set (parity proof)

| # | Title | Verdict | Reason |
|---|---|---|---|
| 72 | Subject axis | **keep, extend** | Gains `pipeline` as a fourth axis, so `{agent, Locale, transport, pipeline}` is the subject. |
| 73 | Matrix derives each subject's gates | **keep, extend** | Rows become subject × pipeline; the no-carried-verdict rule is unchanged and now also guards the A/B. |
| 74 | Measured timbre plus weighted ballot | **keep, extend** | The six measured axes survive; on the cascade they compare delivered against reference, with no platform leg. |
| 75 | Language-naturalness axis | **keep** | Unchanged; engine-independent. |
| 76 | English-leak counter | **keep** | Reused unchanged on the cascade transcript. |
| 77 | Already-answered counter | **keep** | Unchanged. |
| 78 | Featured voice first | **keep** | The ordering rule applies identically: `anna`/en passes before `lola`/es is judged. |
| 79 | Previews covered by the clip test | **keep, re-scope** | Previews are now generated from the synthesis endpoint at native level; the level leg reads native level because `output.volume` does not exist on the cascade. |
| 80 | Doctrine decision record | **keep** | ADR 0009 is the basis for the kill criterion and for refusing a green from a fallback-contaminated run. |

## Superseded — not tickets, premises

| Thing | Verdict | Reason |
|---|---|---|
| `.scratch/voice-parity/spec.md` "Out of scope: switching speech vendor" (line 213) | **supersede** | ADR 0011 supersedes it. The vendor's own playground was the evidence *for* the voices, never for the orchestration. |
| `voice-pipeline/README.md` "early commit" premise and the Cartesia P1 backend | **supersede** | Meta exposes no per-turn commit; the gate becomes floor arbitration, and synthesis is AssemblyAI (ADR 0011). |
| `voni/src/app/api/voice-preview/route.ts` "AssemblyAI offers no standalone TTS" | **supersede** | The endpoint exists and our own evidence was captured through it; the comment is wrong and the route's rationale changes. |

## Affected outside the requested set

| # | Title | Note |
|---|---|---|
| 37 | Stored-body level | `output.volume` becomes managed-only; the cascade keeps native level and carries no gain stage. |
| 24 | One-body seam (harness integrity) | Resolved for the harness, and violated today by the cascade, which takes `system_prompt` and `tools` off the wire. M05 restores it for the cascade. |
| 41 | Re-audition evidence | Resolved, but it judged the managed path. Its verdict does not carry over; M16 re-runs it on the cascade. |

## Tracker correction applied

Ticket 49 listed `Blocked by: 41`, and 41 is resolved — so 49 appeared on the frontier while its own comment said "paused", and 50–57 only inherited the stop through 49. Every `Blocked by` line in 49–57 and 59 now also names **M16**, the gate that actually blocks them, so no one can start the lane by reading a stale edge. This file is the single disposition record; per-ticket comments are added when a ticket is picked up, not duplicated here.

## Amendment 2026-10-30 — cascade is the product target

The owner changed the cutover target. This supersedes the earlier "demo only, tenants stay managed" reading; the per-ticket history above is otherwise unchanged.

- **Routing at cutover is `all`, not `demo`.** Every eligible subject, demo or tenant, runs cascade; ineligible bodies route managed with a named reason. `off` remains the rollback.
- **Managed is the fallback, not a parallel product.** It is not removed at cutover. Removal is ticket **161**, after a recorded stability window; until then `off` must route a working product.
- **BYO-LLM tenants are in scope** (ticket **159**): the cascade constructs the model client from the stored body's one provider entry. The old "non-empty `llm` refuses cascade" rule is replaced.
- **Auto-detect tenants are in scope** (ticket **160**): STT omits `languageBias`, synthesis uses the bound voice's Locale. An unbound voice is still refused.
- **Kill criterion:** a failed three-round measurement stops the automatic cutover; an explicit, dated owner risk acceptance may still proceed, with the evidence attached.
- Ticket **155** ACs and the title of ticket **152** were amended; **159**, **160**, **161** were added.
