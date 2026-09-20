import base64
import json
import unittest

from campaign_runner import (
    CLIENT_STATE_LIMIT,
    build_dial_payload,
    decode_client_state,
    encode_client_state,
    normalize_public_host,
    telnyx_stream_params,
)


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


class DialPayloadTests(unittest.TestCase):
    """The Telnyx dial payload is built in three places with one codec split.

    Inbound answers declare PCMU (Telnyx's default, what every observed
    inbound call negotiated); outbound dials declare PCMA (what showed up on
    outbound PSTN legs). The helper must preserve that split via a parameter
    instead of hard-coding, or calls transcode needlessly.
    """

    def test_stream_params_carry_the_bidirectional_contract(self):
        params = telnyx_stream_params("abc-123.trycloudflare.com", "PCMA")
        self.assertEqual(
            params,
            {
                "stream_url": "wss://abc-123.trycloudflare.com/media-stream",
                "stream_track": "inbound_track",
                "stream_bidirectional_mode": "rtp",
                "stream_bidirectional_codec": "PCMA",
            },
        )

    def test_stream_params_preserve_the_inbound_codec(self):
        params = telnyx_stream_params("abc-123.trycloudflare.com", "PCMU")
        self.assertEqual(params["stream_bidirectional_codec"], "PCMU")

    def test_dial_payload_packs_linkage_without_truncation(self):
        payload = build_dial_payload(
            connection_id="conn-1",
            to="+447512345678",
            from_number="+15551234567",
            public_host="abc-123.trycloudflare.com",
            codec="PCMA",
            campaign_lead_id="lead-123",
            campaign_id="campaign-456",
        )
        self.assertEqual(payload["connection_id"], "conn-1")
        self.assertEqual(payload["to"], "+447512345678")
        self.assertEqual(payload["stream_bidirectional_codec"], "PCMA")
        self.assertEqual(
            decode_client_state(payload["client_state"]),
            {"campaign_lead_id": "lead-123", "campaign_id": "campaign-456"},
        )

    def test_public_host_rejects_scheme_and_path(self):
        for bad in ["", "abc/x", "https://abc/x"]:
            with self.assertRaises(SystemExit, msg=f"input {bad!r}"):
                normalize_public_host(bad)
        self.assertEqual(
            normalize_public_host("https://abc-123.trycloudflare.com"),
            "abc-123.trycloudflare.com",
        )


if __name__ == "__main__":
    unittest.main()
