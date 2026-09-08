import base64
import json
import unittest

from campaign_runner import CLIENT_STATE_LIMIT, decode_client_state, encode_client_state


class ClientStateTests(unittest.TestCase):
    """`client_state` is the only thing joining a Telnyx call to a campaign lead.

    If it does not survive the round trip, an outbound call is unattributable:
    the lead stays `dialing`, the queue blocks behind it, and the outcome is
    never recorded.
    """

    def test_round_trips_the_campaign_linkage(self):
        encoded = encode_client_state("lead-123", "campaign-456")
        self.assertEqual(
            decode_client_state(encoded),
            {"campaign_lead_id": "lead-123", "campaign_id": "campaign-456"},
        )

    def test_stays_inside_the_telnyx_size_limit_for_real_uuids(self):
        uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
        self.assertLessEqual(len(encode_client_state(uuid, uuid)), CLIENT_STATE_LIMIT)

    def test_decoding_junk_yields_no_linkage_rather_than_raising(self):
        # An inbound call has no client_state at all, and a webhook is not a
        # place to throw — every one of these must degrade to "not a campaign
        # dial" instead of taking down the handler.
        for value in [
            None,
            "",
            "not-base64!!",
            base64.b64encode(b"not json").decode(),
            base64.b64encode(json.dumps([1, 2, 3]).encode()).decode(),
        ]:
            self.assertEqual(decode_client_state(value), {}, f"input {value!r}")


class HangupOutcomeTests(unittest.TestCase):
    """The mapping that decides whether a lead is retried or retired."""

    def setUp(self):
        # Imported here because server.py requires PUBLIC_HOST at import time.
        import os

        os.environ.setdefault("PUBLIC_HOST", "test.invalid")
        from server import HANGUP_OUTCOMES

        self.outcomes = HANGUP_OUTCOMES

    def test_busy_and_no_answer_are_distinguished(self):
        self.assertEqual(self.outcomes["user_busy"], "busy")
        self.assertEqual(self.outcomes["timeout"], "no_answer")

    def test_normal_clearing_without_an_answer_is_not_a_reached_lead(self):
        # A declined call also ends in normal_clearing. Treating that as
        # "answered" would retire a lead nobody ever spoke to.
        self.assertEqual(self.outcomes["normal_clearing"], "no_answer")

    def test_an_unknown_cause_is_not_silently_a_no_answer(self):
        # `failed` is the fallback in report_campaign_outcome; it still consumes
        # an attempt but reads differently in the queue, which is the point.
        self.assertNotIn("some_new_telnyx_cause", self.outcomes)


if __name__ == "__main__":
    unittest.main()
