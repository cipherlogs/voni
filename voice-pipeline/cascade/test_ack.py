"""The spoken acknowledgements must be words a voice can say, and must fit.

A listening sound written as letters ("Mhm.") is not a word: the vendor
synthesises each letter, so the caller hears "m-h-m". Acks are never captioned,
so the defect never appears in a transcript — only in the audio. The guard is
cheap and general: every line must contain a vowel, because a line without one
is a spelling rather than a word.

The English palette is the owner-approved bounded set (ticket 04): tone groups
plus short statement covers. The fast judge picks tone-or-none; silence wins
on greetings, filler-only turns, and judge ``None``. A judge timeout fails open
to the deterministic tone hash. These tests pin the approved list, the
silence rules, the group boundaries, and the no-repeat rule — not the exact
rotation.
"""

from __future__ import annotations

import asyncio
import unittest

from cascade.ack import (
    ACK_LINES,
    ACK_TONE_GROUPS,
    NEGATIVE_CUES,
    ack_lines,
    ack_tone,
    cover_line,
    is_greeting_turn,
    resolve_cover_tone,
    resolve_cover_tone_sync,
    should_cover,
)

VOWELS = set("aeiouyàâäéèêëîïôöùûüáíóúñãõåæø")

#: Listening sounds that are hummed rather than spelled. They are dictionary
#: interjections, not letter spellings, so the vowel guard — which exists to
#: catch a line the vendor would read as letters, like "Mhm." — exempts them by
#: name. "mhm" is deliberately absent.
HUMMED_WORDS = frozenset({"mm", "hmm"})

BRIGHT = ("Okay.", "Yeah.", "Uh-huh.")

#: Bare sounds the owner vetoed: the "Hi -> Mm" feeling. None may ship in the
#: English palette. "Got it." was banned before ticket 04 and is now approved.
BANNED = ("Mm.", "Hmm.", "Mhm.", "Uh-huh.", "Mm-hmm.", "Right.", "Sure.")

#: The owner-approved bounded English set (ticket 04, approved as-is): 13 lines.
APPROVED_EN = (
    "Let's see.",
    "One moment.",
    "Let me think.",
    "Ah, I see.",
    "Sorry to hear that.",
    "Okay.",
    "Yeah.",
    "Got it.",
    "Oh.",
    "Oh, nice.",
    "Got it, one moment.",
    "Let me check that.",
    "Good question, one sec.",
)


class AckLinesTest(unittest.TestCase):
    def test_every_locale_has_at_least_two_lines(self) -> None:
        for locale, lines in ACK_LINES.items():
            self.assertGreaterEqual(len(lines), 2, locale)
            self.assertEqual(len(set(lines)), len(lines), f"{locale} repeats a line")

    def test_the_english_palette_is_the_approved_bounded_set(self) -> None:
        self.assertEqual(tuple(ACK_LINES["en"]), APPROVED_EN)

    def test_the_english_palette_carries_no_vetoed_sound(self) -> None:
        for line in BANNED:
            self.assertNotIn(line, ACK_LINES["en"], f"the palette still carries {line!r}")

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


