"""Tests for the cascade pipeline configuration.

Safety invariant: the managed path stays the default until the cascade beats
it on the scoreboard — a config must say so explicitly to route a call at the
new pipeline.
"""

import unittest

from config import (
    PipelineConfig,
    STT_PROVIDERS,
    TRANSPORTS,
    pipeline_config_from_dict,
)


class DefaultsTests(unittest.TestCase):
    def test_managed_fallback_is_default(self):
        config = PipelineConfig(llm_model="test-model")
        self.assertEqual(config.fallback_mode, "managed")
        self.assertEqual(config.stt_provider, "assemblyai")
        self.assertEqual(list(config.language_codes), ["en"])

    def test_browser_natural_endpointing_defaults(self):
        config = PipelineConfig(llm_model="test-model")
        self.assertEqual(config.min_silence_ms, 900)
        self.assertEqual(config.max_silence_ms, 1200)
        self.assertEqual(config.interruption_delay_ms, 350)


class ValidationTests(unittest.TestCase):
    def test_rejects_unknown_stt_provider(self):
        with self.assertRaises(ValueError):
            PipelineConfig(stt_provider="carrier_pigeon")  # type: ignore[arg-type]

    def test_rejects_unknown_transport(self):
        with self.assertRaises(ValueError):
            PipelineConfig(transport="smoke_signals")  # type: ignore[arg-type]

    def test_rejects_inverted_silence_window(self):
        with self.assertRaises(ValueError):
            PipelineConfig(min_silence_ms=1500, max_silence_ms=1200, llm_model="m")

    def test_rejects_empty_llm_model(self):
        with self.assertRaises(ValueError):
            PipelineConfig(llm_model="")

    def test_accepts_all_declared_providers_and_transports(self):
        for provider in STT_PROVIDERS:
            PipelineConfig(stt_provider=provider, llm_model="m")
        for transport in TRANSPORTS:
            PipelineConfig(transport=transport, llm_model="m")


class DictTests(unittest.TestCase):
    def test_from_dict_applies_overrides(self):
        config = pipeline_config_from_dict(
            {"stt_provider": "deepgram", "fallback_mode": "cascade", "llm_model": "m"}
        )
        self.assertEqual(config.stt_provider, "deepgram")
        self.assertEqual(config.fallback_mode, "cascade")
        # Untouched defaults survive.
        self.assertEqual(list(config.language_codes), ["en"])

    def test_from_dict_rejects_unknown_keys(self):
        with self.assertRaises(ValueError):
            pipeline_config_from_dict({"telepathy": True})

    def test_explicit_cascade_opt_in(self):
        config = pipeline_config_from_dict({"fallback_mode": "cascade", "llm_model": "m"})
        self.assertTrue(config.routes_to_cascade)

    def test_managed_default_does_not_route_to_cascade(self):
        self.assertFalse(PipelineConfig(llm_model="m").routes_to_cascade)


if __name__ == "__main__":
    unittest.main()
