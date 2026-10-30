"""Voice binding: the only authority for a synthesis language.

One voice speaks exactly one Locale, and the Locale owns the vendor's language
name (``"English"``, ``"Spanish"``, …) — never our two-letter code. The table is
the single source of a synthesis language: :func:`bind_voice` returns the
binding, and a request field that disagrees is refused instead of followed, so
no caller input can mix languages.

A voice that is absent is refused by name. A voice the catalogue offers but the
vendor does not serve (``juergen``/de, ``422 voice_not_found``) is kept as a
named *unbound historical* row: refused by name too, with its Locale recorded,
so it can never become a silent fallback. German is bound to the re-cast voice
``jorg`` (ticket 130); neither the bound nor the historical row is a second
catalogue.

Catalogue source: ``voni/src/lib/agents/voices.ts`` and the measured evidence in
``voni/evidence/voice-levels/levels.json``; the tests compare this table with
both files so drift is visible.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType

# The vendor's language names, as the AssemblyAI catalogue declares them for the
# six languages it can speak. Keyed by our code so a Locale can never invent a
# vendor name.
SPEECH_LANGUAGES: Mapping[str, str] = MappingProxyType(
    {
        "en": "English",
        "es": "Spanish",
        "fr": "French",
        "de": "German",
        "it": "Italian",
        "pt": "Portuguese",
    }
)

#: The vendor's library id is the catalogue id with this prefix: the app stores
#: the bare id (`jorg`), and the synthesis endpoint serves `aai-jorg` (the same
#: mapping `voni/scripts/measure-voice-levels.mts` sends).
VENDOR_VOICE_ID_PREFIX = "aai-"


def vendor_voice_id(voice_id: str) -> str:
    """The vendor's id for a catalogue voice, prefixed exactly once."""
    if voice_id.startswith(VENDOR_VOICE_ID_PREFIX):
        return voice_id
    return f"{VENDOR_VOICE_ID_PREFIX}{voice_id}"


class VoiceBindingError(LookupError):
    """A requested voice cannot be bound, so it is not a cascade subject."""

    voice_id: str


class UnknownVoiceError(VoiceBindingError):
    """The voice is not in the table at all."""

    def __init__(self, voice_id: str) -> None:
        self.voice_id = voice_id
        super().__init__(f'unknown voice "{voice_id}": not in the voice binding table')


class UnboundVoiceError(VoiceBindingError):
    """The voice carries no binding; the refusal names its Locale and reason."""

    def __init__(self, voice_id: str, locale: Locale | None, reason: str) -> None:
        self.voice_id = voice_id
        self.locale = locale
        self.reason = reason
        where = f" ({locale})" if locale is not None else ""
        super().__init__(f'voice "{voice_id}" is not bound to a Locale{where}: {reason}')


class VoiceBindingConflictError(ValueError):
    """The table itself claimed one voice for more than one Locale."""

    def __init__(self, voice_id: str, first: Locale, second: Locale) -> None:
        self.voice_id = voice_id
        self.locales = (first, second)
        if first == second:
            detail = f"claimed twice for {first}"
        else:
            detail = f"claimed for two Locales: {first} and {second}"
        super().__init__(f'voice "{voice_id}" is {detail}; a voice speaks exactly one Locale')


class LanguageOverrideError(ValueError):
    """A request field tried to set a language other than the voice's Locale."""

    def __init__(self, voice_id: str, binding: VoiceBinding, requested_language: str) -> None:
        self.voice_id = voice_id
        self.binding = binding
        self.requested_language = requested_language
        super().__init__(
            f'voice "{voice_id}" is bound to {binding.locale}; '
            f'the request language "{requested_language}" cannot override the binding'
        )


@dataclass(frozen=True)
class Locale:
    """One spoken language: our code plus the vendor's language name."""

    code: str
    language: str

    def __post_init__(self) -> None:
        expected = SPEECH_LANGUAGES.get(self.code)
        if expected is None:
            known = ", ".join(sorted(SPEECH_LANGUAGES))
            raise ValueError(f'unknown Locale code "{self.code}": the catalogue speaks {known}')
        if self.language != expected:
            raise ValueError(
                f'Locale "{self.code}" speaks "{expected}" at the vendor, not "{self.language}"'
            )

    def __str__(self) -> str:
        return f"{self.code} ({self.language})"


