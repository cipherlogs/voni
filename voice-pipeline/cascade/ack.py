"""Short spoken acknowledgements that cover the model's first-token wait.

The demo's Meta turn measures p50 ~2 s to its first token. A listener reads that
silence as a broken line, so the cascade speaks one very short line through the
same voice at the registry's delay. It is not the reply:

* it is never captioned and never enters the reply text or history;
* it is skipped when the reply starts speaking first;
* it carries no model request and no tool call.

The table is per Locale because the demo roster is one voice per Locale. "Mhm."
is deliberately shared: it is a listening sound, not an English word.
"""

from __future__ import annotations

from collections.abc import Mapping

#: One to three short listening sounds per Locale. Lowercase is not used;
#: these are spoken verbatim, so each keeps its own punctuation and accents.
ACK_LINES: Mapping[str, tuple[str, ...]] = {
    "en": ("Mhm.", "Right.", "Got it."),
    "de": ("Mhm.", "Alles klar.", "Okay."),
    "es": ("Mhm.", "Vale.", "Claro."),
    "fr": ("Mhm.", "D'accord.", "Très bien."),
    "pt": ("Mhm.", "Certo.", "Tá."),
}


def ack_lines(locale: str | None) -> tuple[str, ...]:
    """The lines for one Locale; an unknown Locale gets no acknowledgement.

    The demo roster is five Locales; a tenant or an unexpected code must not
    hear an English filler, so the fallback is silence rather than English.
    """
    return ACK_LINES.get((locale or "").lower(), ())
