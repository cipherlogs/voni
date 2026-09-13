# Gates: Voni strategy presentation

OWNS: GATES.md, src/app/prototypes/strategy/**, .impeccable/review/strategy-*.png

Scope: Replace the strategy document as the primary reading experience with a complete, responsive, development-only Voni presentation page that explains the decision through diagrams, comparisons, real-world scenarios, and cited evidence.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node /home/cipherlogs/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: the page contains the complete decision narrative, capability comparison, three scored workflows, lighthouse journey, operating model, regulatory patterns, delivery phases, and source index
  CHECK: node --import tsx --test src/app/prototypes/strategy/page.test.ts
  EXPECT: tests 1
  EVIDENCE: pending

- [ ] G2: the new route and its content compile and pass targeted lint
  CHECK: npx tsc --noEmit && npx eslint src/app/prototypes/strategy/page.tsx src/app/prototypes/strategy/content.ts src/app/prototypes/strategy/page.test.ts && echo 'strategy static verification passed'
  EXPECT: strategy static verification passed
  EVIDENCE: pending

- [ ] G3: the finished page has no mechanical Impeccable detector findings
  CHECK: /home/cipherlogs/.agents/skills/impeccable/scripts/impeccable detect --json src/app/prototypes/strategy/page.tsx src/app/prototypes/strategy/strategy.module.css
  EXPECT: "findings":\[\]
  EVIDENCE: pending

- [x] G4: the development route renders the complete desktop and mobile presentation without framework, browser, overflow, or accessibility errors
  EVIDENCE: Next 16.3.4 compile_route returned issues=[] and get_errors returned no config or session errors on 2026-09-13; agent-browser 0.36.0 rendered 1440x1000 and 390x844 captures, reported 390px document scroll width at a 390px viewport, no 4xx/5xx requests or runtime errors, CLS 0, and axe WCAG A/AA violations=0. The only axe incomplete check was the aria-hidden decorative V mark, whose adjacent visible wordmark provides the label.

- [ ] G5: a fresh visual review finds the hierarchy, diagrams, examples, citations, and responsive reading path ready to show to a stakeholder
  EVIDENCE: pending
