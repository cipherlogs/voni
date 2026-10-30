"""The one validator for a stored body's model override (ticket 159).

Three call sites have to answer the same question — *can this override build a
client?* — and each must answer it the same way:

* the body adapter (:mod:`cascade.body_map`) reads the served entry;
* the client builder (:func:`cascade.meta_llm.build_byo_client`) constructs a
  client server-side;
* :class:`cascade.meta_llm.MetaLLM`'s own constructor accepts the same values
  directly.

Before this module each one re-derived ``base_url``/``model``/``api_key`` and
the optional ``reasoning_effort``, so a rule could be tightened in one place and
forgotten in another. The rules now live here once, and each caller keeps its
own named refusal: the adapter raises
:class:`~cascade.body_map.MissingLlmOverrideFieldError` /
:class:`~cascade.body_map.LlmOverrideError` and the client raises
:class:`~cascade.meta_llm.ByoLlmError`.

Nothing here echoes a value: one of these fields is a credential.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

#: The keys a stored provider entry may carry, and the subset it must carry.
OVERRIDE_FIELDS = ("base_url", "model", "api_key", "reasoning_effort")
REQUIRED_OVERRIDE_FIELDS = ("base_url", "model", "api_key")

_HTTP_SCHEMES = ("http", "https")


@dataclass(frozen=True)
class LlmOverride:
    """One stored provider entry, server-side only.

    ``api_key`` is a deployment credential: it is excluded from the
    representation and from :meth:`to_document`, so it can reach the vendor's
    authorization header and nothing else. The body is signed, so the key is
    read from the signed body rather than from a browser frame.
    """

    base_url: str
    model: str
    api_key: str = field(repr=False)
    reasoning_effort: str | None = None

    def to_document(self) -> dict[str, str | None]:
        """The artifact-safe shape: the key is never part of a document."""
        return {
            "base_url": self.base_url,
            "model": self.model,
            "reasoning_effort": self.reasoning_effort,
        }


class LlmOverrideInvalid(ValueError):
    """One override field cannot build a request.

    ``field`` names the offending key and ``missing`` separates "absent or
    blank" from "present but unusable", so a caller can keep its own named
    refusal without asking the rule twice. The value is never echoed.
    """

    def __init__(self, field_name: str, reason: str, *, missing: bool = False) -> None:
        self.field = field_name
        self.reason = reason
        self.missing = missing
        super().__init__(f'"{field_name}": {reason}')


def validate_override(
    *,
    base_url: Any,
    model: Any,
    api_key: Any,
    reasoning_effort: Any = None,
) -> LlmOverride:
    """Normalise an override's four values, or refuse the field that fails.

    The required fields are stripped; an absent effort stays ``None`` and an
    empty one is treated as absent. A base URL without an absolute http(s)
    scheme is refused here, because no request can be built from it. Every
    refusal is a :class:`LlmOverrideInvalid` naming ``field`` and never the
    value.
    """
    values = {
        "base_url": base_url,
        "model": model,
        "api_key": api_key,
    }
    normalised: dict[str, str] = {}
    for name in REQUIRED_OVERRIDE_FIELDS:
        raw = values[name]
        if raw is None or not isinstance(raw, str) or not raw.strip():
            raise LlmOverrideInvalid(
                name,
                "is missing or empty; base_url, model and api_key are all "
                "required to build a client",
                missing=True,
            )
        normalised[name] = raw.strip()

    if urlsplit(normalised["base_url"]).scheme not in _HTTP_SCHEMES:
        raise LlmOverrideInvalid(
            "base_url",
            f'the base URL "{normalised["base_url"]}" is not an absolute '
            "http(s) URL, so no request can be built from it",
        )

    effort: str | None
    if reasoning_effort is None:
        effort = None
    elif not isinstance(reasoning_effort, str):
        raise LlmOverrideInvalid(
            "reasoning_effort",
            f"expected a string, got {type(reasoning_effort).__name__}",
        )
    else:
        effort = reasoning_effort.strip() or None

    return LlmOverride(
        base_url=normalised["base_url"],
        model=normalised["model"],
        api_key=normalised["api_key"],
        reasoning_effort=effort,
    )


__all__ = [
    "OVERRIDE_FIELDS",
    "REQUIRED_OVERRIDE_FIELDS",
    "LlmOverride",
    "LlmOverrideInvalid",
    "validate_override",
]
