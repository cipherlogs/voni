"""Tests for the Standard-only Meta model guard.

The privacy premise: Contributor tier trains Meta models on request content,
and a cascade request carries a caller's name, budget, financing and phone
number. A Contributor id must never reach a request builder, so the guard runs
when the backend is constructed.
"""

import unittest

from cascade.model_guard import (
    DEFAULT_MODEL,
    STANDARD_MODELS,
    ModelGuardError,
    assert_standard_model,
    resolve_model,
)


class ContributorMarkerTests(unittest.TestCase):
    def test_rejects_contributor_id_at_construction_entry(self):
        with self.assertRaises(ModelGuardError) as caught:
            resolve_model("muse-spark-1.3-contributor")
        message = str(caught.exception)
        self.assertIn("muse-spark-1.3-contributor", message)
        self.assertIn("Contributor", message)

    def test_rejects_marker_before_request_is_built(self):
        """The documented construction order: resolve first, build after."""
        built = []

        class RecordingBackend:
            def __init__(self, model_id):
                self.model = resolve_model(model_id)
                built.append(self._build_request())

            def _build_request(self):
                return {"model": self.model, "stream": True}

        with self.assertRaises(ModelGuardError):
            RecordingBackend("muse-spark-1.3-contributor")
        self.assertEqual(built, [])

        backend = RecordingBackend(None)
        self.assertEqual(built, [{"model": DEFAULT_MODEL, "stream": True}])

    def test_marker_check_is_case_insensitive(self):
        with self.assertRaises(ModelGuardError) as caught:
            resolve_model("MUSE-SPARK-1.3-CONTRIBUTOR")
        message = str(caught.exception)
        self.assertIn("MUSE-SPARK-1.3-CONTRIBUTOR", message)
        self.assertIn("Contributor", message)

    def test_marker_reason_names_the_privacy_cost(self):
        with self.assertRaises(ModelGuardError) as caught:
            assert_standard_model("muse-spark-1.3-contributor")
        message = str(caught.exception)
        self.assertIn("trains Meta models", message)
        self.assertIn("Standard", message)


class AllowlistTests(unittest.TestCase):
    def test_confirmed_standard_model_is_accepted(self):
        self.assertEqual(assert_standard_model("muse-spark-1.3"), "muse-spark-1.3")
        self.assertIn("muse-spark-1.3", STANDARD_MODELS)

    def test_unlisted_model_is_rejected_by_name(self):
        with self.assertRaises(ModelGuardError) as caught:
            assert_standard_model("muse-spark-2.0")
        message = str(caught.exception)
        self.assertIn("muse-spark-2.0", message)
        self.assertIn("muse-spark-1.3", message)
        self.assertIn("not a Standard model", message)

    def test_allowlist_contains_only_confirmed_ids(self):
        self.assertEqual(tuple(STANDARD_MODELS), ("muse-spark-1.3",))


class ResolveModelTests(unittest.TestCase):
    def test_default_is_the_confirmed_standard_model(self):
        self.assertEqual(DEFAULT_MODEL, "muse-spark-1.3")
        self.assertEqual(resolve_model(None), DEFAULT_MODEL)
        self.assertEqual(resolve_model(""), DEFAULT_MODEL)

    def test_explicit_standard_id_passes_through(self):
        self.assertEqual(resolve_model("muse-spark-1.3"), "muse-spark-1.3")

    def test_unlisted_id_raises_the_same_named_error(self):
        with self.assertRaises(ModelGuardError) as caught:
            resolve_model("gateway-gpt")
        self.assertIn("gateway-gpt", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
