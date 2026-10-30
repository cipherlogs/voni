"""No credential in any log (ticket 137).

Seam: :class:`cascade.log_redaction.RedactingFilter` for whatever a log call
site emits, and :func:`cascade.log_redaction.install_log_redaction` for the
service's own loggers. The rules are ticket 111's one sanitizer source
(``cascade.sanitizer``), not a second denylist: forbidden key names, the
key-shaped value pattern and the URL-userinfo rule all come from there.

The strongest test here opens the real Meta backend over a scripted socket and
scans every record it emitted: the handshake carries the vendor key inside its
body, so the credential must be absent from the logs even though the frame was
built and sent.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import unittest
from io import StringIO

from cascade.log_redaction import (
    HANDSHAKE_REDACTED,
    RedactingFilter,
    install_log_redaction,
    redact_text,
    redact_value,
)
from cascade.sanitizer import FORBIDDEN_EVENT_KEYS, KEY_SHAPED_VALUE, REDACTED
from cascade.testing.socket_factory import ScriptedSocketFactory

TOKEN = "ct1.c2VjcmV0LXBheWxvYWQ.c2lnbmF0dXJl"
VENDOR_KEY = "meta-vendor-key-137"
TOOL_SECRET = "tool-secret-137"
SIGNING_SECRET = "signing-secret-137"
DATABASE_URL = "postgres://cascade:hunter2@db.internal:5432/voni"
BEARER = f"Bearer {VENDOR_KEY}"

SECRETS = (VENDOR_KEY, TOOL_SECRET, SIGNING_SECRET, DATABASE_URL)


def capture(logger: logging.Logger) -> tuple[StringIO, logging.Handler]:
    stream = StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    return stream, handler


class QueryTokenTests(unittest.TestCase):
    def test_the_socket_query_token_is_redacted(self):
        logger = logging.getLogger("cascade.test.redaction.query")
        logger.filters.clear()
        logger.addFilter(RedactingFilter())
        stream, handler = capture(logger)
        try:
            logger.info(
                '%s - "GET %s HTTP/%s" %d',
                "127.0.0.1:5000",
                "/v1/browser-call?token=" + TOKEN + "&agentId=agent-1",
                "1.1",
                101,
            )
        finally:
            logger.removeHandler(handler)

        logged = stream.getvalue()
        self.assertNotIn(TOKEN, logged)
        self.assertIn(f"token={REDACTED}", logged)
        self.assertIn("agentId=agent-1", logged, "non-secret query data stays readable")

    def test_every_credential_query_name_is_redacted(self):
        for name in ("token", "callToken", "call_token", "access_token", "api_key", "secret", "signature"):
            with self.subTest(name=name):
                logged = redact_text(f"https://host/v1/browser-call?{name}={TOKEN}&x=1")
                self.assertNotIn(TOKEN, logged)
                self.assertIn(REDACTED, logged)


class FormatPlaceholderTests(unittest.TestCase):
    def test_a_lazy_format_placeholder_is_not_mistaken_for_a_credential(self):
        self.assertEqual(redact_text("api_key=%s"), "api_key=%s")
        self.assertEqual(redact_text("token=%(token)s"), "token=%(token)s")
        self.assertEqual(redact_text("api_key=supersecret"), f"api_key={REDACTED}")

    def test_a_lazy_argument_is_redacted_without_breaking_formatting(self):
        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(RedactingFilter([VENDOR_KEY]))
        logger = logging.getLogger("test.137.format")
        logger.handlers = [handler]
        logger.setLevel(logging.INFO)
        logger.propagate = False

        logger.info("api_key=%s", VENDOR_KEY)

        written = stream.getvalue()
        self.assertIn("api_key=", written)
        self.assertNotIn(VENDOR_KEY, written)


class HandshakeTests(unittest.TestCase):
    def handshake(self) -> dict:
        # The frame the Meta backend really sends: the credential is inside it.
        return {
            "authorization": {"accessToken": BEARER},
            "audioEncoding": "pcm_s16le",
            "model": "universal-3-6-pro",
            "mode": "balanced",
            "partialMode": "word",
            "emitAudioProgress": True,
            "keywords": ["Voni"],
        }

    def test_a_logged_config_frame_does_not_carry_the_token(self):
        frame = json.dumps(
            {
                "type": "config",
                "protocolVersion": 1,
                "agentId": "agent-1",
                "callToken": TOKEN,
            }
        )
        logged = redact_text(frame)
        self.assertNotIn(TOKEN, logged)
        self.assertRegex(logged, rf'"callToken"\s*:\s*"{re.escape(REDACTED)}"')
        self.assertIn('"agentId": "agent-1"', logged, "identity stays readable")

    def test_a_logged_handshake_body_never_appears(self):
        stream, handler = capture(logging.getLogger("cascade.test.redaction.handshake"))
        logger = logging.getLogger("cascade.test.redaction.handshake")
        logger.filters.clear()
        logger.addFilter(RedactingFilter(secrets=(VENDOR_KEY,)))
        try:
            logger.debug("meta speech session %s: handshake %s", "call-1", self.handshake())
            logger.debug("meta speech session %s: raw %s", "call-1", json.dumps(self.handshake()))
        finally:
            logger.removeHandler(handler)

        logged = stream.getvalue()
        self.assertIn(HANDSHAKE_REDACTED, logged)
        for forbidden in ("audioEncoding", "accessToken", VENDOR_KEY, BEARER):
            self.assertNotIn(forbidden, logged)

    def test_the_real_meta_open_path_logs_no_handshake(self):
        from cascade.meta_stt import MetaStreamingSTT

        logger = logging.getLogger("cascade")
        logger.filters.clear()
        logger.addFilter(RedactingFilter(secrets=(VENDOR_KEY,)))
        stream, handler = capture(logger)
        try:
            factory = ScriptedSocketFactory([json.dumps({"status": "ready"})])
            backend = MetaStreamingSTT(
                socket_factory=factory, api_key=VENDOR_KEY, call_id="call-137"
            )
            asyncio.run(backend.open(language_codes=[], sample_rate=24000))
        finally:
            logger.removeHandler(handler)

        # The handshake was built and sent: this test is not vacuous.
        sent = factory.socket.sent[0]
        self.assertIn(VENDOR_KEY, sent)
        logged = stream.getvalue()
        for forbidden in (VENDOR_KEY, "accessToken", "audioEncoding", BEARER):
            self.assertNotIn(forbidden, logged)

    def test_a_crash_dump_carrying_a_secret_is_redacted(self):
        logger = logging.getLogger("cascade.test.redaction.exc")
        logger.filters.clear()
        logger.addFilter(RedactingFilter(secrets=SECRETS))
        stream, handler = capture(logger)
        try:
            try:
                raise RuntimeError(f"connect failed for {DATABASE_URL} token={TOKEN}")
            except RuntimeError:
                logger.exception("meta connect failed")
        finally:
            logger.removeHandler(handler)

        logged = stream.getvalue()
        self.assertIn("meta connect failed", logged)
        self.assertNotIn("hunter2", logged)
        self.assertNotIn(DATABASE_URL, logged)
        self.assertNotIn(TOKEN, logged)
        self.assertIn(REDACTED, logged)


class SecretAbsenceTests(unittest.TestCase):
    def test_vendor_keys_tool_secret_signing_secret_and_database_url_are_absent(self):
        filter_ = RedactingFilter(secrets=SECRETS)
        for secret in SECRETS:
            with self.subTest(secret=secret.split(":")[0]):
                stream = StringIO()
                handler = logging.StreamHandler(stream)
                logger = logging.getLogger(f"cascade.test.redaction.secret.{secret[:4]}")
                logger.filters.clear()
                logger.addFilter(filter_)
                logger.addHandler(handler)
                logger.propagate = False
                try:
                    logger.error("using credential %s for the handshake", secret)
                    logger.error("context: %s", {"value": secret})
                finally:
                    logger.removeHandler(handler)
                self.assertNotIn(secret, stream.getvalue())

    def test_authorization_headers_are_redacted(self):
        logged = redact_value(
            {"authorization": BEARER, "headers": {"Authorization": BEARER}, "status": 200}
        )
        text = json.dumps(logged)
        self.assertNotIn(VENDOR_KEY, text)
        self.assertNotIn("Bearer", text)
        self.assertEqual(logged["status"], 200)

    def test_the_filter_reuses_the_one_sanitizer_rule_source(self):
        mapped = redact_value({"token": TOKEN, "audio": "bytes", "ok": 1})
        self.assertNotIn("token", mapped)
        self.assertNotIn("audio", mapped)
        self.assertEqual(mapped["ok"], 1)
        # The same forbidden-key set and key-shaped marker as the one source.
        self.assertIn("token", FORBIDDEN_EVENT_KEYS)
        self.assertIn(REDACTED, KEY_SHAPED_VALUE.sub(REDACTED, "sk_" + "a" * 12))


class InstallationTests(unittest.TestCase):
    def test_the_service_installs_the_filter_on_uvicorn_and_root_handlers(self):
        from server import create_app

        create_app(envelope_secret="", clock=lambda: 1.0)

        access = logging.getLogger("uvicorn.access")
        self.assertTrue(any(isinstance(f, RedactingFilter) for f in access.filters))
        root = logging.getLogger()
        self.assertTrue(
            any(isinstance(f, RedactingFilter) for f in root.filters)
            or any(
                isinstance(f, RedactingFilter)
                for handler in root.handlers
                for f in handler.filters
            ),
            "a record from any logger must reach a redacting filter",
        )

    def test_installation_reads_the_secret_values_from_the_environment(self):
        filter_ = install_log_redaction(environ={"META_API_KEY": VENDOR_KEY})
        self.assertIn(REDACTED, filter_.redact(f"handshake {VENDOR_KEY}"))


if __name__ == "__main__":
    unittest.main()
