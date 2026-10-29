"""The stored body's one explicit field map for the cascade (ticket 57).

The cascade reads the exact body the managed path reads, so this module is the
only place that decides which body fields become cascade settings. The map —
``FIELD_MAP`` — is the whole rule: every entry names one body path and the one
config field it produces, and ``adapt_body`` builds the config from that map
alone. A body field nobody mapped therefore cannot become a setting by
accident; the config's own constructor enforces the other direction, because a
config field without a map entry cannot be built.

The map is the spec's list and nothing more:

=====================  ===========================  ========================
body path              config field                 used for
=====================  ===========================  ========================
``system_prompt``      ``system_prompt``            the system message
``greeting``           ``greeting``                 the greeting; "" = none
``voice.voice_id``     ``voice``                    the TTS voice binding
``input.language_codes``  ``speech_language_bias``  STT ``languageBias``
``input.keyterms``     ``keyterms``                 STT ``keywords``
``tools``              ``tools``                    the model's tool array
=====================  ===========================  ========================

Two rules keep the map honest about languages and tools:

- **Languages split.** ``input.language_codes`` becomes *vendor language
  names* for speech bias, while synthesis always speaks the voice's own
  Locale. The two are not the same list: a body may bias English and Spanish
  while the bound voice speaks Spanish, and the synthesis language still comes
  from :mod:`cascade.voice_binding`, never from the body.
- **Tools are converted, not forwarded.** The body carries the Agents API REST
  shape (``name``/``description``/``parameters`` plus execution metadata);
  Chat Completions wants ``{"type": "function", "function": {…}}``. Only the
  three model-visible keys are copied, so REST-only metadata can never leak
  into a request. The parameter schema is passed through, with a missing root
  ``type`` supplied as ``"object"`` (ticket 62).

The ignore set (ticket 58) is the other half of the rule: every body field the
cascade must *not* read is listed there with the reason it is ignored, and
:func:`ignored_fields` records each one that is present, so a
recognition-carrying field such as ``input.transcription_prompt`` cannot
disappear silently. Ignored is not dropped: the record travels on the config
the call carries.

The unknown-key refusal (ticket 59) is the whitelist rule over that data: a key
at the top level, inside ``input``, ``output`` or ``voice`` that neither set
names fails by name, before any vendor socket opens. The LLM override refusal
(60) is the one-body rule's consequence: a non-empty ``llm`` array routes the
call managed, while ``llm: []`` is the documented revert.

This adapter refuses what it cannot *represent*: an unbound voice, an unknown
language code, a missing prompt, a tool name the vendor would reject. What the
body may still not be *eligible* for — automatic language detection, more
keyterms than the vendor accepts — is :mod:`cascade.eligibility`'s gate, which
turns every refusal here into a routing reason (ticket 61).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from cascade.voice_binding import LOCALES, VoiceBinding, bind_voice

# A body path that is absent, or a field name that maps to nothing.
_MISSING = object()

TOOL_FUNCTION_FIELDS = ("name", "description", "parameters")


class BodyFieldError(ValueError):
    """A mapped body field is present but cannot produce a config value."""

    def __init__(self, path: str, reason: str) -> None:
        self.path = path
        self.reason = reason
        super().__init__(f'body field "{path}": {reason}')


class UnknownLanguageCodeError(BodyFieldError):
    """A language code has no vendor language name, so no bias can be sent."""

    def __init__(self, path: str, code: str) -> None:
        self.code = code
        known = ", ".join(sorted(LOCALES))
        super().__init__(path, f'unknown language code "{code}"; the catalogue speaks {known}')


class UnknownBodyKeyError(BodyFieldError):
    """A body key is neither mapped nor deliberately ignored.

    This is the profile-whitelist rule: a smuggled key is a visible error, not a
    cascade feature, and it fails before any vendor socket opens.
    """

    def __init__(self, path: str) -> None:
        self.reason = (
            "unknown key: it is neither in the field map nor in the ignore set, "
            "so it cannot become a cascade setting"
        )
        super().__init__(path, self.reason)


class LlmOverrideRefusal(BodyFieldError):
    """The body carries a bring-your-own-model override.

    The cascade runs the managed model; replacing a tenant's model silently
    would be the one-body rule's worst failure. ``llm: []`` is the documented
    revert and is not an override, so it never reaches this refusal.
    """

    def __init__(self, models: tuple[str, ...]) -> None:
        self.models = models
        named = ", ".join(f'"{model}"' for model in models) or "an unnamed model"
        super().__init__(
            "llm",
            f"the body carries a non-empty LLM override ({named}); a tenant's "
            "bring-your-own model is never silently replaced, so this agent "
            "routes managed",
        )


class MissingSystemPromptError(BodyFieldError):
    """The body has no prompt to send as the system message.

    A compiled prompt is part of the stored body's contract; an empty one is a
    builder defect, not a valid silent agent.
    """

    def __init__(self, path: str = "system_prompt") -> None:
        super().__init__(
            path,
            "a cascade body must carry a system prompt; a missing or blank "
            "prompt is a body contract violation",
        )





@dataclass(frozen=True)
class MappedField:
    """One body path and the config field it is allowed to produce."""

    attribute: str
    parse: Callable[[str, object], object]


# The vendor's function-name rule: letters, digits, underscores and dashes,
# with at most one dot (the namespace separator). A name outside it is an HTTP
# 400 at the vendor, so the adapter refuses it instead of dropping the tool.
_TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$")


class InvalidToolNameError(BodyFieldError):
    """A tool name the vendor would reject, so the tool cannot be represented."""

    def __init__(self, path: str, name: str) -> None:
        self.name = name
        super().__init__(
            path,
            f'tool name "{name}" violates the vendor function-name rule: '
            "letters, digits, underscores and dashes, with at most one dot",
        )



def _text(path: str, value: object) -> str:
    """A body string; absent means the empty string."""
    if value is _MISSING or value is None:
        return ""
    if not isinstance(value, str):
        raise BodyFieldError(path, f"expected a string, got {type(value).__name__}")
    return value


def _system_prompt(path: str, value: object) -> str:
    """The compiled prompt; a missing or blank one is a contract violation."""
    if value is _MISSING or value is None:
        raise MissingSystemPromptError(path)
    if not isinstance(value, str):
        raise BodyFieldError(path, f"expected a string, got {type(value).__name__}")
    if not value.strip():
        raise MissingSystemPromptError(path)
    return value


def _voice(path: str, value: object) -> VoiceBinding:
    """The voice's binding, from the one binding table."""
    if value is _MISSING or value is None:
        raise BodyFieldError(path, "a cascade body must name a voice")
    if not isinstance(value, str) or not value:
        raise BodyFieldError(path, f"expected a voice id, got {value!r}")
    return bind_voice(value)


