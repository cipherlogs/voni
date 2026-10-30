"""Eligibility: whether a new call may cascade, and why not (tickets 25, 61).

Eligibility is a conjunction, not a guess. A new call goes cascade only when
routing permits it, the body adapter accepts the body, the voice has a cascade
binding, any model override is constructible, and the daily counter is below
its routing line. Every refusal records its own reason and routes the call
managed.

A body with no fixed ``language_codes`` is not refused (ticket 160): speech
recognition runs Meta auto-detect, while synthesis still speaks the bound
voice's one Locale. The decision records ``auto_detect`` as a fact, so the
artifact can tell an auto-detect subject from a fixed-Locale one. An unbound
voice is still refused by name.

Refusal is a routing fact, never a provider fallback event: the reasons travel
as eligibility facts on the decision, and nothing here can emit a
``provider_fallback`` event. Nothing here opens a socket, reads a store, retries
or sleeps — the routing snapshot and the counter reading arrive as inputs, so
the whole gate is pure and testable without a live call.

The rules are data (:data:`DEFAULT_RULES`), and each rule is one predicate over
:class:`EligibilityFacts`. A rule that fails records its own named reason, and
identical reasons from two rules are recorded once, under the earlier rule.
:func:`evaluate_body` runs only the body half (:data:`BODY_RULES`) for callers
that have not read the switch yet; :func:`evaluate_eligibility` is the one
conjunction a new call uses.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from cascade.body_map import (
    BodyFieldError,
    CascadeBody,
    adapt_body,
    read_llm_override,
)
from cascade.routing import CallSubject, Disposition, RoutingDecision
from cascade.voice_binding import VoiceBindingError

#: The one event type a refusal emits. A provider fallback is a different fact
#: and a different event; eligibility never emits one.
REFUSAL_EVENT_TYPE = "eligibility_refusal"


@dataclass(frozen=True)
class Refusal:
    """One failing predicate: the rule's name and the reason it refused."""

    predicate: str
    reason: str


@dataclass(frozen=True)
class CounterReading:
    """What the durable daily counter says before a new call.

    ``line_usd`` is the routing line ticket 103 computes from the daily cap; the
    cap itself is an open value, so this module receives the line and never
    derives one. The call may cascade only while spending is strictly below the
    line.
    """

    spent_usd: float
    line_usd: float

    def __post_init__(self) -> None:
        for name, value in (("spent_usd", self.spent_usd), ("line_usd", self.line_usd)):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{name} must be a number, got {value!r}")
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and non-negative, got {value!r}")

    @property
    def below_line(self) -> bool:
        """Whether a new call may still cascade."""
        return self.spent_usd < self.line_usd


@dataclass(frozen=True)
class EligibilityFacts:
    """Everything the rules read; computed once per call."""

    body: Mapping[str, Any]
    #: The vendor's keyword limit, injected (the registry owns the number).
    keyterm_limit: int
    #: The adapted config, or ``None`` when the adapter refused the body.
    config: CascadeBody | None
    #: The adapter's refusal, if it refused.
    body_error: BodyFieldError | VoiceBindingError | None
    #: The subject of the call and the routing snapshot it carries. Present for
    #: the full conjunction; ``evaluate_body`` runs the body rules without them.
    subject: CallSubject | None = None
    routing: RoutingDecision | None = None
    counter: CounterReading | None = None


@dataclass(frozen=True)
class Rule:
    """One predicate of the eligibility conjunction."""

    name: str
    reason: Callable[[EligibilityFacts], str]


