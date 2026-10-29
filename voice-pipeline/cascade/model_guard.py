"""Standard-only guard for Meta Spark model ids.

Contributor tier permits Meta to train its models on request content. A cascade
request carries a caller's name, budget, financing and phone number, so a
Contributor id must never reach a request builder. The guard runs eagerly when
the LLM backend is constructed, before any request is built, and reports the
model id and the reason instead of failing later as a vendor surprise.
"""

from __future__ import annotations

CONTRIBUTOR_MARKER = "-contributor"

STANDARD_MODELS: tuple[str, ...] = ("muse-spark-1.3",)

DEFAULT_MODEL = "muse-spark-1.3"


class ModelGuardError(ValueError):
    """A model id the cascade refuses to construct a client for."""


def assert_standard_model(model_id: str) -> str:
    if not isinstance(model_id, str) or not model_id:
        raise ModelGuardError(
            f"model {model_id!r} is not a usable model id: expected one of the "
            f"Standard models ({', '.join(STANDARD_MODELS)})"
        )
    if CONTRIBUTOR_MARKER in model_id.lower():
        raise ModelGuardError(
            f"model {model_id!r} is a Contributor-tier model: Contributor "
            "trains Meta models on the content we send, and the cascade sends "
            "caller names, budgets, financing and phone numbers; only Standard "
            f"models are allowed ({', '.join(STANDARD_MODELS)})"
        )
    if model_id not in STANDARD_MODELS:
        raise ModelGuardError(
            f"model {model_id!r} is not a Standard model: the cascade only "
            f"constructs Standard models ({', '.join(STANDARD_MODELS)}); "
            "an unlisted id is refused by name rather than sent to the vendor"
        )
    return model_id


def resolve_model(model_id: str | None = None) -> str:
    return assert_standard_model(model_id or DEFAULT_MODEL)
