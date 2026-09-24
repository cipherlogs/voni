# 05: Agent detail and campaigns on the Blocks contract

**What to build:** Audit the existing agent-detail and campaign behavior against the pinned Blocks sources before changing markup. Keep the agent deploy summary on `onboarding-07` plus the truthful `onboarding-06` timeline. Keep campaign collections on the `table-05` base with `table-02` row actions. Forms use the actual `form-layout-02` / `form-layout-03` contract: flat side-label sections, `Separator` boundaries, responsive stacking, and a final action row. Do not add filled form bodies or copy dimensions from the mockup. Deployment tracking, retries, gating, notifications, queries, and handlers stay unchanged.

**Blocked by:** 01 (foundation — serif amendment, token sweep, motion unification).

**Status:** in-progress

- [ ] Agent detail pipeline shows created, saved-version, and deployment meters plus at most three timeline entries with explicit state text and omitted (never invented) timestamps; form and preview markup restyled with parse, normalize, handlers, and save and test gating unchanged
- [ ] Campaign forms follow base-height controls, width caps by field kind, flat side-label sections, invalid states per the form primitives, and final action rows after a separator; paired actions are secondary-left and primary-right on desktop with the primary action on top when stacked
- [ ] Running-app check on agent detail and all campaign routes (desktop plus narrow viewport, forced loading and error states including failed and cancelled deployments) with zero compile or console errors
