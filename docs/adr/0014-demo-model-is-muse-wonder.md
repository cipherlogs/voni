# The demo's model is Muse Wonder, named in the signed body

**Status: accepted (demo surface). Owner decision, 2026-11-03: "we can use wonder."**

The demo now names Meta `muse-wonder-1.0` as its product default. The choice is
carried the only way the cascade already supports a model choice: one explicit
provider entry in the signed demo body
(`voni/src/lib/demo/cascade-body.ts`), which `transport.py` turns into the
call's one model client. There is no env flag to set for the product default
and no second pipeline default; `DEMO_LLM_MODEL_OVERRIDE` exists only as a
test/A-B switch and is unset in deploys.

This record adds to ADR-0012 (the demo runs on the cascade) and changes nothing
about ADR-0011's tenant path.

## What stays the same

- **The model guard does not move.** `STANDARD_MODELS` is still
  `("muse-spark-1.3",)`, and `resolve_model`/`assert_standard_model` still refuse
  `muse-wonder-1.0` by name on every default rung. `assert_override_model`
  allows only the two Standard ids and still refuses every Contributor id.
  `meta_llm.py` applies that gate only when the override points at Meta's own
  host, so a tenant's BYO host keeps ticket 159's path.
- **Prompts, tools and turn mechanics do not change.** Only the model id and
  its price table move.
- **A model the table does not price is unmeasured.** The cost row names the
  reason instead of borrowing another model's rate.

## Pricing

`voice-pipeline/cascade/rates/v2.json` (read 2026-11-03 from
`https://dev.meta.ai/docs/pricing-rate-limits`) declares the model-scoped llm
rates: **$4.00 per 1M input, $0.20 per 1M cached, $20.00 per 1M output**
(reasoning is billed inside output; the page lists no separate rate). The
unscoped `llm.*` keys stay Spark's v1 prices. The call selects the table from
the model its stream serves, and all three pricing sites — the end-of-call row,
the daily counter's charge, and the live per-call ceiling — pass that model, so
a wonder call is never guarded or charged at Spark's rate.

## Consequences

- **A call costs more.** At the A/B run's hostile and skeptical calls, wonder was
  $0.0252/$0.0192 against Spark's $0.0219/$0.0178; the token rate is roughly
  3.2x input and 4.7x output, so a longer call widens the gap. The cost row and
  the ceiling are the controls; neither is estimated.
- **The signed body carries the Meta key.** The override entry must carry the
  credential it is sent with. The body travels app-to-pipeline server-side; the
  browser response still names only the identity, never the body or the key.
- **No `safety_identifier` on this path.** The BYO constructor has never sent
  Meta's optional pseudonymous abuse identifier; the Standard rung did. The
  demo now uses the BYO path, so it does not. Recorded here rather than
  discovered later; adding it would be a separate change to the BYO surface.

## Considered options

- **Add wonder to `STANDARD_MODELS`.** Rejected: that would allow it on every
  tenant Standard call, which is the guard the Standard-only rule exists for.
- **A pipeline-side demo default.** Rejected: the model would then be a second
  source of truth beside the signed body, and the app could not name what it
  runs.
- **An env flag for the default.** Rejected: a deploy could then silently run a
  different model than the demo it claims. The flag stays test-only.