class GreetingSilenceTest(unittest.TestCase):
    def test_a_bare_greeting_is_a_greeting_turn(self) -> None:
        for text in ("Hi", "hi", "Hello!", "hey", "Good morning", "good evening"):
            self.assertTrue(is_greeting_turn(text), text)

    def test_a_greeting_with_content_is_a_real_turn(self) -> None:
        for text in (
            "Hi, I'm calling about the flat.",
            "Hello, what does it cost?",
            "Hi there, is this available?",
        ):
            self.assertFalse(is_greeting_turn(text), text)

    def test_greeting_turns_are_never_covered(self) -> None:
        for text in ("Hi", "hello", "hey"):
            self.assertFalse(should_cover("en", text), text)

    def test_filler_only_turns_are_never_covered(self) -> None:
        for text in ("mm-hmm", "uh huh", "um", "er"):
            self.assertFalse(should_cover("en", text), text)

    def test_a_normal_turn_may_be_covered(self) -> None:
        self.assertTrue(should_cover("en", "I'm calling about the flat."))
        self.assertTrue(should_cover("en", "What does it cost?"))

    def test_a_locale_without_a_palette_is_silence(self) -> None:
        self.assertFalse(should_cover("xx", "What does it cost?"))
        self.assertFalse(should_cover(None, "What does it cost?"))


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
            for previous in (None, "Let's see.", "Ah, I see."):
                line = cover_line("en", final, previous=previous)
                self.assertNotIn(line, BRIGHT, final)
                self.assertIn(line, thinking | sympathetic, final)

    def test_a_question_gets_a_thinking_line_or_a_statement_bridge(self) -> None:
        allowed = set(ACK_TONE_GROUPS["en"]["thinking"]) | set(
            ACK_TONE_GROUPS["en"]["statement"]
        )
        for final in (
            "What does it cost?",
            "Can you come tomorrow?",
            "how much is it",
        ):
            for previous in (None, "Let's see.", "Got it, one moment."):
                self.assertIn(
                    cover_line("en", final, previous=previous), allowed, final
                )

    def test_a_neutral_final_can_get_okay(self) -> None:
        neutral = [
            "I'm calling about the flat.",
            "We met on Tuesday.",
            "The dog barks.",
            "Cars are fast.",
            "My name is Alex.",
            "I saw the listing online.",
            "You can reach me in the morning.",
            "It is a two bedroom flat.",
            "That address is correct.",
            "I'd like to book a viewing.",
        ]
        self.assertIn("Okay.", {cover_line("en", text) for text in neutral})

    def test_a_judge_silence_is_obeyed_not_overruled(self) -> None:
        self.assertIsNone(
            cover_line("en", "What does it cost?", previous=None, tone=None)
        )
        self.assertIsNone(
            cover_line("en", "I'm calling about the flat.", previous=None, tone=None)
        )

    def test_an_unknown_judge_tone_fails_open_to_the_hash(self) -> None:
        line = cover_line("en", "This is ridiculous.", tone="cheerful")
        thinking = set(ACK_TONE_GROUPS["en"]["thinking"])
        sympathetic = set(ACK_TONE_GROUPS["en"]["sympathetic"])
        self.assertIn(line, thinking | sympathetic)

    def test_two_consecutive_turns_never_repeat_the_same_ack(self) -> None:
        finals = [
            "I'm calling about the flat.",
            "What does it cost?",
            "This is ridiculous.",
            "",
        ]
        for final in finals:
            first = cover_line("en", final)
            second = cover_line("en", final, previous=first)
            self.assertNotEqual(first, second, final)
            third = cover_line("en", final, previous=second)
            self.assertNotEqual(second, third, final)

    def test_the_choice_is_deterministic_for_one_final(self) -> None:
        first = cover_line("en", "What does it cost?", previous="Let's see.")
        again = cover_line("en", "What does it cost?", previous="Let's see.")
        self.assertEqual(first, again)

    def test_an_injected_palette_is_still_chosen_from(self) -> None:
        self.assertEqual("Mhm.", cover_line("en", "hello", lines=("Mhm.",)))
        self.assertIsNone(cover_line("en", "hello", lines=()))


class JudgeContractTest(unittest.TestCase):
    def test_a_missing_judge_is_the_deterministic_hash(self) -> None:
        tone = asyncio.run(resolve_cover_tone("This is ridiculous.", None))
        self.assertEqual(tone, "negative")

    def test_a_judge_none_is_silence(self) -> None:
        async def silent(_: str) -> str | None:
            return None

        self.assertIsNone(asyncio.run(resolve_cover_tone("Hi there.", silent)))

    def test_a_slow_judge_fails_open_to_the_hash(self) -> None:
        async def slow(_: str) -> str | None:
            await asyncio.sleep(10)
            return "neutral"

        tone = asyncio.run(resolve_cover_tone("This is ridiculous.", slow, 0.01))
        self.assertEqual(tone, "negative")

    def test_a_throwing_judge_fails_open_to_the_hash(self) -> None:
        async def broken(_: str) -> str | None:
            raise RuntimeError("judge is down")

        tone = asyncio.run(resolve_cover_tone("What does it cost?", broken, 1.0))
        self.assertEqual(tone, "question")

    def test_an_unknown_judge_tone_fails_open_to_the_hash(self) -> None:
        async def weird(_: str) -> str | None:
            return "cheerful"

        tone = asyncio.run(resolve_cover_tone("What does it cost?", weird, 1.0))
        self.assertEqual(tone, "question")

    def test_the_sync_contract_matches(self) -> None:
        self.assertEqual(
            resolve_cover_tone_sync("What does it cost?", "neutral"), "neutral"
        )
        self.assertIsNone(resolve_cover_tone_sync("Hi.", None))
        self.assertEqual(
            resolve_cover_tone_sync("This is ridiculous.", "neutral", timed_out=True),
            "negative",
        )
        self.assertEqual(
            resolve_cover_tone_sync("What does it cost?", "boom", failed=True),
            "question",
        )


if __name__ == "__main__":
    unittest.main()
