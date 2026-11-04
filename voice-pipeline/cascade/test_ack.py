"""The spoken acknowledgements must be words a voice can say, and must fit.

A listening sound written as letters ("Mhm.") is not a word: the vendor
synthesises each letter, so the caller hears "m-h-m". The guard is cheap and
general: every line must contain a vowel, because a line without one is a
spelling rather than a word.

The English palette is the owner-approved bounded set (ticket 04): tone groups
plus short statement covers. Jev picks tone-or-None; silence wins on greetings,
filler-only turns, end-intent turns, and judge ``None``. A missing, slow,
failing, low-confidence, or unknown-tone judge is silence, never a hash
fallback (owner direction: Jev-only, no hash). The cover is captioned as an
agent final but never enters reply text or history. Neutral never includes the
statement bridge, so "Good question, one sec." only answers a real question.
These tests pin the approved list, the silence rules, the group boundaries,
the no-repeat rule, and the rotation: inside one tone the lines cycle in
palette order (the candidate after ``previous``, wrapping) so every line is
heard instead of alternating the first two.
"""

from __future__ import annotations

import asyncio
import sys
import unittest

# The cascade calls the bare ``end_intent`` seam (``from end_intent import``);
# that module lives at ``cascade.end_intent``. Alias it so the tests drive the
# same seam the implementation imports, without touching behavior files.
try:
    import end_intent  # noqa: F401
