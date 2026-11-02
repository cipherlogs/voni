"""Short spoken acknowledgements that cover the model's first-token wait.

The demo's Meta turn measures p50 ~2 s to its first token. A listener reads that
silence as a broken line, so the cascade speaks one very short line through the
same voice at the registry's delay. It is not the reply:

* it is never captioned and never enters the reply text or history;
* it is skipped when the reply starts speaking first;
* it carries no model request and no tool call.

The table is per Locale because the demo roster is one voice per Locale.

Every line is a real word in its Locale. A listening sound spelled as letters
("Mhm.") is not one: the vendor synthesises it as the letters m-h-m, which no
caller has ever said, and because acks are never captioned the defect is
invisible in every transcript. The first line of each Locale used to be "Mhm."
and is now a word.
"""

from __future__ import annotations

from collections.abc import Mapping

#: One to three short listening sounds per Locale. Lowercase is not used;
#: these are spoken verbatim, so each keeps its own punctuation and accents.
ACK_LINES: Mapping[str, tuple[str, ...]] = {
    "en": ("Right.", "Got it.", "Okay."),
    "de": ("Okay.", "Alles klar.", "Genau."),
    "es": ("Vale.", "Claro.", "De acuerdo."),
    "fr": ("D'accord.", "Très bien.", "Voilà."),
    "pt": ("Certo.", "Claro.", "Tá."),
}


def ack_lines(locale: str | None) -> tuple[str, ...]:
    """The lines for one Locale; an unknown Locale gets no acknowledgement.

    The demo roster is five Locales; a tenant or an unexpected code must not
    hear an English filler, so the fallback is silence rather than English.
    """
    return ACK_LINES.get((locale or "").lower(), ())