def _string_list(path: str, value: object) -> tuple[str, ...]:
    """A body list of strings; absent means the empty tuple."""
    if value is _MISSING or value is None:
        return ()
    if not isinstance(value, (list, tuple)):
        raise BodyFieldError(path, f"expected a list, got {type(value).__name__}")
    for item in value:
        if not isinstance(item, str):
            raise BodyFieldError(path, f"expected a string, got {item!r}")
    return tuple(value)


def _language_bias(path: str, value: object) -> tuple[str, ...]:
    """Our language codes as the vendor language names STT biases toward."""
    names: list[str] = []
    for code in _string_list(path, value):
        locale = LOCALES.get(code)
        if locale is None:
            raise UnknownLanguageCodeError(path, code)
        names.append(locale.language)
    return tuple(names)


def _function_tool(path: str, index: int, tool: object) -> dict[str, Any]:
    """One REST tool as a Chat Completions function tool.

    Only the model-visible keys are copied; ``execution_mode``,
    ``timeout_seconds``, ``response_instructions`` and ``http`` stay with the
    tool loop (M08), which reads them from the body. Name validity is an
    eligibility question (ticket 61), not a conversion one.

    The parameters schema is passed through untouched except for one addition:
    a schema without a root ``type`` gets ``"type": "object"`` here, because a
    cascade must not rely on the vendor to repair a request. A tool with no
    schema at all carries none — nothing is invented.
    """
    where = f"{path}[{index}]"
    if not isinstance(tool, Mapping):
        raise BodyFieldError(where, f"expected a tool object, got {type(tool).__name__}")
    name = tool.get("name")
    if not isinstance(name, str) or not name:
        raise BodyFieldError(f"{where}.name", "a tool must have a name")
    if not _TOOL_NAME.match(name):
        raise InvalidToolNameError(f"{where}.name", name)
    function: dict[str, Any] = {
        key: tool[key] for key in TOOL_FUNCTION_FIELDS if key in tool
    }
    if "parameters" in function:
        parameters = function["parameters"]
        if not isinstance(parameters, Mapping):
            raise BodyFieldError(
                f"{where}.parameters",
                f"expected a parameters schema object, got {type(parameters).__name__}",
            )
        if "type" not in parameters:
            function["parameters"] = {"type": "object", **parameters}
    return {"type": "function", "function": function}


