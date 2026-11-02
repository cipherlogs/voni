"""The spoken acknowledgements must be words a voice can say.

A listening sound written as letters ("Mhm.") is not one: the vendor
synthesises each letter, so the caller hears "m-h-m". Acks are never captioned,
so the defect never appears in a transcript — only in the audio. The guard is
cheap and general: every line must contain a vowel, because a line without one
is a spelling rather than a word.
"""

from __future__ import annotations

import unittest

from cascade.ack import ACK_LINES, ack_lines

VOWELS = set("aeiouyàâäéèêëîïôöùûüáíóúñãõåæø")


class AckLinesTest(unittest.TestCase):
    def test_every_locale_has_at_least_two_lines(self) -> None:
        for locale, lines in ACK_LINES.items():
            self.assertGreaterEqual(len(lines), 2, locale)
            self.assertEqual(len(set(lines)), len(lines), f"{locale} repeats a line")

    def test_every_line_is_a_word_a_voice_can_say(self) -> None:
        for locale, lines in ACK_LINES.items():
            for line in lines:
                letters = {character.lower() for character in line}
                self.assertTrue(
                    letters & VOWELS,
                    f"{locale} ack {line!r} contains no vowel: the vendor would "
                    "speak it as letters, not as a word",
                )

    def test_the_letter_spelling_is_gone(self) -> None:
        for locale, lines in ACK_LINES.items():
            for line in lines:
                self.assertNotEqual(
                    line.strip(".!").lower(),
                    "mhm",
                    f"{locale} still speaks the spelling the caller heard as m-h-m",
                )

    def test_an_unknown_locale_gets_silence(self) -> None:
        self.assertEqual(ack_lines(None), ())
        self.assertEqual(ack_lines(""), ())
        self.assertEqual(ack_lines("xx"), ())
        self.assertEqual(ack_lines("en"), ACK_LINES["en"])


if __name__ == "__main__":
    unittest.main()
