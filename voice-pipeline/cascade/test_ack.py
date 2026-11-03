"""The spoken acknowledgements must be words a voice can say, and must fit.

A listening sound written as letters ("Mhm.") is not a word: the vendor
synthesises each letter, so the caller hears "m-h-m". Acks are never captioned,
so the defect never appears in a transcript — only in the audio. The guard is
cheap and general: every line must contain a vowel, because a line without one
is a spelling rather than a word.

The English palette is also chosen by the caller's tone: the flat "Okay." that
acknowledges an address is tone-deaf after "this is ridiculous". These tests pin
the group boundaries and the no-repeat rule, not the exact rotation.
"""

from __future__ import annotations

import unittest

from cascade.ack import (
    ACK_LINES,
    ACK_TONE_GROUPS,
    NEGATIVE_CUES,
    ack_line,
    ack_lines,
    ack_tone,
)

VOWELS = set("aeiouyàâäéèêëîïôöùûüáíóúñãõåæø")

#: Listening sounds that are hummed rather than spelled. They are dictionary
#: interjections, not letter spellings, so the vowel guard — which exists to
#: catch a line the vendor would read as letters, like "Mhm." — exempts them by
#: name. "mhm" is deliberately absent.
HUMMED_WORDS = frozenset({"mm", "hmm"})

BRIGHT = ("Okay.", "Yeah.", "Uh-huh.")

BANNED = ("Right.", "Got it.", "Sure.")


class AckLinesTest(unittest.TestCase):
    def test_every_locale_has_at_least_two_lines(self) -> None:
        for locale, lines in ACK_LINES.items():
            self.assertGreaterEqual(len(lines), 2, locale)
            self.assertEqual(len(set(lines)), len(lines), f"{locale} repeats a line")

    def test_the_english_palette_has_at_least_eight_lines_and_no_banned_line(
        self,
    ) -> None:
        lines = ACK_LINES["en"]
        self.assertGreaterEqual(len(lines), 8)
        for line in BANNED:
            self.assertNotIn(line, lines, f"the palette still carries {line!r}")

    def test_every_line_is_a_word_a_voice_can_say(self) -> None:
        for locale, lines in ACK_LINES.items():
            for line in lines:
                normalized = line.strip(".!").lower()
                if normalized in HUMMED_WORDS:
                    continue
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


class AckToneTest(unittest.TestCase):
    def test_a_complaint_is_negative(self) -> None:
        for cue in NEGATIVE_CUES:
            self.assertEqual("negative", ack_tone(f"This is {cue}."), cue)

    def test_a_complaint_beats_a_question(self) -> None:
        self.assertEqual("negative", ack_tone("Is this broken?"))

    def test_a_question_is_a_question_with_or_without_the_mark(self) -> None:
        for text in (
            "What does it cost?",
            "Can you come tomorrow?",
            "how much is it",
            "Why did that happen",
        ):
            self.assertEqual("question", ack_tone(text), text)

    def test_an_empty_final_is_unknown(self) -> None:
        self.assertEqual("unknown", ack_tone(""))
        self.assertEqual("unknown", ack_tone("   "))

    def test_a_plain_statement_is_neutral(self) -> None:
        self.assertEqual("neutral", ack_tone("I'm calling about the flat."))


class AckSelectionTest(unittest.TestCase):
    def test_an_angry_final_never_gets_a_bright_acknowledgement(self) -> None:
        thinking = set(ACK_TONE_GROUPS["en"]["thinking"])
        sympathetic = set(ACK_TONE_GROUPS["en"]["sympathetic"])
        finals = [
            "This is ridiculous.",
            "The heating is broken.",
            "It is not working again.",
            "I am fed up with this.",
            "Honestly, this is useless.",
            "You are the worst.",
        ]
        for final in finals:
            for previous in (None, "Mm.", "Ah."):
                line = ack_line("en", final, previous=previous)
                self.assertNotIn(line, BRIGHT, final)
                self.assertIn(line, thinking | sympathetic, final)

    def test_a_question_gets_a_thinking_line(self) -> None:
        thinking = set(ACK_TONE_GROUPS["en"]["thinking"])
        for final in (
            "What does it cost?",
            "Can you come tomorrow?",
            "how much is it",
        ):
            for previous in (None, "Mm.", "Hmm."):
                self.assertIn(
                    ack_line("en", final, previous=previous), thinking, final
                )

    def test_a_neutral_final_can_get_okay(self) -> None:
        neutral = [
            "I'm calling about the flat.",
            "I live on the second floor.",
            "The appointment is for Tuesday.",
            "My name is Alex.",
            "I saw the listing online.",
            "You can reach me in the morning.",
            "It is a two bedroom flat.",
            "That address is correct.",
            "I'd like to book a viewing.",
        ]
        self.assertIn("Okay.", {ack_line("en", text) for text in neutral})

    def test_two_consecutive_turns_never_repeat_the_same_ack(self) -> None:
        finals = [
            "I'm calling about the flat.",
            "What does it cost?",
            "This is ridiculous.",
            "",
        ]
        for final in finals:
            first = ack_line("en", final)
            second = ack_line("en", final, previous=first)
            self.assertNotEqual(first, second, final)
            third = ack_line("en", final, previous=second)
            self.assertNotEqual(second, third, final)

    def test_the_choice_is_deterministic_for_one_final(self) -> None:
        first = ack_line("en", "What does it cost?", previous="So.")
        again = ack_line("en", "What does it cost?", previous="So.")
        self.assertEqual(first, again)

    def test_an_injected_palette_is_still_chosen_from(self) -> None:
        self.assertEqual("Mhm.", ack_line("en", "hello", lines=("Mhm.",)))
        self.assertIsNone(ack_line("en", "hello", lines=()))


if __name__ == "__main__":
    unittest.main()