@dataclass(frozen=True)
class EligibilityDecision:
    """The eligibility verdict for one body: managed with reasons, or cascade."""

    disposition: Disposition
    reasons: tuple[Refusal, ...]
    body: CascadeBody | None
    #: True when the body fixed no language and recognition auto-detects.
    #: Recorded on refusals too, so the fact never depends on the verdict.
    auto_detect: bool = False
    subject: CallSubject | None = None
    routing: RoutingDecision | None = None
    counter: CounterReading | None = None

    def __post_init__(self) -> None:
        if self.disposition not in ("cascade", "managed"):
            raise ValueError(f"unknown eligibility disposition {self.disposition!r}")
        if self.disposition == "cascade" and self.reasons:
            raise ValueError("an eligible body cannot carry a refusal reason")
        if self.disposition == "managed" and not self.reasons:
            raise ValueError("a refused body must name the reason it refused")

    @property
    def permitted(self) -> bool:
        """Whether the call may cascade."""
        return self.disposition == "cascade"

    @property
    def reason(self) -> str:
        """Every refusal reason, joined for the routing decision's one field."""
        return "; ".join(refusal.reason for refusal in self.reasons)

    @property
    def predicates(self) -> tuple[str, ...]:
        """The names of the predicates that refused, in conjunction order."""
        return tuple(refusal.predicate for refusal in self.reasons)

    def events(self) -> tuple[dict[str, str], ...]:
        """The eligibility facts the end message carries; never a fallback."""
        return tuple(
            {
                "type": REFUSAL_EVENT_TYPE,
                "predicate": refusal.predicate,
                "reason": refusal.reason,
            }
            for refusal in self.reasons
        )


def _auto_detect(body: Mapping[str, Any]) -> bool:
    """Whether the body fixes no language, so recognition auto-detects.

    Read from the raw body because a refused body has no adapted config; the
    fact is the subject's, not the verdict's. A malformed list is not
    auto-detect — it has its own named refusal in the adapter.
    """
    section = body.get("input")
    if not isinstance(section, Mapping):
        return True
    codes = section.get("language_codes")
    if codes is None:
        return True
    if not isinstance(codes, (list, tuple)):
        return False
    return not codes


def _routing_reason(facts: EligibilityFacts) -> str:
    """Routing must permit the call; its own refusal wins and is already named."""
    routing = facts.routing
    if routing is None or routing.permitted:
        return ""
    return routing.reason or "routing did not permit this call to cascade"


def _binding_reason(facts: EligibilityFacts) -> str:
    """The voice must have a cascade binding; the adapter's refusal names it."""
    error = facts.body_error
    if isinstance(error, VoiceBindingError):
        return str(error)
    return ""


def _accepted_reason(facts: EligibilityFacts) -> str:
    """The adapter must accept the body, and the keyterms must fit the vendor."""
    error = facts.body_error
    if error is not None:
        return str(error)
    config = facts.config
    if config is None:  # pragma: no cover - adapt_body either returns or raises
        return "the body adapter produced no config"
    over = len(config.keyterms) - facts.keyterm_limit
    if over > 0:
        return (
            f"the body carries {len(config.keyterms)} keyterms, over the vendor "
            f"keyword limit of {facts.keyterm_limit}; refusing rather than "
            "truncating or dropping any"
        )
    return ""


def _llm_reason(facts: EligibilityFacts) -> str:
    """A body's model override is eligible when it is constructible (ticket 159).

    The refusal ticket 60 recorded is gone: a tenant's own provider now runs the
    cascade. What is still checked is whether the entry can become a client —
    one entry, with a base URL, a model and a key — by name, before a socket.
    """
    try:
        read_llm_override(facts.body)
    except BodyFieldError as error:
        return str(error)
    return ""


#: The body half of the conjunction, in evaluation order. Binding comes before
#: acceptance so a voice with no binding is named as the binding refusal. There
#: is deliberately no locale refusal: a body with no fixed language is
#: auto-detect, and its synthesis language still comes from the binding.
BODY_RULES: tuple[Rule, ...] = (
    Rule("binding", _binding_reason),
    Rule("llm", _llm_reason),
    Rule("accepted", _accepted_reason),
)


def _counter_reason(facts: EligibilityFacts) -> str:
    """The daily counter must sit strictly below its routing line."""
    counter = facts.counter
    if counter is None or counter.below_line:
        return ""
    return (
        f"the daily counter is at ${counter.spent_usd:.2f} of its "
        f"${counter.line_usd:.2f} routing line; new calls route managed"
    )