def _tools(path: str, value: object) -> tuple[dict[str, Any], ...]:
    """The body's REST tools as the model's function array."""
    if value is _MISSING or value is None:
        return ()
    if not isinstance(value, (list, tuple)):
        raise BodyFieldError(path, f"expected a list of tools, got {type(value).__name__}")
    return tuple(_function_tool(path, index, tool) for index, tool in enumerate(value))


FIELD_MAP: Mapping[str, MappedField] = MappingProxyType(
    {
        # The prompt's own map: sent unchanged as the system message.
        "system_prompt": MappedField("system_prompt", _system_prompt),
        # Absent or empty means the call opens silently.
        "greeting": MappedField("greeting", _text),
        # The voice, and through it the one Locale synthesis speaks.
        "voice.voice_id": MappedField("voice", _voice),
        # STT bias only: synthesis keeps the voice's Locale.
        "input.language_codes": MappedField("speech_language_bias", _language_bias),
        # Recognition vocabulary, sent as STT keywords.
        "input.keyterms": MappedField("keyterms", _string_list),
        # Converted to the Chat Completions function shape, never forwarded.
        "tools": MappedField("tools", _tools),
    }
)


# The spec's ignore set, verbatim: every body field the cascade must not read,
# each with the reason it is ignored (spec "Ignore set, each with a reason").
# This is data on purpose — extending it is one edit here, never a conditional
# somewhere in the adapter.
IGNORE_SET: Mapping[str, str] = MappingProxyType(
    {
        # A label the stored body carries; it never influences a call.
        "name": "a call label the platform stores, not behaviour",
        # Managed-only gain stage; the cascade has no equivalent.
        "output.volume": (
            "managed-only; direct synthesis has no volume parameter and the "
            "cascade carries no gain stage"
        ),
        # Redundant with the mapped voice id.
        "output.voice": "redundant with voice.voice_id, which the map already reads",
        # The transport owns both directions' formats.
        "output.format": "the transport chooses the output format, not the body",
        "input.format": "the transport chooses the input format, not the body",
        # Meta's recognition mode is fixed; there is no knob to set.
        "input.transcription_mode": (
            "Meta's recognition mode is fixed at ENDPOINTING; there is no "
            "equivalent knob"
        ),
        # Recognition words that must be represented in keyterms before cutover.
        "input.transcription_prompt": (
            "Meta exposes no free-form recognition prompt; the words it carries "
            "must be represented in keyterms before cutover, so the field is "
            "recorded as ignored for the pre-cutover recognition check"
        ),
        # The browser mic path already owns capture.
        "input.voice_focus": (
            "no Meta equivalent; the browser microphone path already owns capture"
        ),
        "input.voice_focus_threshold": (
            "no Meta equivalent; the browser microphone path already owns capture"
        ),
        # The provider owns the turn boundary.
        "input.turn_detection": (
            "the provider owns the turn boundary; there is no turn-detection "
            "object to set"
        ),
    }
)


@dataclass(frozen=True)
class IgnoredField:
    """One body field the cascade deliberately does not read, and why.

    ``value`` is the field's value as served. It exists so a recorded ignore is
    inspectable — the pre-cutover recognition check has to read the words a
    ``transcription_prompt`` carried, not just note that it was there.
    """

    path: str
    reason: str
    value: Any



def _read(body: Mapping[str, Any], path: str) -> object:
    """The value at a dotted body path, or ``_MISSING``."""
    node: object = body
    for key in path.split("."):
        if not isinstance(node, Mapping) or key not in node:
            return _MISSING
        node = node[key]
    return node