except ModuleNotFoundError:
    import cascade.end_intent as _cascade_end_intent

    sys.modules["end_intent"] = _cascade_end_intent

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

    def test_end_intent_turns_are_never_covered(self) -> None:
        for text in ("can you please hang up?", "bye", "that's all"):
            self.assertFalse(should_cover("en", text), text)


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
                line = cover_line("en", final, previous=previous, tone="negative")
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
                    cover_line("en", final, previous=previous, tone="question"),
                    allowed,
                    final,
                )

    def test_a_neutral_final_never_gets_the_statement_bridge(self) -> None:
        statement = set(ACK_TONE_GROUPS["en"]["statement"])
        for final in (
            "I'm calling about the flat.",
            "We met on Tuesday.",
            "The dog barks.",
            "My name is Alex.",
            "I'd like to book a viewing.",
        ):
            for previous in (None, "Okay.", "Let's see.", "Oh."):
                line = cover_line("en", final, previous=previous, tone="neutral")
                self.assertNotIn(line, statement, final)
                self.assertNotIn(
                    line,
                    ("Good question, one sec.", "Got it, one moment.", "Let me check that."),
                    final,
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
        self.assertIn(
            "Okay.", {cover_line("en", text, tone="neutral") for text in neutral}
        )

    def test_a_judge_silence_is_obeyed_not_overruled(self) -> None:
        self.assertIsNone(
            cover_line("en", "What does it cost?", previous=None, tone=None)
        )
        self.assertIsNone(
            cover_line("en", "I'm calling about the flat.", previous=None, tone=None)
        )

    def test_a_missing_judge_default_is_silence(self) -> None:
        self.assertIsNone(cover_line("en", "What does it cost?"))
        self.assertIsNone(
            cover_line("en", "I'm calling about the flat.", previous="Okay.")
        )

    def test_an_unknown_judge_tone_is_silence(self) -> None:
        self.assertIsNone(cover_line("en", "This is ridiculous.", tone="cheerful"))
        self.assertIsNone(cover_line("en", "What does it cost?", tone="boom"))
        self.assertIsNone(cover_line("en", "What does it cost?", tone=123))

    def test_two_consecutive_turns_never_repeat_the_same_ack(self) -> None:
        cases = [
            ("I'm calling about the flat.", "neutral"),
            ("What does it cost?", "question"),
            ("This is ridiculous.", "negative"),
            ("", "unknown"),
        ]
        for final, tone in cases:
            first = cover_line("en", final, tone=tone)
            second = cover_line("en", final, previous=first, tone=tone)
            self.assertNotEqual(first, second, final)
            third = cover_line("en", final, previous=second, tone=tone)
            self.assertNotEqual(second, third, final)

    def test_the_choice_is_deterministic_for_one_final(self) -> None:
        first = cover_line(
            "en", "What does it cost?", previous="Let's see.", tone="question"
        )
        again = cover_line(
            "en", "What does it cost?", previous="Let's see.", tone="question"
        )
        self.assertEqual(first, again)

    def test_rotation_cycles_through_every_line_in_a_tone(self) -> None:
        """Chained ``previous`` walks the whole tone instead of the first two."""
        expectations = {
            "question": list(ACK_TONE_GROUPS["en"]["thinking"])
            + list(ACK_TONE_GROUPS["en"]["statement"]),
            "negative": list(ACK_TONE_GROUPS["en"]["sympathetic"])
            + list(ACK_TONE_GROUPS["en"]["thinking"]),
            "neutral": list(ACK_TONE_GROUPS["en"]["acknowledging"])
            + list(ACK_TONE_GROUPS["en"]["thinking"])
            + list(ACK_TONE_GROUPS["en"]["surprise"]),
            "unknown": list(ACK_TONE_GROUPS["en"]["thinking"]),
        }
        finals = {
            "question": "What does it cost?",
            "negative": "This is ridiculous.",
            "neutral": "I'm calling about the flat.",
            "unknown": "Fine.",
        }
        for tone, full in expectations.items():
            seen: list[str] = []
            previous: str | None = None
            for _ in range(len(full)):
                line = cover_line("en", finals[tone], previous=previous, tone=tone)
                self.assertIsNotNone(line, tone)
                assert line is not None
                self.assertNotIn(line, seen, f"{tone} repeated before using all lines")
                seen.append(line)
                previous = line
            self.assertEqual(full, seen, f"{tone} did not walk palette order")
            wrapped = cover_line("en", finals[tone], previous=previous, tone=tone)
            self.assertEqual(full[0], wrapped, f"{tone} did not wrap")

    def test_a_previous_from_another_tone_starts_at_the_head(self) -> None:
        self.assertEqual(
            "Let's see.",
            cover_line("en", "What does it cost?", previous="Okay.", tone="question"),
        )
        self.assertEqual(
            "Okay.",
            cover_line(
                "en", "I'm calling about the flat.",
                previous="Good question, one sec.", tone="neutral",
            ),
        )

    def test_a_single_candidate_tone_repeats_only_when_it_must(self) -> None:
        only = cover_line("en", "hello", lines=("Let's see.",), tone="question")
        self.assertEqual("Let's see.", only)
        again = cover_line(
            "en", "hello", lines=("Let's see.",), previous="Let's see.",
            tone="question",
        )
        self.assertEqual("Let's see.", again, "no alternative means a repeat")

    def test_an_injected_palette_is_still_chosen_from_with_an_explicit_tone(
        self,
    ) -> None:
        self.assertEqual(
            "Okay.",
            cover_line("en", "hello", lines=("Okay.", "Yeah."), tone="neutral"),
        )
        self.assertEqual(
            "Let's see.",
            cover_line("en", "hello", lines=("Let's see.",), tone="question"),
        )
        self.assertIsNone(cover_line("en", "hello", lines=(), tone="neutral"))
        self.assertIsNone(
            cover_line("en", "hello", lines=("Okay.",), tone=None)
        )
        # A palette that shares nothing with the tone's groups is silence,
        # never a fallback to the raw palette.
        self.assertIsNone(
            cover_line("en", "hello", lines=("Mhm.",), tone="neutral")
        )


class JudgeContractTest(unittest.TestCase):
    def test_a_missing_judge_is_silence(self) -> None:
        self.assertIsNone(asyncio.run(resolve_cover_tone("This is ridiculous.", None)))

    def test_a_judge_none_is_silence(self) -> None:
        async def silent(_: str) -> str | None:
            return None

        self.assertIsNone(asyncio.run(resolve_cover_tone("Hi there.", silent)))

    def test_a_slow_judge_is_silence(self) -> None:
        async def slow(_: str) -> str | None:
            await asyncio.sleep(10)
            return "neutral"

        self.assertIsNone(
            asyncio.run(resolve_cover_tone("This is ridiculous.", slow, 0.01))
        )

    def test_a_throwing_judge_is_silence(self) -> None:
        async def broken(_: str) -> str | None:
            raise RuntimeError("judge is down")

        self.assertIsNone(
            asyncio.run(resolve_cover_tone("What does it cost?", broken, 1.0))
        )

    def test_an_unknown_judge_tone_is_silence(self) -> None:
        async def weird(_: str) -> str | None:
            return "cheerful"  # type: ignore[return-value]

        self.assertIsNone(
            asyncio.run(resolve_cover_tone("What does it cost?", weird, 1.0))
        )

    def test_the_sync_contract_matches(self) -> None:
        self.assertEqual(
            resolve_cover_tone_sync("What does it cost?", "neutral"), "neutral"
        )
        self.assertIsNone(resolve_cover_tone_sync("Hi.", None))
        self.assertIsNone(
            resolve_cover_tone_sync("This is ridiculous.", "neutral", timed_out=True)
        )
        self.assertIsNone(
            resolve_cover_tone_sync("What does it cost?", "boom", failed=True)
        )
        self.assertIsNone(resolve_cover_tone_sync("What does it cost?", "cheerful"))


if __name__ == "__main__":
    unittest.main()