#: The eligibility conjunction: routing permits, the body adapter accepts, the
#: voice binds, the override is constructible and the counter is below its
#: line. Every rule is injected, so removing one is a test of whether it is
#: read. Language detection is a fact (``auto_detect``), not a predicate.
DEFAULT_RULES: tuple[Rule, ...] = (
    Rule("routing", _routing_reason),
    *BODY_RULES,
    Rule("counter", _counter_reason),
)


def _checked_limit(keyterm_limit: object) -> int:
    if isinstance(keyterm_limit, bool) or not isinstance(keyterm_limit, int):
        raise ValueError(
            f"keyterm_limit must be an int, got {keyterm_limit!r}; the vendor's "
            "keyword limit is an input, never guessed"
        )
    if keyterm_limit < 0:
        raise ValueError(f"keyterm_limit cannot be negative, got {keyterm_limit!r}")
    return keyterm_limit


def _adapt(
    body: Mapping[str, Any],
) -> tuple[CascadeBody | None, BodyFieldError | VoiceBindingError | None]:
    try:
        return adapt_body(body), None
    except (BodyFieldError, VoiceBindingError) as error:
        return None, error


def _run(
    facts: EligibilityFacts, rules: Sequence[Rule]
) -> tuple[Refusal, ...]:
    reasons: list[Refusal] = []
    seen: set[str] = set()
    for rule in rules:
        reason = rule.reason(facts)
        if not reason or reason in seen:
            continue
        seen.add(reason)
        reasons.append(Refusal(rule.name, reason))
    return tuple(reasons)


def evaluate_body(
    body: Mapping[str, Any],
    *,
    keyterm_limit: int,
    rules: Sequence[Rule] = BODY_RULES,
) -> EligibilityDecision:
    """Decide whether the cascade can represent ``body``, and why not.

    ``keyterm_limit`` is injected: the vendor's keyword cap is a declared
    threshold (ticket 04 owns the value), not a number this module may invent.
    """
    if not isinstance(body, Mapping):
        raise TypeError(f"a stored agent body must be a mapping, got {type(body).__name__}")
    limit = _checked_limit(keyterm_limit)
    config, error = _adapt(body)
    facts = EligibilityFacts(
        body=body, keyterm_limit=limit, config=config, body_error=error
    )
    reasons = _run(facts, rules)
    return EligibilityDecision(
        disposition="managed" if reasons else "cascade",
        reasons=reasons,
        body=config,
        auto_detect=_auto_detect(body),
    )


def evaluate_eligibility(
    body: Mapping[str, Any],
    *,
    subject: CallSubject,
    routing: RoutingDecision,
    counter: CounterReading,
    keyterm_limit: int,
    rules: Sequence[Rule] = DEFAULT_RULES,
) -> EligibilityDecision:
    """The one eligibility conjunction for a new call.

    Pure over its five inputs: the routing snapshot (already read from the
    durable switch), the counter reading (already read from the daily counter),
    the body, the subject and the vendor keyword limit. A refusal routes the
    call managed and every failing predicate records its own reason; nothing
    here emits a provider fallback event, opens a socket or writes a store.
    """
    if not isinstance(body, Mapping):
        raise TypeError(f"a stored agent body must be a mapping, got {type(body).__name__}")
    if not isinstance(subject, CallSubject):
        raise ValueError(f"subject must be a CallSubject, got {subject!r}")
    if not isinstance(routing, RoutingDecision):
        raise ValueError(f"routing must be a RoutingDecision, got {routing!r}")
    if not isinstance(counter, CounterReading):
        raise ValueError(f"counter must be a CounterReading, got {counter!r}")
    limit = _checked_limit(keyterm_limit)
    config, error = _adapt(body)
    facts = EligibilityFacts(
        body=body,
        keyterm_limit=limit,
        config=config,
        body_error=error,
        subject=subject,
        routing=routing,
        counter=counter,
    )
    reasons = _run(facts, rules)
    return EligibilityDecision(
        disposition="managed" if reasons else "cascade",
        reasons=reasons,
        body=config,
        auto_detect=_auto_detect(body),
        subject=subject,
        routing=routing,
        counter=counter,
    )