@dataclass(frozen=True)
class VoiceBinding:
    """A voice and the one Locale it speaks."""

    voice_id: str
    locale: Locale

    @property
    def language(self) -> str:
        """The vendor's language name — the value a synthesis request sends."""
        return self.locale.language

    @property
    def vendor_voice_id(self) -> str:
        """The vendor's library id for this catalogue voice (`aai-jorg`)."""
        return vendor_voice_id(self.voice_id)


@dataclass(frozen=True)
class UnboundVoice:
    """A voice with no binding; kept visible, never silently dropped.

    ``historical`` marks an id the catalogue no longer offers (the pre-re-cast
    German ``juergen``). It is still refused by name with its 422 reason, so a
    request that names it cannot fall through to another voice or Locale.
    """

    voice_id: str
    locale: Locale
    reason: str
    historical: bool = False


LOCALES: Mapping[str, Locale] = MappingProxyType(
    {code: Locale(code, language) for code, language in SPEECH_LANGUAGES.items()}
)


def build_bindings(declarations: Iterable[VoiceBinding]) -> dict[str, VoiceBinding]:
    """Build a ``voice_id -> binding`` table, refusing any double claim by name."""
    table: dict[str, VoiceBinding] = {}
    for binding in declarations:
        existing = table.get(binding.voice_id)
        if existing is not None:
            raise VoiceBindingConflictError(binding.voice_id, existing.locale, binding.locale)
        table[binding.voice_id] = binding
    return table


# The catalogue's offered voices, each bound to the Locale its languageCode
# declares. Every serving voice is bound here, German included since the
# re-cast to `jorg` (ticket 130).
_CATALOGUE: tuple[VoiceBinding, ...] = (
    VoiceBinding("alba", LOCALES["en"]),
    VoiceBinding("eve", LOCALES["en"]),
    VoiceBinding("jane", LOCALES["en"]),
    VoiceBinding("mary", LOCALES["en"]),
    VoiceBinding("george", LOCALES["en"]),
    VoiceBinding("michael", LOCALES["en"]),
    VoiceBinding("jean", LOCALES["en"]),
    VoiceBinding("anna", LOCALES["en"]),
    VoiceBinding("vera", LOCALES["en"]),
    VoiceBinding("charles", LOCALES["en"]),
    VoiceBinding("paul", LOCALES["en"]),
    VoiceBinding("giovanni", LOCALES["it"]),
    VoiceBinding("lola", LOCALES["es"]),
    VoiceBinding("jorg", LOCALES["de"]),
    VoiceBinding("rafael", LOCALES["pt"]),
    VoiceBinding("estelle", LOCALES["fr"]),
)

BINDINGS: Mapping[str, VoiceBinding] = MappingProxyType(build_bindings(_CATALOGUE))

UNBOUND_VOICES: Mapping[str, UnboundVoice] = MappingProxyType(
    {
        "juergen": UnboundVoice(
            voice_id="juergen",
            locale=LOCALES["de"],
            reason=(
                "vendor /v1/speech returned 422 voice_not_found; historical id, "
                "replaced by jorg (ticket 130)"
            ),
            historical=True,
        )
    }
)


def bind_voice(voice_id: str, *, requested_language: str | None = None) -> VoiceBinding:
    """Return the voice's binding, or refuse by name.

    ``requested_language`` is a single synthesis-language field on a request, and
    it is not an authority: it may agree with the binding (our code or the
    vendor's language name) and is otherwise refused. The table decides the
    synthesis language; a caller never does.

    The body's ``input.language_codes`` is the *STT bias list*, not this field:
    it may carry the voice's Locale plus another language (spec: TTS stays the
    voice's own Locale), so the body adapter must never pass it here.
    """
    binding = BINDINGS.get(voice_id)
    if binding is None:
        unbound = UNBOUND_VOICES.get(voice_id)
        if unbound is not None:
            raise UnboundVoiceError(voice_id, unbound.locale, unbound.reason)
        raise UnknownVoiceError(voice_id)

    requested = (requested_language or "").strip()
    if requested and requested not in (binding.locale.code, binding.locale.language):
        raise LanguageOverrideError(voice_id, binding, requested)
    return binding


def is_cascade_subject(voice_id: str) -> bool:
    """Whether the voice has a binding, i.e. may be a cascade subject at all."""
    return voice_id in BINDINGS
