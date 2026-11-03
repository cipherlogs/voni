"""Standard-only guard for Meta model ids, plus the one demo override gate.

Contributor tier permits Meta to train its models on request content. A cascade
request carries a caller's name, budget, financing and phone number, so a
Contributor id must never reach a request builder. The guard runs eagerly when
the LLM backend is constructed, before any request is built, and reports the
model id and the reason instead of failing later as a vendor surprise.

``muse-wonder-1.0`` is a Standard model that is reachable on the same Meta key,
but the demo's default rung is Spark. It is therefore *not* a Standard rung
model: :func:`assert_standard_model` and :func:`resolve_model` keep refusing it.
Only an explicit stored-body override (:func:`assert_override_model`) may name
it, which is what the demo-only ``DEMO_LLM_MODEL`` path builds. Contributor ids
are refused on that path too, because the privacy premise does not change with
the model.
"""

from __future__ import annotations

CONTRIBUTOR_MARKER = "-contributor"

#: The models the default (no-override) rung may serve.
STANDARD_MODELS: tuple[str, ...] = ("muse-spark-1.3",)

#: The Meta models an explicit stored-body override may name. This is a
#: superset of the Standard rung, never the default: a call only reaches it when
#: the signed body carried the entry.
OVERRIDE_MODELS: tuple[str, ...] = ("muse-spark-1.3", "muse-wonder-1.0")

DEFAULT_MODEL = "muse-spark-1.3"


class ModelGuardError(ValueError):
    """A model id the cascade refuses to construct a client for."""


def _assert_not_contributor(model_id: str, *, allowed: tuple[str, ...]) -> None:
    if CONTRIBUTOR_MARKER in model_id.lower():
        raise ModelGuardError(
            f"model {model_id!r} is a Contributor-tier model: Contributor "
            "trains Meta models on the content we send, and the cascade sends "
            "caller names, budgets, financing and phone numbers; only Standard "
            f"models are allowed ({', '.join(allowed)})"
        )


def assert_standard_model(model_id: str) -> str:
    if not isinstance(model_id, str) or not model_id:
        raise ModelGuardError(
            f"model {model_id!r} is not a usable model id: expected one of the "
            f"Standard models ({', '.join(STANDARD_MODELS)})"
        )
    _assert_not_contributor(model_id, allowed=STANDARD_MODELS)
    if model_id not in STANDARD_MODELS:
        raise ModelGuardError(
            f"model {model_id!r} is not a Standard model: the cascade only "
            f"constructs Standard models ({', '.join(STANDARD_MODELS)}); "
            "an unlisted id is refused by name rather than sent to the vendor"
        )
    return model_id


def resolve_model(model_id: str | None = None) -> str:
    return assert_standard_model(model_id or DEFAULT_MODEL)


def assert_override_model(model_id: str) -> str:
    """Allow a model only when the signed body explicitly named it.

    This is the *override* gate, never a fallback: the default rung calls
    :func:`resolve_model` and still refuses ``muse-wonder-1.0``. The caller must
    be the explicit body path (``build_byo_client`` / a non-Standard
    ``MetaLLM``), which is why this function's name is the whole contract.
    """
    if not isinstance(model_id, str) or not model_id:
        raise ModelGuardError(
            f"model {model_id!r} is not a usable model id: expected an explicit "
            f"override model ({', '.join(OVERRIDE_MODELS)})"
        )
    _assert_not_contributor(model_id, allowed=OVERRIDE_MODELS)
    if model_id not in OVERRIDE_MODELS:
        raise ModelGuardError(
            f"model {model_id!r} is not an allowed Meta override: an explicit "
            f"stored-body entry may name only {', '.join(OVERRIDE_MODELS)}; "
            "any other id is refused by name rather than sent to the vendor"
        )
    return model_id