def ignored_fields(body: Mapping[str, Any]) -> tuple[IgnoredField, ...]:
    """Every ignored field the body actually carries, with its reason."""
    if not isinstance(body, Mapping):
        raise TypeError(f"a stored agent body must be a mapping, got {type(body).__name__}")
    recorded: list[IgnoredField] = []
    for path in sorted(IGNORE_SET):
        value = _read(body, path)
        if value is not _MISSING:
            recorded.append(IgnoredField(path, IGNORE_SET[path], value))
    return tuple(recorded)


def _allowed_children() -> Mapping[str, frozenset[str]]:
    """The keys each checked body section may carry, derived from the two sets.

    Derived per call, so extending either set is the whole change: a module
    constant computed at import would go stale the moment a set grows.
    ``llm`` is the one top-level key that is neither mapped nor ignored: it is
    a documented refusal (ticket 60), so it must reach the adapter to be
    refused by name rather than as an unknown key.
    """
    allowed: dict[str, set[str]] = {"": {"llm"}, "voice": set()}
    for path in (*FIELD_MAP, *IGNORE_SET):
        parts = path.split(".")
        for depth, key in enumerate(parts):
            parent = ".".join(parts[:depth])
            allowed.setdefault(parent, set()).add(key)
    return MappingProxyType({parent: frozenset(keys) for parent, keys in allowed.items()})


# The sections whose keys are a closed set. A key in any other object is the
# object's own business (a tool's parameters schema, an LLM override's body).
CHECKED_SECTIONS = ("", "input", "output", "voice")


def _reject_unknown_keys(body: Mapping[str, Any]) -> None:
    """Refuse any key in a checked section that neither set names."""
    allowed_keys = _allowed_children()
    for section in CHECKED_SECTIONS:
        node = body if not section else body.get(section, _MISSING)
        if node is _MISSING:
            continue
        if not isinstance(node, Mapping):
            raise BodyFieldError(section, f"expected an object, got {type(node).__name__}")
        allowed = allowed_keys.get(section, frozenset())
        for key in node:
            if key not in allowed:
                raise UnknownBodyKeyError(f"{section}.{key}" if section else str(key))


def _reject_llm_override(body: Mapping[str, Any]) -> None:
    """Refuse a non-empty ``llm`` array; ``[]`` is the documented revert."""
    value = body.get("llm", _MISSING)
    if value is _MISSING or value is None:
        return
    if not isinstance(value, (list, tuple)):
        raise BodyFieldError(
            "llm", f"expected a list of model overrides, got {type(value).__name__}"
        )
    if not value:
        return
    models = tuple(
        str(entry.get("model", "")) if isinstance(entry, Mapping) else repr(entry)
        for entry in value
    )
    raise LlmOverrideRefusal(models)



@dataclass(frozen=True)
class CascadeBody:
    """What the cascade reads out of a stored body — no more, no less."""

    system_prompt: str
    greeting: str
    # The binding, not the id: the table already fixed the Locale.
    voice: VoiceBinding
    # Vendor language names for the STT languageBias list.
    speech_language_bias: tuple[str, ...]
    keyterms: tuple[str, ...]
    # Chat Completions shape, ready for LLMStream.complete(tools=...).
    tools: tuple[dict[str, Any], ...]
    # Every ignored field the served body carried, with its reason. Not a
    # setting: the record exists so an ignored field is visible on the call.
    ignored: tuple[IgnoredField, ...]

    @property
    def voice_id(self) -> str:
        return self.voice.voice_id

    @property
    def language_code(self) -> str:
        """Our two-letter code for the binding's Locale."""
        return self.voice.locale.code

    @property
    def synthesis_language(self) -> str:
        """The vendor language name a synthesis request sends."""
        return self.voice.locale.language

    @property
    def has_greeting(self) -> bool:
        return bool(self.greeting)


def adapt_body(body: Mapping[str, Any]) -> CascadeBody:
    """Read a stored agent body through ``FIELD_MAP`` and nothing else."""
    if not isinstance(body, Mapping):
        raise TypeError(f"a stored agent body must be a mapping, got {type(body).__name__}")
    _reject_unknown_keys(body)
    _reject_llm_override(body)
    produced = {
        field.attribute: field.parse(path, _read(body, path))
        for path, field in FIELD_MAP.items()
    }
    return CascadeBody(**produced, ignored=ignored_fields(body))
