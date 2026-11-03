# model-ab: Muse Spark vs Muse Wonder on the same two calls

Measurement record, kept as the evidence behind
[ADR-0014](../adr/0014-demo-model-is-muse-wonder.md). It was taken on branch
`ticket/model-ab`, base `demo-verification` (21fce845). Worktree dev stack: app
:3001, worktree pipeline :8770, TLS :8768. Calls paced 25 s, no certification
run. Evidence (gitignored): `voni/.demo-runs/model-ab-spark/`,
`voni/.demo-runs/model-ab-final/`.

## What changed on that branch

- `voni/src/lib/demo/cascade-body.ts`: `DEMO_LLM_MODEL` (unset by default on
  that branch) added one signed-body `LlmOverride` for `muse-spark-1.3` or
  `muse-wonder-1.0`; the default body was byte-for-byte unchanged.
- `model_guard.py`: `assert_standard_model`/`resolve_model` still refuse
  wonder; `assert_override_model` allows it only on the explicit body path.
  `meta_llm.py` applies that gate only when the override targets Meta's host,
  so tenant models keep ticket 159's path. Contributor ids stay refused.
- `rates/v2.json`: public Meta prices read 2026-11-03 from
  https://dev.meta.ai/docs/pricing-rate-limits — wonder input $4.00/1M,
  cached $0.20/1M, output $20.00/1M. `cost.py` prices a call from its own
  model's scoped rates; an unpriced model leaves the llm leg unmeasured.
  Spark calls still cite v1.

It is now merged with one change: the demo's default override names
`muse-wonder-1.0` (ADR-0014), so no env flag is needed for the product default.

## Side by side

| | spark hostile | wonder hostile | spark skeptical | wonder skeptical |
| --- | --- | --- | --- | --- |
| final_to_first_token | 3368 ms | 2436 ms | 2484 ms | 1104 ms |
| final_to_first_playout | 3799 ms | 2776 ms | 2730 ms | 1494 ms |
| feeling label | no | no ("not working the way you need") | no | no |
| call-centre phrase | yes ("I'll go through it with you", "put right") | yes ("walk through what I can do") | yes ("I'm Voni the voice agent you're testing live") | no |
| offer on complaint | yes (fix it) | yes ("Tell me exactly what broke") | yes (email pitch) | yes (email pitch) |
| repeated line | no | no | yes (two "I'm Voni … live" lines) | no |
| cost | $0.0218693 (v1) | $0.0251544 (v2) | $0.0178068 (v1) | $0.0191668 (v2) |

## Transcripts

### spark — emotion-hostile (browser-mvzzun30-4b6143d6)
- caller: this is ridiculous. Your service is useless.
- agent: What's not working for you right now tell me and I'll go through it with you
- caller: Do not give me that scripted rubbish. Just fix it.
- agent: I'll get what's broken on my end put right for you now.
- caller: Fine, I just want to know when you open.
- agent: I don't know the opening hours off the top of my head.

### wonder — emotion-hostile (browser-mw008jee-b0ae67f3)
- caller: This is ridiculous. Your service is useless
- agent: It's not working the way you need it to right now
- caller: Do not give me that scripted rubbish. Just fix it.
- agent: Tell me exactly what broke and I'll walk through what I can do from here
- caller: fine, I just want to know when you open
- agent: I don't have opening hours for you on this demo

### spark — emotion-skeptical (browser-mvzzwyf9-60387456)
- caller: are you a real person?
- agent: I'm Voni the voice agent you're testing live right now
- caller: That is what a bot would say
- caller: prove it
- agent: Nope I'm Voni running this demo live
- caller: fine then tell me what you can actually do
- agent: I'll show you live what I can handle on business calls. I answer calls and book jobs and follow up leads for you. Send me an email from your work address with Orbit 74 in the subject, and tell me when it's sent.

### wonder — emotion-skeptical (browser-mw00a8p5-2cf384fd)
- caller: Are you a real person?
- agent: No, I'm Voni — the voice agent on this site, running live.
- caller: That is what a bot would say.
- caller: Prove it.
- agent: Can't prove that over the phone really — I sound human but I'm software running this demo
- caller: Fine. Then tell me what you can actually do.
- agent: I can catch missed calls and handle the follow-ups live — let me show you on an actual email test instead of just talking about it. Send me an email from your work address with Cedar 22 in the subject and tell me when it's sent.

## Decision

The measurement did not prove wonder better on its own: on hostile it still
fell back to a service formula ("walk through what I can do") and a demo
disclaimer, and an earlier wonder run repeated "live demo". It did show wonder
consistently faster (final→playout 2776/1494 ms vs 3799/2730) and clearly less
scripted on skeptical ("I sound human but I'm software"). The owner chose it on
2026-11-03 ("we can use wonder"); ADR-0014 records the decision, the unchanged
guard and the v2 prices. One call per cell remains the caveat on these numbers,
not on the decision.
