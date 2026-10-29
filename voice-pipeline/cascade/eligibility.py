"""Body eligibility: can the cascade represent this stored body? (ticket 61)

One pure function answers with a disposition and, when refused, the reason.
The body half of the conjunction lives here; ticket 25 adds routing, the voice
binding predicate's routing context and the daily counter to make the single
eligibility decision.

Refusal is a routing fact, never a provider fallback event: a refused body
routes the call managed and the reason travels with it. Nothing in this module
opens a socket, reads a store, retries or sleeps, so the whole gate is testable
without a live call.

The rules are data (:data:`BODY_RULES`), and each rule is one predicate over
:class:`EligibilityFacts`. A rule that fails records its own named reason, and
identical reasons from two rules are recorded once, under the earlier rule.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from cascade.body_map import BodyFieldError, CascadeBody, adapt_body
from cascade.routing import Disposition
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
class EligibilityFacts:
    """Everything the body rules read; computed once per call."""

    body: Mapping[str, Any]
    #: The vendor's keyword limit, injected (the registry owns the number).
    keyterm_limit: int
    #: The adapted config, or ``None`` when the adapter refused the body.
    config: CascadeBody | None
    #: The adapter's refusal, if it refused.
    body_error: BodyFieldError | VoiceBindingError | None


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


def _language_codes(body: Mapping[str, Any]) -> tuple[str, ...]:
    """The body's fixed-language list, for the locale predicate only.

    Read from the raw body because the adapter, correctly, leaves an absent
    list as an empty bias; whether that empty bias is *eligible* is this gate's
    question, not the adapter's.
    """
    section = body.get("input")
    if not isinstance(section, Mapping):
        return ()
    codes = section.get("language_codes")
    if not isinstance(codes, (list, tuple)):
        return ()
    return tuple(codes)


def _locale_reason(facts: EligibilityFacts) -> str:
    """Automatic language detection is not eligible on this slice."""
    if _language_codes(facts.body):
        return ""
    return (
        "the body fixes no language (input.language_codes is absent or empty): "
        "automatic language detection is not eligible, because the TTS "
        "session's language is fixed at connect and the voice binding needs "
        "one Locale"
    )


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


#: The body half of the conjunction, in evaluation order. Binding comes before
#: acceptance so a voice with no binding is named as the binding refusal.
BODY_RULES: tuple[Rule, ...] = (
    Rule("binding", _binding_reason),
    Rule("locale", _locale_reason),
    Rule("accepted", _accepted_reason),
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
    )
