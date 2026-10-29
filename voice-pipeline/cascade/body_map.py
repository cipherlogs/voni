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
  into a request.

The ignore set (ticket 58), the unknown-key refusal (ticket 59), the LLM
override refusal (60) and the eligibility refusals (61) are not this module's
job yet: this map is what they check against.
"""

from __future__ import annotations

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


@dataclass(frozen=True)
class MappedField:
    """One body path and the config field it is allowed to produce."""

    attribute: str
    parse: Callable[[str, object], object]


def _text(path: str, value: object) -> str:
    """A body string; absent means the empty string."""
    if value is _MISSING or value is None:
        return ""
    if not isinstance(value, str):
        raise BodyFieldError(path, f"expected a string, got {type(value).__name__}")
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
    """
    where = f"{path}[{index}]"
    if not isinstance(tool, Mapping):
        raise BodyFieldError(where, f"expected a tool object, got {type(tool).__name__}")
    name = tool.get("name")
    if not isinstance(name, str) or not name:
        raise BodyFieldError(f"{where}.name", "a tool must have a name")
    return {
        "type": "function",
        "function": {key: tool[key] for key in TOOL_FUNCTION_FIELDS if key in tool},
    }


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
        "system_prompt": MappedField("system_prompt", _text),
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


def _read(body: Mapping[str, Any], path: str) -> object:
    """The value at a dotted body path, or ``_MISSING``."""
    node: object = body
    for key in path.split("."):
        if not isinstance(node, Mapping) or key not in node:
            return _MISSING
        node = node[key]
    return node


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
    produced = {
        field.attribute: field.parse(path, _read(body, path))
        for path, field in FIELD_MAP.items()
    }
    return CascadeBody(**produced)
